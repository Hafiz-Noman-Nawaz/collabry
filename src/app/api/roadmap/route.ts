import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser, getMembership } from "@/lib/authz";
import { badRequest, forbidden, parseUuid, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { recordAudit } from "@/lib/audit";
import { MAX_PHASES, MAX_TASKS_PER_PHASE, MAX_TOTAL_TASKS, roadmapProgress, TASK_PRIORITIES, type RoadmapPhase } from "@/lib/roadmap";

const PHASE_SELECT = "id, team_id, title, summary, position, status, start_date, end_date, source, created_by, created_at, updated_at";

const draftTaskSchema = z.object({
  title: z.string().trim().min(1).max(140),
  priority: z.enum(TASK_PRIORITIES).default("medium"),
  description: z.string().trim().max(320).default(""),
});

const roadmapSchema = z.object({
  teamId: z.string().uuid(),
  phases: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(140),
        summary: z.string().trim().max(320).default(""),
        source: z.enum(["manual", "gemini"]).default("manual"),
        tasks: z.array(draftTaskSchema).max(MAX_TASKS_PER_PHASE).default([]),
      }),
    )
    .min(1)
    .max(MAX_PHASES),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const teamId = parseUuid(url.searchParams.get("teamId"));
  if (!teamId) return badRequest("A valid team is required.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const [{ data: phases, error }, { data: tasks, error: taskError }] = await Promise.all([
    supabase.from("roadmap_phases").select(PHASE_SELECT).eq("team_id", teamId).order("position", { ascending: true }),
    supabase.from("tasks").select("phase_id, status").eq("team_id", teamId).not("phase_id", "is", null),
  ]);
  if (error) return badRequest(error.message);
  if (taskError) return badRequest(taskError.message);

  // Progress is measured from the task rows that exist, never from a stored percentage.
  const counted = (phases ?? []).map((phase) => {
    const inPhase = (tasks ?? []).filter((task) => task.phase_id === phase.id);
    return {
      ...phase,
      task_total: inPhase.length,
      task_done: inPhase.filter((task) => task.status === "completed").length,
    };
  });

  return NextResponse.json({ phases: counted, summary: roadmapProgress(counted) });
}

/** Stores a reviewed roadmap: phases in order, plus the tasks derived from them. */
export async function POST(request: Request) {
  const parsed = roadmapSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("A roadmap needs at least one phase with a title.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limited = rateLimit(`roadmap:create:${user.id}`, 20, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const membership = await getMembership(supabase, parsed.data.teamId, user.id);
  if (!membership) return forbidden("You do not have access to this team.");

  const incomingTotal = parsed.data.phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
  if (incomingTotal > MAX_TOTAL_TASKS) return badRequest(`Keep a roadmap to ${MAX_TOTAL_TASKS} tasks or fewer.`);

  const { data: existing } = await supabase.from("roadmap_phases").select("position").eq("team_id", parsed.data.teamId).order("position", { ascending: false }).limit(1);
  let position = (existing?.[0]?.position ?? 0) + 1;

  const created: Array<RoadmapPhase & { task_total: number; task_done: number }> = [];
  for (const phase of parsed.data.phases) {
    const { data, error } = await supabase
      .from("roadmap_phases")
      .insert({
        team_id: parsed.data.teamId,
        created_by: user.id,
        title: phase.title,
        summary: phase.summary,
        position,
        source: phase.source,
      })
      .select(PHASE_SELECT)
      .single();
    if (error || !data) {
      await recordAudit({ actorId: user.id, teamId: parsed.data.teamId, action: "roadmap.failed", resourceType: "team", resourceId: parsed.data.teamId, metadata: { error: error?.message ?? "no row" } });
      return badRequest(error?.message ?? "Unable to save the roadmap.");
    }
    position += 1;
    if (phase.tasks.length > 0) {
      const { error: taskError } = await supabase.from("tasks").insert(
        phase.tasks.map((task) => ({
          team_id: parsed.data.teamId,
          created_by: user.id,
          phase_id: data.id,
          title: task.title,
          description: task.description,
          priority: task.priority,
        })),
      );
      if (taskError) return badRequest(taskError.message);
    }
    created.push({ ...data, task_total: phase.tasks.length, task_done: 0 });
  }

  await recordAudit({
    actorId: user.id,
    teamId: parsed.data.teamId,
    action: "roadmap.created",
    resourceType: "team",
    resourceId: parsed.data.teamId,
    metadata: { phases: created.length, tasks: incomingTotal },
  });

  return NextResponse.json({ phases: created, summary: roadmapProgress(created) }, { status: 201 });
}
