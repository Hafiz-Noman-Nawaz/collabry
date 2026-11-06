import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getMembership, getSessionUser } from "@/lib/authz";
import { badRequest, forbidden, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { generateGroundedAnswer, GROQ_MODEL, groqConfigured } from "@/lib/groq";

const requestSchema = z.object({
  teamId: z.string().uuid(),
  action: z.enum(["health", "next_steps", "breakdown"]),
  taskId: z.string().uuid().optional(),
});

function jsonAnswer(value: string) {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] ?? value;
  try {
    return JSON.parse(fenced);
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("A valid project and workflow action are required.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();
  if (!groqConfigured()) return badRequest("AI is not configured. Add GROQ_API_KEY to the server environment.");
  if (!(await getMembership(supabase, parsed.data.teamId, user.id))) return forbidden("You do not have access to this project.");

  const limited = rateLimit(`ai:workflow:${user.id}`, 12, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const [tasks, phases, meetings, team] = await Promise.all([
    supabase.from("tasks").select("id, title, description, status, priority, due_at, task_assignees(user_id)").eq("team_id", parsed.data.teamId).order("updated_at", { ascending: false }).limit(100),
    supabase.from("roadmap_phases").select("id, title, summary, status, position").eq("team_id", parsed.data.teamId).order("position", { ascending: true }).limit(30),
    supabase.from("meetings").select("id, title, agenda, starts_at, status").eq("team_id", parsed.data.teamId).order("starts_at", { ascending: false }).limit(20),
    supabase.from("teams").select("name, description, target_date").eq("id", parsed.data.teamId).maybeSingle(),
  ]);
  if (tasks.error) return badRequest(tasks.error.message);

  const selectedTask = parsed.data.taskId ? (tasks.data ?? []).find((task) => task.id === parsed.data.taskId) : null;
  const context = JSON.stringify({
    project: team.data,
    tasks: selectedTask ? [selectedTask] : tasks.data ?? [],
    roadmap: phases.data ?? [],
    meetings: meetings.data ?? [],
  });
  const actionInstructions = {
    health: 'Return JSON only: {"status":"healthy|at_risk|critical","summary":"string","blockers":["string"],"risks":["string"],"recommendations":["string"]}. Use only evidence in context.',
    next_steps: 'Return JSON only: {"nextSteps":[{"title":"string","reason":"string","sourceTaskId":"uuid or null"}]}. Suggest at most five actions grounded in existing incomplete work.',
    breakdown: 'Return JSON only: {"subtasks":[{"title":"string","description":"string","priority":"low|medium|high|urgent"}],"questions":["string"]}. Break down only the selected task; do not invent requirements.',
  } as const;
  const generated = await generateGroundedAnswer({
    system: `You are a project operations assistant. ${actionInstructions[parsed.data.action]} Never invent dates, owners, requirements, progress, or dependencies. If evidence is missing, put a question in the response. Do not modify data.`,
    question: parsed.data.action === "breakdown" ? "Break down the selected task into reviewable subtasks." : `Analyze the project's ${parsed.data.action.replace("_", " ")}.`,
    context: context.slice(0, 30_000),
  });
  if (generated.error || !generated.answer) return badRequest(generated.error ?? "Unable to analyze the project.");

  const answer = jsonAnswer(generated.answer);
  if (!answer || typeof answer !== "object") return badRequest("The AI returned an unusable workflow analysis. Try again.");

  await supabase.from("ai_usage_events").insert({
    team_id: parsed.data.teamId,
    user_id: user.id,
    feature: `workflow_${parsed.data.action}`,
    provider: "groq",
    model: GROQ_MODEL,
    input_tokens: generated.usage.inputTokens,
    output_tokens: generated.usage.outputTokens,
    source_count: (tasks.data?.length ?? 0) + (phases.data?.length ?? 0) + (meetings.data?.length ?? 0),
  });

  return NextResponse.json({ action: parsed.data.action, result: answer, model: GROQ_MODEL });
}
