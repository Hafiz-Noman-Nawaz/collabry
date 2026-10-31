import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit, requestOrigin, tooManyRequests } from "@/lib/rate-limit";

const tokenSchema = z.object({ token: z.string().min(20).max(200) });

export async function POST(request: Request) {
  const originLimited = rateLimit(`invite:accept:ip:${requestOrigin(request)}`, 30, 60_000);
  if (!originLimited.ok) return tooManyRequests(originLimited.retryAfterSeconds);

  const parsed = tokenSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid invitation token." }, { status: 400 });

  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Sign in before accepting this invitation." }, { status: 401 });

  const userLimited = rateLimit(`invite:accept:${authData.user.id}`, 10, 60_000);
  if (!userLimited.ok) return tooManyRequests(userLimited.retryAfterSeconds);

  const tokenHash = createHash("sha256").update(parsed.data.token).digest("hex");
  const admin = createAdminClient();
  const { data: invite, error: lookupErr } = await admin
    .from("invitations")
    .select("id, status, expires_at, invitee_email, invitee_id")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (lookupErr || !invite) return NextResponse.json({ error: "Invitation is unavailable or expired." }, { status: 400 });
  if (invite.status !== "pending") return NextResponse.json({ error: "This invitation has already been used or revoked." }, { status: 400 });
  if (new Date(invite.expires_at).getTime() <= Date.now()) return NextResponse.json({ error: "This invitation has expired." }, { status: 400 });

  // Recipient check
  const userEmail = authData.user.email?.toLowerCase();
  if (invite.invitee_id && invite.invitee_id !== authData.user.id) {
    return NextResponse.json({ error: "Invitation recipient mismatch." }, { status: 403 });
  }
  if (!invite.invitee_id && invite.invitee_email && invite.invitee_email.toLowerCase() !== userEmail) {
    return NextResponse.json({ error: "Invitation recipient mismatch." }, { status: 403 });
  }

  // Accept via server-verified accept_invitation RPC
  const { data, error } = await supabase.rpc("accept_invitation", { invitation_id: invite.id });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ membership: data });
}
