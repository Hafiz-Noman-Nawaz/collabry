import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser, getMembership, nonTeamMembers } from "@/lib/authz";
import { badRequest, forbidden, parseUuid, queryInt, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { recordAudit } from "@/lib/audit";
import { notifyTeam } from "@/lib/notify";

const taskSchema = z.object({
  teamId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).default(""),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  dueAt: z.string().datetime().nullable().default(null),
  assigneeIds: z.array(z.string().uuid()).max(30).default([]),
});

const TASK_SELECT = "id, team_id, title, description, status, priority, due_at, created_at, created_by, task_assignees(user_id)";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const teamId = parseUuid(url.searchParams.get("teamId"));
  if (!teamId) return badRequest("A valid team is required.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limit = queryInt(url, "limit", 100, 200);
  const offset = queryInt(url, "offset", 0, 10000);
  const status = url.searchParams.get("status");
  const priority = url.searchParams.get("priority");
  const search = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
  const assignee = parseUuid(url.searchParams.get("assigneeId"));

  let query = supabase
    .from("tasks")
    .select(TASK_SELECT)
    .eq("team_id", teamId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (status && ["todo", "in_progress", "in_review", "completed"].includes(status)) query = query.eq("status", status);
  if (priority && ["low", "medium", "high", "urgent"].includes(priority)) query = query.eq("priority", priority);
  if (search) query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%`);
  if (assignee) query = query.filter("task_assignees.user_id", "eq", assignee);

  const { data, error } = await query;
  if (error) return badRequest(error.message);

  const { count } = await supabase.from("tasks").select("id", { count: "exact", head: true }).eq("team_id", teamId);
  return NextResponse.json({ tasks: data ?? [], total: count ?? 0 });
}

export async function POST(request: Request) {
  const parsed = taskSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid task details.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limited = rateLimit(`task:create:${user.id}`, 60, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const membership = await getMembership(supabase, parsed.data.teamId, user.id);
  if (!membership) return forbidden("You do not have access to this team.");

  if (parsed.data.assigneeIds.length > 0) {
    const outsiders = await nonTeamMembers(supabase, parsed.data.teamId, parsed.data.assigneeIds);
    if (outsiders.length > 0) return badRequest("Assignees must be members of this project.");
  }

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      team_id: parsed.data.teamId,
      created_by: user.id,
      title: parsed.data.title,
      description: parsed.data.description,
      priority: parsed.data.priority,
      due_at: parsed.data.dueAt,
    })
    .select("id, team_id, title, description, status, priority, due_at, created_at, created_by")
    .single();
  if (error || !data) return badRequest(error?.message ?? "Unable to create the task.");

  if (parsed.data.assigneeIds.length > 0) {
    const { error: assignError } = await supabase
      .from("task_assignees")
      .insert(parsed.data.assigneeIds.map((userId) => ({ task_id: data.id, user_id: userId })));
    if (assignError) return badRequest(assignError.message);
  }

  await supabase.from("task_events").insert({
    task_id: data.id,
    actor_id: user.id,
    event_type: "created",
    to_value: "todo",
  });
  await recordAudit({ actorId: user.id, teamId: parsed.data.teamId, action: "task.created", resourceType: "task", resourceId: data.id, metadata: { title: parsed.data.title } });

  if (parsed.data.assigneeIds.length > 0) {
    await notifyTeam({
      userIds: parsed.data.assigneeIds,
      teamId: parsed.data.teamId,
      kind: "task",
      title: `New task: ${parsed.data.title}`,
      body: parsed.data.description.slice(0, 140),
      resourceType: "task",
      resourceId: data.id,
    });
  }

  return NextResponse.json({ task: data }, { status: 201 });
}
