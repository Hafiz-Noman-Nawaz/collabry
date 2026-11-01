import { z } from "zod";

/**
 * Roadmap drafts shared by the Gemini generator, the API that stores them and the
 * editor that shows them. Nothing here touches the database, so a draft is always
 * reviewable before it becomes real project data.
 */

export const PHASE_STATUSES = ["planned", "active", "done"] as const;
export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export const MAX_PHASES = 6;
export const MAX_TASKS_PER_PHASE = 8;
export const MAX_TOTAL_TASKS = 32;

const title = z
  .string()
  .trim()
  .min(3, "A title needs at least three characters.")
  .max(140, "Titles are limited to 140 characters.")
  .regex(/^[^<>{}[\]\\]+$/, "Titles cannot contain angle brackets or braces.");

const summary = z.string().trim().max(320, "Summaries are limited to 320 characters.").default("");

export const draftTaskSchema = z.object({
  title,
  priority: z.enum(TASK_PRIORITIES).default("medium"),
  description: summary,
});

export const draftPhaseSchema = z.object({
  title,
  summary,
  tasks: z.array(draftTaskSchema).max(MAX_TASKS_PER_PHASE),
});

export const roadmapDraftSchema = z.object({
  phases: z.array(draftPhaseSchema).min(1).max(MAX_PHASES),
  questions: z.array(z.string().trim().min(3).max(220)).max(6).default([]),
});

export type RoadmapDraftTask = z.infer<typeof draftTaskSchema>;
export type RoadmapDraftPhase = z.infer<typeof draftPhaseSchema>;
export type RoadmapDraft = z.infer<typeof roadmapDraftSchema>;

export type RoadmapPhase = {
  id: string;
  team_id: string;
  title: string;
  summary: string;
  position: number;
  status: (typeof PHASE_STATUSES)[number];
  start_date: string | null;
  end_date: string | null;
  source: string;
  created_by: string | null;
  task_total: number;
  task_done: number;
};

/**
 * Rejects anything the model invented that we cannot store, and drops empty
 * phases. A draft that fails here is never written to the database.
 */
export function parseRoadmapDraft(payload: unknown): { draft: RoadmapDraft | null; error: string | null } {
  const parsed = roadmapDraftSchema.safeParse(payload);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { draft: null, error: first ? `${first.path.join(".") || "roadmap"}: ${first.message}` : "The plan was not in the expected shape." };
  }
  const phases = parsed.data.phases
    .map((phase) => {
      const seen = new Set<string>();
      return {
        ...phase,
        tasks: phase.tasks.filter((task) => {
          const key = task.title.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
      };
    })
    .filter((phase) => phase.title.length > 0);
  const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
  if (phases.length === 0) return { draft: null, error: "The plan came back with no phases." };
  if (totalTasks === 0) return { draft: null, error: "The plan came back with no tasks, so there would be nothing to track." };
  if (totalTasks > MAX_TOTAL_TASKS) {
    return { draft: null, error: `The plan asked for ${totalTasks} tasks; keep it to ${MAX_TOTAL_TASKS} or fewer.` };
  }
  return { draft: { phases, questions: parsed.data.questions }, error: null };
}

/** Progress comes only from stored task rows: done / total, never a typed number. */
export function phaseProgress(tasks: number, done: number) {
  if (tasks <= 0) return 0;
  return Math.round((Math.min(done, tasks) / tasks) * 100);
}

export function roadmapProgress(phases: Array<{ id: string; task_total: number; task_done: number }>) {
  const tasks = phases.reduce((sum, phase) => sum + phase.task_total, 0);
  const done = phases.reduce((sum, phase) => sum + Math.min(phase.task_done, phase.task_total), 0);
  return { tasks, done, percent: phaseProgress(tasks, done) };
}
