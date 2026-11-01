import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { sendInvitationEmailWithPreference } from "@/lib/notify";
import type { EmailOutcome } from "@/lib/email";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { recordAudit } from "@/lib/audit";
import { getPublicAppUrl } from "@/lib/app-url";

/** Maps an email address to an existing auth user id, if any (server-only). */
async function lookupRecipientId(email: string): Promise<string | null> {
  try {
    const { data, error } = await createAdminClient().rpc("user_id_by_email", { p_email: email });
    if (error) return null;
    return (data as string | null) ?? null;
  } catch {
    return null;
  }
}

const invitationSchema = z.object({
  teamId: z.string().uuid(),
  email: z.string().trim().email().max(320),
  role: z.enum(["supervisor", "leader", "member", "reviewer"]),
});

/** Lists invitations for a team so owners can track pending invites. */
export async function GET(request: Request) {
  const teamId = new URL(request.url).searchParams.get("teamId");
  if (!z.string().uuid().safeParse(teamId).success) return NextResponse.json({ error: "A valid team is required." }, { status: 400 });

  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const { data, error } = await supabase
    .from("invitations")
    .select("id, team_id, invitee_email, role, status, expires_at, created_at, accepted_at")
    .eq("team_id", teamId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ invitations: data ?? [] });
}

export async function POST(request: Request) {
  const parsed = invitationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid invitation details." }, { status: 400 });

  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const limited = rateLimit(`invitation:create:${authData.user.id}`, 10, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const { data: membership } = await supabase.from("team_members").select("role").eq("team_id", parsed.data.teamId).eq("user_id", authData.user.id).maybeSingle();
  if (!membership || !["owner", "leader"].includes(membership.role)) return NextResponse.json({ error: "You cannot invite members to this team." }, { status: 403 });
  const { data: team } = await supabase.from("teams").select("name").eq("id", parsed.data.teamId).single();
  const { data: inviterProfile } = await supabase.from("profiles").select("full_name").eq("id", authData.user.id).maybeSingle();
  const inviterName =
    inviterProfile?.full_name?.trim() || authData.user.user_metadata?.full_name || authData.user.email?.split("@")[0] || null;

  // If the address already belongs to a user, their stored preferences apply.
  const recipientId = await lookupRecipientId(parsed.data.email);

  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 72).toISOString();
  const { data, error } = await supabase.from("invitations").insert({ team_id: parsed.data.teamId, inviter_id: authData.user.id, invitee_email: parsed.data.email.toLowerCase(), role: parsed.data.role, token_hash: tokenHash, expires_at: expiresAt }).select("id, team_id, invitee_email, role, expires_at").single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  await recordAudit({ actorId: authData.user.id, teamId: parsed.data.teamId, action: "invitation.created", resourceType: "invitation", resourceId: data.id, metadata: { email: parsed.data.email, role: parsed.data.role } });
  const origin = getPublicAppUrl(request);
  const inviteUrl = `${origin}/invite/${token}`;
  let emailSent = false;
  let emailCause: EmailOutcome["cause"];
  let emailReason: string | undefined;
  try {
    // Honours the recipient's stored email_invitations preference when known.
    const outcome = await sendInvitationEmailWithPreference({
      to: parsed.data.email,
      teamName: team?.name ?? "a Collabry team",
      inviteUrl,
      role: parsed.data.role,
      userId: recipientId,
      inviterName,
      inviterEmail: authData.user.email ?? null,
    });
    emailSent = outcome.sent;
    emailCause = outcome.cause;
    emailReason = outcome.reason;
    if (!outcome.sent && emailCause === "provider") console.error("[email] invitation delivery failed:", outcome.reason);
    if (!outcome.sent && emailCause === "not-configured") console.error("[email] invitation email not configured on this deployment");
  } catch (error) {
    emailSent = false;
    emailCause = "provider";
    emailReason = error instanceof Error ? error.message : "The email provider did not accept the message.";
    console.error("[email] invitation delivery failed:", emailReason);
  }
  return NextResponse.json({ invitation: data, inviteUrl, emailSent, emailCause, emailReason }, { status: 201 });
}
