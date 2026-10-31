import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser, nonTeamMembers } from "@/lib/authz";
import { badRequest, forbidden, notFound, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { recordAudit } from "@/lib/audit";
import { notifyTeam } from "@/lib/notify";
import { loadProfiles, profileOf } from "@/lib/profiles";

const updateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(4000).optional(),
  status: z.enum(["todo", "in_progress", "in_review", "completed"]).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  dueAt: z.string().datetime().nullable().optional(),
  assigneeIds: z.array(z.string().uuid()).max(30).optional(),
});

const DETAIL_SELECT =
  "id, team_id, title, description, status, priority, due_at, created_at, updated_at, created_by, task_assignees(user_id), task_comments(id, body, author_id, created_at, updated_at), task_checklist_items(id, body, done, position, created_at), task_events(id, event_type, from_value, to_value, actor_id, created_at), task_reviews(id, state, body, reviewer_id, created_at)";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data, error } = await supabase.from("tasks").select(DETAIL_SELECT).eq("id", id).single();
  if (error || !data) return notFound("Task not found.");

  // Names are merged here because PostgREST cannot embed profiles via user_id.
  const profiles = await loadProfiles(supabase, [
    data.created_by,
    ...(data.task_assignees ?? []).map((row: { user_id: string }) => row.user_id),
    ...(data.task_comments ?? []).map((row: { author_id: string }) => row.author_id),
    ...(data.task_events ?? []).map((row: { actor_id: string }) => row.actor_id),
    ...(data.task_reviews ?? []).map((row: { reviewer_id: string }) => row.reviewer_id),
  ]);
  const task = {
    ...data,
    task_assignees: (data.task_assignees ?? []).map((row: { user_id: string }) => ({ ...row, profiles: profileOf(profiles, row.user_id) })),
    task_comments: (data.task_comments ?? []).map((row: { author_id: string }) => ({ ...row, profiles: profileOf(profiles, row.author_id) })),
    task_events: (data.task_events ?? []).map((row: { actor_id: string }) => ({ ...row, profiles: profileOf(profiles, row.actor_id) })),
    task_reviews: (data.task_reviews ?? []).map((row: { reviewer_id: string }) => ({ ...row, profiles: profileOf(profiles, row.reviewer_id) })),
  };
  return NextResponse.json({ task });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid task update.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limited = rateLimit(`task:update:${user.id}`, 120, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const { data: current, error: loadError } = await supabase
    .from("tasks")
    .select("id, team_id, title, status, created_by")
    .eq("id", id)
    .single();
  if (loadError || !current) return notFound("Task not found.");

  const patch: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) patch.title = parsed.data.title;
  if (parsed.data.description !== undefined) patch.description = parsed.data.description;
  if (parsed.data.priority !== undefined) patch.priority = parsed.data.priority;
  if (parsed.data.dueAt !== undefined) patch.due_at = parsed.data.dueAt;
  const statusChanged = parsed.data.status !== undefined && parsed.data.status !== current.status;
  if (statusChanged) patch.status = parsed.data.status;
  if (Object.keys(patch).length === 0 && parsed.data.assigneeIds === undefined) {
    return NextResponse.json({ task: { id: current.id, status: current.status } });
  }

  if (Object.keys(patch).length > 0) {
    const { error } = await supabase
      .from("tasks")
      .update(patch)
      .eq("id", id)
      .select("id, team_id, title, description, status, priority, due_at, created_at, created_by")
      .single();
    if (error) {
      // RLS rejects edits from members who cannot manage tasks.
      return error.code === "PGRST116" ? forbidden("You cannot edit this task.") : badRequest(error.message);
    }
    if (statusChanged) {
      await supabase.from("task_events").insert({
        task_id: id,
        actor_id: user.id,
        event_type: "status",
        from_value: current.status,
        to_value: parsed.data.status,
      });
      await recordAudit({ actorId: user.id, teamId: current.team_id, action: "task.status_changed", resourceType: "task", resourceId: id, metadata: { from: current.status, to: parsed.data.status } });
    } else {
      await supabase.from("task_events").insert({ task_id: id, actor_id: user.id, event_type: "updated" });
    }
    await recordAudit({ actorId: user.id, teamId: current.team_id, action: "task.updated", resourceType: "task", resourceId: id, metadata: { fields: Object.keys(patch) } });
    if (statusChanged) {
      const { data: assignees } = await supabase.from("task_assignees").select("user_id").eq("task_id", id);
      const recipientIds = (assignees ?? []).map((row) => row.user_id);
      if (recipientIds.length > 0) {
        await notifyTeam({
          userIds: recipientIds,
          teamId: current.team_id,
          kind: "task",
          title: `${current.title} moved to ${String(parsed.data.status).replace("_", " ")}`,
          body: "Task status changed",
          resourceType: "task",
          resourceId: id,
        });
      }
    }
  }

  if (parsed.data.assigneeIds !== undefined) {
    const outsiders = await nonTeamMembers(supabase, current.team_id, parsed.data.assigneeIds);
    if (outsiders.length > 0) return badRequest("Assignees must be members of this project.");
    const { error: clearError } = await supabase.from("task_assignees").delete().eq("task_id", id);
    if (clearError) return badRequest(clearError.message);
    if (parsed.data.assigneeIds.length > 0) {
      const { error: addError } = await supabase
        .from("task_assignees")
        .insert(parsed.data.assigneeIds.map((userId) => ({ task_id: id, user_id: userId })));
      if (addError) return badRequest(addError.message);
    }
    await supabase.from("task_events").insert({ task_id: id, actor_id: user.id, event_type: "assignees_changed" });
    if (parsed.data.assigneeIds.length > 0) {
      await notifyTeam({
        userIds: parsed.data.assigneeIds,
        teamId: current.team_id,
        kind: "task",
        title: `You were assigned: ${current.title}`,
        body: "Open the task to see the details.",
        resourceType: "task",
        resourceId: id,
      });
    }
  }

  const { data: task } = await supabase
    .from("tasks")
    .select("id, team_id, title, description, status, priority, due_at, created_at, created_by, task_assignees(user_id)")
    .eq("id", id)
    .single();
  return NextResponse.json({ task });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data: current } = await supabase.from("tasks").select("id, team_id, title").eq("id", id).maybeSingle();
  if (!current) return notFound("Task not found.");

  const { error } = await supabase.from("tasks").delete().eq("id", id);
  if (error) return forbidden("You cannot delete this task.");
  await recordAudit({ actorId: user.id, teamId: current.team_id, action: "task.deleted", resourceType: "task", resourceId: id, metadata: { title: current.title } });
  return NextResponse.json({ ok: true });
}
