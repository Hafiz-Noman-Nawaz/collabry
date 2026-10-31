import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser, getMembership, hasRole, MANAGER_ROLES } from "@/lib/authz";
import { badRequest, forbidden, notFound, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { recordAudit } from "@/lib/audit";

const minutesSchema = z.object({
  body: z.string().trim().max(20000).default(""),
  decisions: z.string().trim().max(20000).default(""),
});

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data, error } = await supabase
    .from("meeting_minutes")
    .select("meeting_id, body, decisions, author_id, created_at, updated_at")
    .eq("meeting_id", id)
    .maybeSingle();
  if (error) return badRequest(error.message);
  return NextResponse.json({ minutes: data ?? null });
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = minutesSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Minutes content is too large.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limited = rateLimit(`meeting:minutes:${user.id}`, 30, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const { data: meeting } = await supabase.from("meetings").select("id, team_id, title").eq("id", id).maybeSingle();
  if (!meeting) return notFound("Meeting not found.");

  const membership = await getMembership(supabase, meeting.team_id, user.id);
  if (!hasRole(membership?.role, MANAGER_ROLES)) return forbidden("Only team managers can record minutes.");

  const { data: existing } = await supabase
    .from("meeting_minutes")
    .select("meeting_id, author_id")
    .eq("meeting_id", id)
    .maybeSingle();

  const payload = { body: parsed.data.body, decisions: parsed.data.decisions, author_id: user.id, updated_at: new Date().toISOString() };
  const { data, error } = existing
    ? await supabase.from("meeting_minutes").update(payload).eq("meeting_id", id).select("meeting_id, body, decisions, author_id, created_at, updated_at").single()
    : await supabase.from("meeting_minutes").insert({ meeting_id: id, ...payload }).select("meeting_id, body, decisions, author_id, created_at, updated_at").single();
  if (error || !data) return badRequest(error?.message ?? "Unable to save minutes.");

  await recordAudit({ actorId: user.id, teamId: meeting.team_id, action: "meeting.minutes_saved", resourceType: "meeting", resourceId: id, metadata: { decisionsLength: parsed.data.decisions.length } });
  return NextResponse.json({ minutes: data });
}
