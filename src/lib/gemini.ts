import { MAX_PHASES, MAX_TASKS_PER_PHASE, parseRoadmapDraft, type RoadmapDraft } from "@/lib/roadmap";

/**
 * Gemini roadmap generation.
 *
 * Server-only: reads GEMINI_API_KEY, which must never be NEXT_PUBLIC_-prefixed,
 * and never puts the key into an error message or a log.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const REQUEST_TIMEOUT_MS = 45_000;

export const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;

export function geminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

/**
 * The plan contract. Every rule here exists to stop the model inventing project
 * facts: it may only restate what the brief says, and must ask instead of guess.
 */
const SYSTEM_INSTRUCTION = `You are a senior technical project planner writing a delivery roadmap for a real software team.

HARD RULES
1. Use only facts stated in the brief. Never invent a client, company, person, user name, budget, price, deadline, URL, dataset, compliance requirement or technology that the brief does not name.
2. Do not invent calendar dates. If the brief states no dates, leave the plan without dates. Do not guess durations in weeks or months.
3. Do not invent metrics, team sizes, or approval steps.
4. Phases are stages of work (for example "Discovery and setup"), not feature names, and they follow one another in a buildable order.
5. Every task must be an action with a verifiable deliverable, phrased in plain English, and traceable to something in the brief.
6. Keep to ${MAX_PHASES} phases maximum and ${MAX_TASKS_PER_PHASE} tasks per phase maximum. Prefer fewer, stronger phases over padded ones.
7. If the brief is too thin to plan part of the work, do not fill the gap: add a short, specific question to "questions" instead.
8. Titles and summaries are shown to non-technical readers. No markdown, no emojis, no filler such as "as needed", "etc", or "TBD".
9. Return only the JSON object described by the response schema. No prose before or after it.`;

const RESPONSE_SCHEMA = {
  type: "object",
  required: ["phases", "questions"],
  properties: {
    phases: {
      type: "array",
      minItems: 1,
      maxItems: MAX_PHASES,
      items: {
        type: "object",
        required: ["title", "tasks"],
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          tasks: {
            type: "array",
            minItems: 0,
            maxItems: MAX_TASKS_PER_PHASE,
            items: {
              type: "object",
              required: ["title"],
              properties: {
                title: { type: "string" },
                priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
                description: { type: "string" },
              },
            },
          },
        },
      },
    },
    questions: { type: "array", items: { type: "string" } },
  },
} as const;

function describeFailure(model: string, status: number, payload: unknown) {
  const message =
    payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error: { message?: string } }).error?.message ?? "")
      : "";
  if (status === 401) return "Gemini rejected the API key. Replace GEMINI_API_KEY in the server environment.";
  if (status === 403 && /suspended|disabled/i.test(message)) {
    return "The Google Cloud project behind GEMINI_API_KEY is suspended or disabled. Create a key in an active project and replace the Vercel environment variable.";
  }
  if (status === 403 && /free tier|billing|paid tier|project unavailable/i.test(message)) {
    return "This Gemini project cannot use the free tier. Enable billing for the Google AI project, or use an API key from a project with Gemini access.";
  }
  if (status === 403) return "Gemini rejected the API key. Check that the key belongs to an active Google Cloud project and replace GEMINI_API_KEY in Vercel.";
  if (status === 404 || /not found|unsupported/i.test(message)) {
    return `Gemini has no model named "${model}" for this key. Set GEMINI_MODEL to a model your key can use (run npm run test:ai to list them).`;
  }
  if (status === 429) return "Gemini rate limit reached. Try again in a moment.";
  return message ? `Gemini: ${message.slice(0, 200)}` : `Gemini returned status ${status}.`;
}

export type RoadmapBrief = {
  projectName: string;
  description: string;
  technologies: string;
  notes: string;
};

/**
 * Asks Gemini for a roadmap draft. Returns the draft for the editor to show; it
 * is never written to the database from here.
 */
export async function generateRoadmapDraft(brief: RoadmapBrief): Promise<{ draft: RoadmapDraft | null; error: string | null }> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    return { draft: null, error: "Gemini is not connected yet. Add GEMINI_API_KEY to the server environment." };
  }
  const model = GEMINI_MODEL;

  const prompt = [
    `Project name: ${brief.projectName}`,
    `What the project is, in the team's own words:\n${brief.description}`,
    brief.technologies ? `Technologies named by the team:\n${brief.technologies}` : "Technologies: none stated.",
    brief.notes ? `Extra constraints from the team:\n${brief.notes}` : "",
    "",
    "Plan this project. Remember: nothing outside the text above may appear in the plan.",
  ]
    .filter(Boolean)
    .join("\n\n");

  let response: Response;
  try {
    response = await fetch(`${ENDPOINT}/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: "user", parts: [{ text: prompt.slice(0, 12_000) }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.35,
          topP: 0.9,
          maxOutputTokens: 4096,
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "could not be reached";
    return { draft: null, error: `Gemini ${reason}. The plan was not saved.` };
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) return { draft: null, error: describeFailure(model, response.status, payload) };

  const text = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!text) return { draft: null, error: "Gemini returned no plan. Try a more detailed description." };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { draft: null, error: "Gemini returned text instead of a plan. Try again." };
  }
  const result = parseRoadmapDraft(parsed);
  if (result.draft) return { draft: result.draft, error: null };
  return { draft: null, error: `That plan was not usable (${result.error}). Adjust the description and try again.` };
}

/** Lists the models the configured key can call; used by npm run test:ai. */
export async function listGeminiModels(): Promise<{ names: string[]; error: string | null }> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return { names: [], error: "GEMINI_API_KEY is not set." };
  const response = await fetch(`${ENDPOINT}?pageSize=200`, {
    headers: { "x-goog-api-key": key },
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!response) return { names: [], error: "Gemini could not be reached." };
  const payload = await response.json().catch(() => null);
  if (!response.ok) return { names: [], error: describeFailure(GEMINI_MODEL, response.status, payload) };
  const models = (payload as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> }).models ?? [];
  return {
    names: models.filter((entry) => entry.supportedGenerationMethods?.includes("generateContent")).map((entry) => (entry.name ?? "").replace("models/", "")),
    error: null,
  };
}
