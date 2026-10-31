import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/authz";
import { badRequest, unauthorized } from "@/lib/api";
import { attachProfiles } from "@/lib/profiles";
import { recordAudit } from "@/lib/audit";

const removeSchema = z.object({ teamId: z.string().uuid(), userId: z.string().uuid() });
const roleSchema = z.object({ teamId: z.string().uuid(), userId: z.string().uuid(), role: z.enum(["supervisor", "leader", "member", "reviewer"]) });

export async function GET(request: Request) {
  const teamId = new URL(request.url).searchParams.get("teamId");
  if (!z.string().uuid().safeParse(teamId).success) return NextResponse.json({ error: "A valid team is required." }, { status: 400 });

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data, error } = await supabase
    .from("team_members")
    .select("team_id, user_id, role, joined_at")
    .eq("team_id", teamId)
    .order("joined_at", { ascending: true });
  if (error) return badRequest(error.message);
  // Profiles are merged separately: PostgREST cannot embed them via user_id.
  const members = await attachProfiles(supabase, data ?? [], "user_id");
  return NextResponse.json({ members });
}

export async function DELETE(request: Request) {
  const parsed = removeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid member details." }, { status: 400 });

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();
  if (user.id === parsed.data.userId) return NextResponse.json({ error: "Owners cannot remove themselves." }, { status: 400 });

  const { data, error } = await supabase
    .from("team_members")
    .delete()
    .eq("team_id", parsed.data.teamId)
    .eq("user_id", parsed.data.userId)
    .select("user_id");
  if (error) return badRequest(error.message);
  // Empty result means RLS rejected the removal: the caller is not owner/leader.
  if (!data || data.length === 0) return NextResponse.json({ error: "You cannot remove members from this team." }, { status: 403 });
  await recordAudit({
    actorId: user.id,
    teamId: parsed.data.teamId,
    action: "member.removed",
    resourceType: "team_member",
    resourceId: parsed.data.userId,
  });
  return NextResponse.json({ ok: true });
}

/** Changes a member's role. RLS restricts this to owners and leaders. */
export async function PATCH(request: Request) {
  const parsed = roleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid role details." }, { status: 400 });

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data: current } = await supabase
    .from("team_members")
    .select("role")
    .eq("team_id", parsed.data.teamId)
    .eq("user_id", parsed.data.userId)
    .maybeSingle();
  if (!current) return NextResponse.json({ error: "Member not found." }, { status: 404 });
  if (parsed.data.teamId && current.role === "owner") {
    return NextResponse.json({ error: "The project owner's role cannot be changed." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("team_members")
    .update({ role: parsed.data.role })
    .eq("team_id", parsed.data.teamId)
    .eq("user_id", parsed.data.userId)
    .select("team_id, user_id, role");
  if (error) return badRequest(error.message);
  if (!data || data.length === 0) return NextResponse.json({ error: "You cannot change roles in this team." }, { status: 403 });

  await recordAudit({
    actorId: user.id,
    teamId: parsed.data.teamId,
    action: "member.role_changed",
    resourceType: "team_member",
    resourceId: parsed.data.userId,
    metadata: { from: current.role, to: parsed.data.role },
  });
  return NextResponse.json({ member: data[0] });
}
