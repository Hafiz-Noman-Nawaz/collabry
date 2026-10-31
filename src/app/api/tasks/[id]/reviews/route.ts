import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser, getMembership, hasRole, REVIEWER_ROLES } from "@/lib/authz";
import { badRequest, forbidden, notFound, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { recordAudit } from "@/lib/audit";
import { notifyTeam } from "@/lib/notify";
import { attachProfiles } from "@/lib/profiles";

const reviewSchema = z.object({
  state: z.enum(["pending", "approved", "changes_requested"]),
  body: z.string().trim().max(2000).default(""),
});

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data, error } = await supabase
    .from("task_reviews")
    .select("id, task_id, state, body, reviewer_id, created_at")
    .eq("task_id", id)
    .order("created_at", { ascending: false });
  if (error) return badRequest(error.message);
  return NextResponse.json({ reviews: await attachProfiles(supabase, data ?? [], "reviewer_id") });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = reviewSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid review.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limited = rateLimit(`task:review:${user.id}`, 30, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const { data: task } = await supabase
    .from("tasks")
    .select("id, team_id, title, status")
    .eq("id", id)
    .maybeSingle();
  if (!task) return notFound("Task not found.");

  const membership = await getMembership(supabase, task.team_id, user.id);
  if (!hasRole(membership?.role, REVIEWER_ROLES)) return forbidden("Only reviewers can review this task.");

  const { data, error } = await supabase
    .from("task_reviews")
    .insert({ task_id: id, reviewer_id: user.id, state: parsed.data.state, body: parsed.data.body })
    .select("id, task_id, state, body, reviewer_id, created_at")
    .single();
  if (error) return badRequest(error.message);

  // An approval on a task awaiting review completes it and records the history.
  if (parsed.data.state === "approved" && task.status === "in_review") {
    await supabase.from("tasks").update({ status: "completed" }).eq("id", id);
    await supabase
      .from("task_events")
      .insert({ task_id: id, actor_id: user.id, event_type: "status", from_value: "in_review", to_value: "completed" });
  }

  await recordAudit({
    actorId: user.id,
    teamId: task.team_id,
    action: "task.reviewed",
    resourceType: "task",
    resourceId: id,
    metadata: { state: parsed.data.state },
  });

  const { data: assignees } = await supabase.from("task_assignees").select("user_id").eq("task_id", id);
  const recipientIds = (assignees ?? []).map((row) => row.user_id);
  if (recipientIds.length > 0) {
    await notifyTeam({
      userIds: recipientIds,
      teamId: task.team_id,
      kind: "review",
      title: `Review on "${task.title}": ${parsed.data.state.replace("_", " ")}`,
      body: parsed.data.body.slice(0, 140),
      resourceType: "task",
      resourceId: id,
    });
  }

  return NextResponse.json({ review: data }, { status: 201 });
}
