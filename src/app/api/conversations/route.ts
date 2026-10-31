import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/authz";
import { badRequest, parseUuid, queryInt, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

const conversationSchema = z.object({
  teamId: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
  isGroup: z.boolean().default(true),
  memberIds: z.array(z.string().uuid()).max(60).default([]),
});

const CONVERSATION_SELECT =
  "id, team_id, title, is_group, created_by, created_at, conversation_members(user_id, last_read_at), messages(body, sender_id, created_at)";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const teamId = parseUuid(url.searchParams.get("teamId"));
  if (!teamId) return badRequest("A valid team is required.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limit = queryInt(url, "limit", 50, 100);
  const offset = queryInt(url, "offset", 0, 2000);

  const { data, error, count } = await supabase
    .from("conversations")
    .select(CONVERSATION_SELECT, { count: "exact" })
    .eq("team_id", teamId)
    .order("created_at", { ascending: false })
    .order("created_at", { ascending: false, foreignTable: "messages" })
    .limit(1, { foreignTable: "messages" })
    .range(offset, offset + limit - 1);
  if (error) return badRequest(error.message);

  return NextResponse.json({ conversations: data ?? [], total: count ?? 0 });
}

export async function POST(request: Request) {
  const parsed = conversationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid conversation details.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limited = rateLimit(`conversation:create:${user.id}`, 20, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const { data: conversation, error } = await supabase
    .from("conversations")
    .insert({
      team_id: parsed.data.teamId,
      title: parsed.data.title,
      is_group: parsed.data.isGroup,
      created_by: user.id,
    })
    .select("id, team_id, title, is_group, created_by, created_at")
    .single();
  if (error) return badRequest(error.message);

  const requestedMembers = Array.from(new Set([user.id, ...parsed.data.memberIds]));
  const { data: teamMemberRows, error: teamMemberError } = await supabase
    .from("team_members")
    .select("user_id")
    .eq("team_id", parsed.data.teamId);
  if (teamMemberError) return badRequest(teamMemberError.message);
  const teamMemberSet = new Set((teamMemberRows ?? []).map((row) => row.user_id as string));
  const memberIds = requestedMembers.filter((userId) => userId === user.id || teamMemberSet.has(userId));
  if (memberIds.length !== requestedMembers.length) return badRequest("Conversation members must belong to this project.");

  const { error: memberError } = await supabase
    .from("conversation_members")
    .insert(memberIds.map((userId) => ({ conversation_id: conversation.id, user_id: userId })));
  if (memberError) return badRequest(memberError.message);

  return NextResponse.json({ conversation }, { status: 201 });
}
