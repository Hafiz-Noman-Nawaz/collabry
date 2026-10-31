import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser, getMembership, hasRole, MANAGER_ROLES } from "@/lib/authz";
import { badRequest, forbidden, notFound, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { attachProfiles } from "@/lib/profiles";

const rsvpSchema = z.object({ rsvp: z.enum(["pending", "accepted", "declined", "tentative"]) });
const attendanceSchema = z.object({
  records: z
    .array(z.object({ userId: z.string().uuid(), attended: z.boolean().nullable() }))
    .min(1)
    .max(60),
});

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data, error } = await supabase
    .from("meeting_attendees")
    .select("meeting_id, user_id, rsvp, attended")
    .eq("meeting_id", id)
    .order("user_id", { ascending: true });
  if (error) return badRequest(error.message);
  return NextResponse.json({ attendees: await attachProfiles(supabase, data ?? [], "user_id") });
}

/** An attendee sets their own RSVP. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = rsvpSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid RSVP value.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limited = rateLimit(`meeting:rsvp:${user.id}`, 60, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const { data: meeting } = await supabase.from("meetings").select("id, team_id").eq("id", id).maybeSingle();
  if (!meeting) return notFound("Meeting not found.");

  const { data, error } = await supabase
    .from("meeting_attendees")
    .upsert({ meeting_id: id, user_id: user.id, rsvp: parsed.data.rsvp }, { onConflict: "meeting_id,user_id" })
    .select("meeting_id, user_id, rsvp, attended");
  if (error) return badRequest(error.message);
  return NextResponse.json({ attendee: data?.[0] ?? null });
}

/** Managers record actual attendance after the meeting. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = attendanceSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid attendance records.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data: meeting } = await supabase.from("meetings").select("id, team_id").eq("id", id).maybeSingle();
  if (!meeting) return notFound("Meeting not found.");

  const membership = await getMembership(supabase, meeting.team_id, user.id);
  if (!hasRole(membership?.role, MANAGER_ROLES)) return forbidden("Only team managers can record attendance.");

  for (const record of parsed.data.records) {
    const { error } = await supabase
      .from("meeting_attendees")
      .update({ attended: record.attended })
      .eq("meeting_id", id)
      .eq("user_id", record.userId);
    if (error) return badRequest(error.message);
  }

  const { data } = await supabase.from("meeting_attendees").select("meeting_id, user_id, rsvp, attended").eq("meeting_id", id);
  return NextResponse.json({ attendees: await attachProfiles(supabase, data ?? [], "user_id") });
}
