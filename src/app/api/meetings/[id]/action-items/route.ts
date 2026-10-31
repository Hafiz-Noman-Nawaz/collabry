import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser, getMembership, hasRole, MANAGER_ROLES } from "@/lib/authz";
import { badRequest, forbidden, notFound, parseUuid, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { notifyTeam } from "@/lib/notify";
import { attachProfiles } from "@/lib/profiles";

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  assigneeId: z.string().uuid().nullable().default(null),
  taskId: z.string().uuid().nullable().default(null),
});
const updateSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  done: z.boolean().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  taskId: z.string().uuid().nullable().optional(),
});

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data, error } = await supabase
    .from("meeting_action_items")
    .select("id, meeting_id, title, done, assignee_id, task_id, created_by, created_at")
    .eq("meeting_id", id)
    .order("created_at", { ascending: true });
  if (error) return badRequest(error.message);
  return NextResponse.json({ items: await attachProfiles(supabase, data ?? [], "assignee_id") });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid action item.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limited = rateLimit(`meeting:action:${user.id}`, 60, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const { data: meeting } = await supabase.from("meetings").select("id, team_id, title").eq("id", id).maybeSingle();
  if (!meeting) return notFound("Meeting not found.");

  const membership = await getMembership(supabase, meeting.team_id, user.id);
  if (!hasRole(membership?.role, MANAGER_ROLES)) return forbidden("Only team managers can add action items.");

  const { data, error } = await supabase
    .from("meeting_action_items")
    .insert({
      meeting_id: id,
      title: parsed.data.title,
      assignee_id: parsed.data.assigneeId,
      task_id: parsed.data.taskId,
      created_by: user.id,
    })
    .select("id, meeting_id, title, done, assignee_id, task_id, created_by, created_at")
    .single();
  if (error) return badRequest(error.message);

  if (parsed.data.assigneeId) {
    await notifyTeam({
      userIds: [parsed.data.assigneeId],
      teamId: meeting.team_id,
      kind: "task",
      title: `Action item: ${parsed.data.title}`,
      body: `From meeting "${meeting.title}"`,
      resourceType: "meeting",
      resourceId: id,
    });
  }
  return NextResponse.json({ item: data }, { status: 201 });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid action item update.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data: existing } = await supabase
    .from("meeting_action_items")
    .select("id, meeting_id, assignee_id, created_by")
    .eq("id", parsed.data.id)
    .eq("meeting_id", id)
    .maybeSingle();
  if (!existing) return notFound("Action item not found.");

  const { data: meeting } = await supabase.from("meetings").select("id, team_id").eq("id", id).maybeSingle();
  const membership = meeting ? await getMembership(supabase, meeting.team_id, user.id) : null;
  const canManage = hasRole(membership?.role, MANAGER_ROLES);
  // Managers manage freely; the assignee may only mark their own item done.
  if (!canManage && existing.assignee_id !== user.id) return forbidden("You cannot change this action item.");

  const patch: Record<string, unknown> = {};
  if (parsed.data.title !== undefined && canManage) patch.title = parsed.data.title;
  if (parsed.data.done !== undefined) patch.done = parsed.data.done;
  if (parsed.data.assigneeId !== undefined && canManage) patch.assignee_id = parsed.data.assigneeId;
  if (parsed.data.taskId !== undefined && canManage) patch.task_id = parsed.data.taskId;
  if (Object.keys(patch).length === 0) return badRequest("Nothing to update.");

  const { data, error } = await supabase
    .from("meeting_action_items")
    .update(patch)
    .eq("id", parsed.data.id)
    .eq("meeting_id", id)
    .select("id, meeting_id, title, done, assignee_id, task_id, created_by, created_at")
    .single();
  if (error || !data) return badRequest(error?.message ?? "Unable to update the action item.");
  return NextResponse.json({ item: (await attachProfiles(supabase, [data], "assignee_id"))[0] });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const itemId = parseUuid(new URL(request.url).searchParams.get("id"));
  if (!itemId) return badRequest("An action item id is required.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data: meeting } = await supabase.from("meetings").select("id, team_id").eq("id", id).maybeSingle();
  if (!meeting) return notFound("Meeting not found.");
  const membership = await getMembership(supabase, meeting.team_id, user.id);
  if (!hasRole(membership?.role, MANAGER_ROLES)) return forbidden("Only team managers can remove action items.");

  const { data, error } = await supabase
    .from("meeting_action_items")
    .delete()
    .eq("id", itemId)
    .eq("meeting_id", id)
    .select("id");
  if (error) return badRequest(error.message);
  if (!data || data.length === 0) return notFound("Action item not found.");
  return NextResponse.json({ ok: true });
}
