import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/authz";
import { badRequest, forbidden, notFound, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { attachProfiles } from "@/lib/profiles";
import { recordAudit } from "@/lib/audit";

const addSchema = z.object({ userId: z.string().uuid() });

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data, error } = await supabase
    .from("conversation_members")
    .select("conversation_id, user_id, joined_at, last_read_at")
    .eq("conversation_id", id);
  if (error) return badRequest(error.message);
  return NextResponse.json({ members: await attachProfiles(supabase, data ?? [], "user_id") });
}

/** Adds a member. RLS only permits the conversation creator, so a rejected write means forbidden. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = addSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("A valid user is required.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limited = rateLimit(`conversation:member:${user.id}`, 30, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const { data: conversation } = await supabase
    .from("conversations")
    .select("id, team_id, title, created_by")
    .eq("id", id)
    .maybeSingle();
  if (!conversation) return notFound("Conversation not found.");
  if (conversation.created_by !== user.id) return forbidden("Only the conversation creator can add members.");

  // The invitee must already belong to the same team: team_members is RLS-scoped to the caller's teams.
  const { data: invitee } = await supabase
    .from("team_members")
    .select("user_id")
    .eq("team_id", conversation.team_id)
    .eq("user_id", parsed.data.userId)
    .maybeSingle();
  if (!invitee) return badRequest("That person is not a member of this team.");

  const { data, error } = await supabase
    .from("conversation_members")
    .upsert({ conversation_id: id, user_id: parsed.data.userId }, { onConflict: "conversation_id,user_id" })
    .select("conversation_id, user_id, joined_at");
  if (error) return badRequest(error.message);

  await recordAudit({ actorId: user.id, teamId: conversation.team_id, action: "conversation.member_added", resourceType: "conversation", resourceId: id, metadata: { userId: parsed.data.userId } });
  return NextResponse.json({ member: data?.[0] ?? null }, { status: 201 });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const userId = new URL(request.url).searchParams.get("userId");
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) return badRequest("A user id is required.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data: conversation } = await supabase.from("conversations").select("id, team_id, created_by").eq("id", id).maybeSingle();
  if (!conversation) return notFound("Conversation not found.");
  if (conversation.created_by !== user.id) return forbidden("Only the conversation creator can remove members.");
  if (userId === user.id) return badRequest("You cannot remove yourself from a conversation.");

  const { data, error } = await supabase
    .from("conversation_members")
    .delete()
    .eq("conversation_id", id)
    .eq("user_id", userId)
    .select("user_id");
  if (error) return badRequest(error.message);
  if (!data || data.length === 0) return notFound("Member not found.");

  await recordAudit({ actorId: user.id, teamId: conversation.team_id, action: "conversation.member_removed", resourceType: "conversation", resourceId: id, metadata: { userId } });
  return NextResponse.json({ ok: true });
}
