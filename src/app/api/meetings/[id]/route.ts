import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser, getMembership, hasRole, nonTeamMembers, MANAGER_ROLES } from "@/lib/authz";
import { badRequest, forbidden, notFound, unauthorized } from "@/lib/api";
import { recordAudit } from "@/lib/audit";
import { notifyTeam } from "@/lib/notify";
import { scheduleMeetingReminder } from "@/lib/jobs";
import { loadProfiles, profileOf } from "@/lib/profiles";

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    agenda: z.string().trim().max(4000).optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    timezone: z.string().trim().min(1).max(80).optional(),
    meetingUrl: z.string().url().optional().or(z.literal("")).optional(),
    status: z.enum(["scheduled", "cancelled", "completed"]).optional(),
    attendeeIds: z.array(z.string().uuid()).max(60).optional(),
  })
  .refine((value) => !(value.startsAt && value.endsAt) || new Date(value.endsAt).getTime() > new Date(value.startsAt).getTime(), {
    message: "Meeting end must be after its start.",
  });

const DETAIL_SELECT =
  "id, team_id, title, agenda, starts_at, ends_at, timezone, status, meeting_url, created_at, created_by, meeting_attendees(user_id, rsvp, attended), meeting_minutes(body, decisions, updated_at, author_id), meeting_action_items(id, title, done, assignee_id, task_id, created_at)";

/** Loose shape of the hydrated meeting payload returned by DETAIL_SELECT. */
type HydratableMeeting = {
  created_by: string;
  meeting_attendees?: Array<{ user_id: string; [key: string]: unknown }>;
  meeting_minutes?: Array<{ author_id: string; [key: string]: unknown }> | { author_id: string; [key: string]: unknown } | null;
  meeting_action_items?: Array<{ assignee_id: string | null; [key: string]: unknown }>;
  [key: string]: unknown;
};

