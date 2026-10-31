import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser, getMembership, nonTeamMembers } from "@/lib/authz";
import { badRequest, parseUuid, queryInt, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { recordAudit } from "@/lib/audit";
import { notifyTeam } from "@/lib/notify";
import { scheduleMeetingReminder } from "@/lib/jobs";
import { attachProfiles, loadProfiles, profileOf } from "@/lib/profiles";

const meetingSchema = z.object({
  teamId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  agenda: z.string().trim().max(4000).default(""),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  timezone: z.string().trim().min(1).max(80).default("UTC"),
  meetingUrl: z.string().url().optional().or(z.literal("")),
  attendeeIds: z.array(z.string().uuid()).max(60).default([]),
});

const MEETING_SELECT = "id, team_id, title, agenda, starts_at, ends_at, timezone, status, meeting_url, created_at, created_by, meeting_attendees(user_id, rsvp, attended)";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const teamId = parseUuid(url.searchParams.get("teamId"));
  if (!teamId) return badRequest("A valid team is required.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const limit = queryInt(url, "limit", 200, 500);

  let query = supabase.from("meetings").select(MEETING_SELECT).eq("team_id", teamId).order("starts_at", { ascending: true }).limit(limit);
  if (from) query = query.gte("starts_at", from);
  if (to) query = query.lte("starts_at", to);

  const { data, error } = await query;
  if (error) return badRequest(error.message);
  const meetings = await attachProfiles(supabase, data ?? [], "created_by");
  for (const meeting of meetings) {
    const attendeeMap = await loadProfiles(supabase, (meeting.meeting_attendees ?? []).map((row: { user_id: string }) => row.user_id));
    (meeting.meeting_attendees as Array<Record<string, unknown>>).forEach((row) => {
      row.profiles = profileOf(attendeeMap, row.user_id as string);
    });
  }
  return NextResponse.json({ meetings });
}

export async function POST(request: Request) {
  const parsed = meetingSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid meeting details.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limited = rateLimit(`meeting:create:${user.id}`, 30, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const membership = await getMembership(supabase, parsed.data.teamId, user.id);
  if (!membership) return badRequest("You do not have access to this team.");

  if (parsed.data.attendeeIds.length > 0) {
    const outsiders = await nonTeamMembers(supabase, parsed.data.teamId, parsed.data.attendeeIds);
    if (outsiders.length > 0) return badRequest("Attendees must be members of this project.");
  }

  const { data, error } = await supabase
    .from("meetings")
    .insert({
      team_id: parsed.data.teamId,
      created_by: user.id,
      title: parsed.data.title,
      agenda: parsed.data.agenda,
      starts_at: parsed.data.startsAt,
      ends_at: parsed.data.endsAt,
      timezone: parsed.data.timezone,
      meeting_url: parsed.data.meetingUrl || null,
    })
    .select("id, team_id, title, agenda, starts_at, ends_at, timezone, status, meeting_url, created_at, created_by")
    .single();
  if (error || !data) return badRequest(error?.message ?? "Unable to schedule the meeting.");

  const attendeeIds = Array.from(new Set([user.id, ...parsed.data.attendeeIds]));
  if (attendeeIds.length > 0) {
    const { error: attendeeError } = await supabase
      .from("meeting_attendees")
      .insert(attendeeIds.map((userId) => ({ meeting_id: data.id, user_id: userId, rsvp: userId === user.id ? "accepted" : "pending" })));
    if (attendeeError) return badRequest(attendeeError.message);
  }

  await scheduleMeetingReminder(data);
  await recordAudit({ actorId: user.id, teamId: parsed.data.teamId, action: "meeting.scheduled", resourceType: "meeting", resourceId: data.id, metadata: { starts_at: parsed.data.startsAt } });

  const notifyIds = attendeeIds.filter((userId) => userId !== user.id);
  if (notifyIds.length > 0) {
    await notifyTeam({
      userIds: notifyIds,
      teamId: parsed.data.teamId,
      kind: "meeting",
      title: `Meeting scheduled: ${parsed.data.title}`,
      body: `Starts ${new Date(parsed.data.startsAt).toLocaleString()}`,
      resourceType: "meeting",
      resourceId: data.id,
    });
  }

  return NextResponse.json({ meeting: data }, { status: 201 });
}
