import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser, getMembership, hasRole, MANAGER_ROLES } from "@/lib/authz";
import { badRequest, forbidden, parseUuid, queryInt, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { recordAudit } from "@/lib/audit";
import { notifyTeam, teamMemberIds } from "@/lib/notify";
import { attachProfiles } from "@/lib/profiles";

const createSchema = z.object({
  teamId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10000),
});

const ANNOUNCEMENT_SELECT = "id, team_id, author_id, title, body, created_at, updated_at";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const teamId = parseUuid(url.searchParams.get("teamId"));
  if (!teamId) return badRequest("A valid team is required.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limit = queryInt(url, "limit", 30, 100);
  const offset = queryInt(url, "offset", 0, 2000);

  const { data, error, count } = await supabase
    .from("announcements")
    .select(ANNOUNCEMENT_SELECT, { count: "exact" })
    .eq("team_id", teamId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return badRequest(error.message);
  return NextResponse.json({ announcements: await attachProfiles(supabase, data ?? [], "author_id"), total: count ?? 0 });
}

export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid announcement.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limited = rateLimit(`announcement:create:${user.id}`, 20, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const membership = await getMembership(supabase, parsed.data.teamId, user.id);
  if (!hasRole(membership?.role, MANAGER_ROLES)) return forbidden("Only team managers can post announcements.");

  const { data, error } = await supabase
    .from("announcements")
    .insert({ team_id: parsed.data.teamId, author_id: user.id, title: parsed.data.title, body: parsed.data.body })
    .select(ANNOUNCEMENT_SELECT)
    .single();
  if (error) return badRequest(error.message);

  const members = (await teamMemberIds(parsed.data.teamId)).filter((id) => id !== user.id);
  if (members.length > 0) {
    await notifyTeam({
      userIds: members,
      teamId: parsed.data.teamId,
      kind: "announcement",
      title: parsed.data.title,
      body: parsed.data.body.slice(0, 160),
      resourceType: "announcement",
      resourceId: data.id,
    });
  }
  await recordAudit({ actorId: user.id, teamId: parsed.data.teamId, action: "announcement.created", resourceType: "announcement", resourceId: data.id, metadata: { title: parsed.data.title } });

  return NextResponse.json({ announcement: (await attachProfiles(supabase, [data], "author_id"))[0] }, { status: 201 });
}
