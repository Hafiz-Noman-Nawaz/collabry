import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/authz";
import { badRequest, unauthorized } from "@/lib/api";

const preferencesSchema = z.object({
  emailInvitations: z.boolean().optional(),
  emailMeetings: z.boolean().optional(),
  emailTasks: z.boolean().optional(),
  emailDeadlines: z.boolean().optional(),
  emailAnnouncements: z.boolean().optional(),
});

const DEFAULTS = {
  email_invitations: true,
  email_meetings: true,
  email_tasks: true,
  email_deadlines: true,
  email_announcements: true,
};

const SELECT = "user_id, email_invitations, email_meetings, email_tasks, email_deadlines, email_announcements, updated_at";

function toClient(row: Record<string, unknown>) {
  return {
    emailInvitations: row.email_invitations !== false,
    emailMeetings: row.email_meetings !== false,
    emailTasks: row.email_tasks !== false,
    emailDeadlines: row.email_deadlines !== false,
    emailAnnouncements: row.email_announcements !== false,
    updatedAt: row.updated_at ?? null,
  };
}

export async function GET() {
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data } = await supabase.from("notification_preferences").select(SELECT).eq("user_id", user.id).maybeSingle();
  return NextResponse.json({ preferences: data ? toClient(data) : toClient({ ...DEFAULTS, user_id: user.id }) });
}

export async function PUT(request: Request) {
  const parsed = preferencesSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid notification preferences.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.emailInvitations !== undefined) patch.email_invitations = parsed.data.emailInvitations;
  if (parsed.data.emailMeetings !== undefined) patch.email_meetings = parsed.data.emailMeetings;
  if (parsed.data.emailTasks !== undefined) patch.email_tasks = parsed.data.emailTasks;
  if (parsed.data.emailDeadlines !== undefined) patch.email_deadlines = parsed.data.emailDeadlines;
  if (parsed.data.emailAnnouncements !== undefined) patch.email_announcements = parsed.data.emailAnnouncements;

  const { data: existing } = await supabase.from("notification_preferences").select("user_id").eq("user_id", user.id).maybeSingle();
  const { data, error } = existing
    ? await supabase.from("notification_preferences").update(patch).eq("user_id", user.id).select(SELECT).single()
    : await supabase.from("notification_preferences").insert({ user_id: user.id, ...DEFAULTS, ...patch }).select(SELECT).single();
  if (error || !data) return badRequest(error?.message ?? "Unable to save preferences.");

  return NextResponse.json({ preferences: toClient(data) });
}