/** Merges display names, since PostgREST cannot embed profiles through user_id. */
async function hydrateMeeting(supabase: Awaited<ReturnType<typeof createClient>>, meeting: HydratableMeeting) {
  const minutes = Array.isArray(meeting.meeting_minutes) ? (meeting.meeting_minutes[0] ?? null) : (meeting.meeting_minutes ?? null);
  const attendeeIds = (meeting.meeting_attendees ?? []).map((row) => row.user_id);
  const actionIds = (meeting.meeting_action_items ?? []).map((row) => row.assignee_id);
  const profiles = await loadProfiles(supabase, [...attendeeIds, ...actionIds, minutes?.author_id, meeting.created_by]);
  for (const row of meeting.meeting_attendees ?? []) row.profiles = profileOf(profiles, row.user_id);
  for (const row of meeting.meeting_action_items ?? []) row.profiles = profileOf(profiles, row.assignee_id);
  if (minutes) meeting.profiles = profileOf(profiles, minutes.author_id);
  return meeting;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data, error } = await supabase.from("meetings").select(DETAIL_SELECT).eq("id", id).single();
  if (error || !data) return notFound("Meeting not found.");
  return NextResponse.json({ meeting: await hydrateMeeting(supabase, data) });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid meeting update.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data: current } = await supabase
    .from("meetings")
    .select("id, team_id, title, starts_at, status")
    .eq("id", id)
    .maybeSingle();
  if (!current) return notFound("Meeting not found.");

  const membership = await getMembership(supabase, current.team_id, user.id);
  if (!hasRole(membership?.role, MANAGER_ROLES)) return forbidden("Only team managers can change meetings.");

  const patch: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) patch.title = parsed.data.title;
  if (parsed.data.agenda !== undefined) patch.agenda = parsed.data.agenda;
  if (parsed.data.startsAt !== undefined) patch.starts_at = parsed.data.startsAt;
  if (parsed.data.endsAt !== undefined) patch.ends_at = parsed.data.endsAt;
  if (parsed.data.timezone !== undefined) patch.timezone = parsed.data.timezone;
  if (parsed.data.meetingUrl !== undefined) patch.meeting_url = parsed.data.meetingUrl || null;
  if (parsed.data.status !== undefined) patch.status = parsed.data.status;
  if (Object.keys(patch).length === 0 && parsed.data.attendeeIds === undefined) {
    return NextResponse.json({ meeting: current });
  }

  if (Object.keys(patch).length > 0) {
    const { data: updated, error } = await supabase
      .from("meetings")
      .update(patch)
      .eq("id", id)
      .select("id, team_id, title, agenda, starts_at, ends_at, timezone, status, meeting_url, created_at")
      .single();
    if (error || !updated) return badRequest(error?.message ?? "Unable to update the meeting.");

    const rescheduled = (parsed.data.startsAt && parsed.data.startsAt !== current.starts_at) || (parsed.data.status && parsed.data.status !== current.status);
    if (rescheduled) {
      await recordAudit({
        actorId: user.id,
        teamId: current.team_id,
        action: parsed.data.status === "cancelled" ? "meeting.cancelled" : "meeting.rescheduled",
        resourceType: "meeting",
        resourceId: id,
        metadata: { from: current.starts_at, to: parsed.data.startsAt ?? current.starts_at, status: parsed.data.status ?? current.status },
      });
      const { data: attendees } = await supabase.from("meeting_attendees").select("user_id").eq("meeting_id", id);
      const recipientIds = (attendees ?? []).map((row) => row.user_id).filter((userId) => userId !== user.id);
      if (recipientIds.length > 0) {
        await notifyTeam({
          userIds: recipientIds,
          teamId: current.team_id,
          kind: "meeting",
          title: parsed.data.status === "cancelled" ? `Cancelled: ${current.title}` : `Updated: ${updated.title}`,
          body: parsed.data.status === "cancelled" ? "This meeting has been cancelled." : `Starts ${new Date(updated.starts_at).toLocaleString()}`,
          resourceType: "meeting",
          resourceId: id,
        });
      }
      await scheduleMeetingReminder(updated);
    }
  }

  if (parsed.data.attendeeIds !== undefined) {
    const outsiders = await nonTeamMembers(supabase, current.team_id, parsed.data.attendeeIds);
    if (outsiders.length > 0) return badRequest("Attendees must be members of this project.");
    const { data: existing } = await supabase.from("meeting_attendees").select("user_id").eq("meeting_id", id);
    const currentIds = (existing ?? []).map((row) => row.user_id);
    const toAdd = parsed.data.attendeeIds.filter((userId) => !currentIds.includes(userId));
    const toRemove = currentIds.filter((userId) => !parsed.data.attendeeIds!.includes(userId));
    if (toRemove.length > 0) {
      const { error } = await supabase.from("meeting_attendees").delete().eq("meeting_id", id).in("user_id", toRemove);
      if (error) return badRequest(error.message);
    }
    if (toAdd.length > 0) {
      const { error } = await supabase
        .from("meeting_attendees")
        .insert(toAdd.map((userId) => ({ meeting_id: id, user_id: userId, rsvp: "pending" })));
      if (error) return badRequest(error.message);
      await notifyTeam({
        userIds: toAdd,
        teamId: current.team_id,
        kind: "meeting",
        title: `Added to meeting: ${current.title}`,
        body: `Starts ${new Date(current.starts_at).toLocaleString()}`,
        resourceType: "meeting",
        resourceId: id,
      });
    }
    await recordAudit({ actorId: user.id, teamId: current.team_id, action: "meeting.attendees_changed", resourceType: "meeting", resourceId: id, metadata: { added: toAdd.length, removed: toRemove.length } });
  }

  const { data: meeting } = await supabase.from("meetings").select(DETAIL_SELECT).eq("id", id).single();
  if (!meeting) return NextResponse.json({ meeting: current });
  return NextResponse.json({ meeting: await hydrateMeeting(supabase, meeting) });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data: current } = await supabase.from("meetings").select("id, team_id, title").eq("id", id).maybeSingle();
  if (!current) return notFound("Meeting not found.");

  const membership = await getMembership(supabase, current.team_id, user.id);
  if (!hasRole(membership?.role, MANAGER_ROLES)) return forbidden("Only team managers can delete meetings.");

  const { error } = await supabase.from("meetings").delete().eq("id", id);
  if (error) return badRequest(error.message);
  await recordAudit({ actorId: user.id, teamId: current.team_id, action: "meeting.deleted", resourceType: "meeting", resourceId: id, metadata: { title: current.title } });
  return NextResponse.json({ ok: true });
}
