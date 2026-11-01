import { MAX_PHASES, MAX_TASKS_PER_PHASE, parseRoadmapDraft, type RoadmapDraft } from "@/lib/roadmap";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const REQUEST_TIMEOUT_MS = 45_000;

export const GROQ_MODEL = process.env.GROQ_MODEL?.trim() || DEFAULT_MODEL;

export function groqConfigured() {
  return Boolean(process.env.GROQ_API_KEY?.trim());
}

const SYSTEM_INSTRUCTION = `You are a senior technical project planner writing a delivery roadmap for a real software team.

HARD RULES
1. Use only facts stated in the brief. Never invent a client, company, person, user name, budget, price, deadline, URL, dataset, compliance requirement or technology that the brief does not name.
2. Do not invent calendar dates. If the brief states no dates, leave the plan without dates. Do not guess durations in weeks or months.
3. Do not invent metrics, team sizes, or approval steps.
4. Phases are stages of work, not feature names, and follow a buildable order.
5. Every task must be an action with a verifiable deliverable and traceable to the brief.
6. Keep to ${MAX_PHASES} phases maximum and ${MAX_TASKS_PER_PHASE} tasks per phase maximum.
7. If the brief is too thin to plan part of the work, add a short, specific question to "questions" instead of guessing.
8. Return only valid JSON with this shape: {"phases":[{"title":"string","summary":"string","tasks":[{"title":"string","priority":"low|medium|high|urgent","description":"string"}]}],"questions":["string"]}.`;

export type RoadmapBrief = {
  projectName: string;
  description: string;
  technologies: string;
  notes: string;
};

function describeFailure(status: number, payload: unknown) {
  const message =
    payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error?: { message?: string } }).error?.message ?? "")
      : "";
  if (status === 401 || status === 403) return "Groq rejected the API key. Check GROQ_API_KEY in the server environment.";
  if (status === 404) return `Groq does not support model "${GROQ_MODEL}". Set GROQ_MODEL to an accessible model.`;
  if (status === 429) return "Groq rate limit reached. Try again in a moment.";
  return message ? `Groq: ${message.slice(0, 200)}` : `Groq returned status ${status}.`;
}

export async function generateRoadmapDraft(brief: RoadmapBrief): Promise<{ draft: RoadmapDraft | null; error: string | null }> {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) return { draft: null, error: "AI planning is not connected. Add GROQ_API_KEY to the server environment." };

  const prompt = [
    `Project name: ${brief.projectName}`,
    `What the project is, in the team's own words:\n${brief.description}`,
    brief.technologies ? `Technologies named by the team:\n${brief.technologies}` : "Technologies: none stated.",
    brief.notes ? `Extra constraints from the team:\n${brief.notes}` : "",
    "",
    "Plan this project. Nothing outside the text above may appear in the plan.",
  ]
    .filter(Boolean)
    .join("\n\n");

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: SYSTEM_INSTRUCTION },
          { role: "user", content: prompt.slice(0, 12_000) },
        ],
        response_format: { type: "json_object" },
        temperature: 0.35,
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "could not be reached";
    return { draft: null, error: `Groq ${reason}. The plan was not saved.` };
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) return { draft: null, error: describeFailure(response.status, payload) };

  const text = (payload as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content?.trim();
  if (!text) return { draft: null, error: "Groq returned no plan. Try a more detailed description." };

  try {
    const result = parseRoadmapDraft(JSON.parse(text));
    if (result.draft) return { draft: result.draft, error: null };
    return { draft: null, error: `That plan was not usable (${result.error}). Adjust the description and try again.` };
  } catch {
    return { draft: null, error: "Groq returned text instead of a plan. Try again." };
  }
}
