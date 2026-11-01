// Verifies the Google AI (Gemini) key used for roadmap suggestions.
// Usage: node scripts/verify-gemini.mjs            -> list the models the key can reach
//        node scripts/verify-gemini.mjs --draft    -> also ask for a sample roadmap draft
// Never prints the key.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  const env = {};
  try {
    const text = readFileSync(resolve(root, ".env.local"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (match) env[match[1]] = match[2].trim();
    }
  } catch {
    // fall through to process.env
  }
  return { ...env, ...process.env };
}

const env = loadEnv();
const key = env.GEMINI_API_KEY;
const model = env.GEMINI_MODEL || "gemini-2.5-flash";

if (!key) {
  console.error("GEMINI_API_KEY is not set. Add it to .env.local (server-only, no NEXT_PUBLIC_ prefix).");
  process.exit(1);
}

const BASE = "https://generativelanguage.googleapis.com/v1beta";

async function listModels() {
  const response = await fetch(`${BASE}/models?pageSize=200`, { headers: { "x-goog-api-key": key } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    console.error(`Model list failed (HTTP ${response.status}): ${body?.error?.message ?? "no detail"}`);
    process.exit(1);
  }
  const data = await response.json();
  const usable = (data.models ?? [])
    .filter((entry) => (entry.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((entry) => entry.name.replace("models/", ""));
  console.log(`${usable.length} models accept generateContent with this key:`);
  console.log(usable.map((name) => `  ${name}${name === model ? "   <- used by the app" : ""}`).join("\n"));
  if (!usable.includes(model)) {
    console.error(`\nGEMINI_MODEL="${model}" is not reachable with this key. Set GEMINI_MODEL to one of the names above.`);
    process.exit(1);
  }
  return usable;
}

async function tryDraft() {
  const brief = {
    projectName: "Campus event tracker",
    description:
      "A final year project where students register on campus events, organisers publish them, and the department sees attendance reports. Four team members, one supervisor review every month.",
    technologies: "Next.js, Supabase, React",
  };
  const prompt = [
    "Project name: " + brief.projectName,
    "Description: " + brief.description,
    "Technologies: " + brief.technologies,
    "",
    "Return 3-5 phases with 2-4 tasks each, grounded only in the text above.",
  ].join("\n");

  const response = await fetch(`${BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: "You are a project planner. Return JSON only." }] },
      generationConfig: {
        temperature: 0.35,
        topP: 0.9,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            phases: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  title: { type: "STRING" },
                  summary: { type: "STRING" },
                  tasks: { type: "ARRAY", items: { type: "OBJECT", properties: { title: { type: "STRING" } }, required: ["title"] } },
                },
                required: ["title", "tasks"],
              },
            },
            questions: { type: "ARRAY", items: { type: "STRING" } },
          },
          required: ["phases", "questions"],
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    console.error(`Draft failed (HTTP ${response.status}): ${body?.error?.message ?? "no detail"}`);
    process.exit(1);
  }
  const data = await response.json();
  const text = (data?.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("");
  const parsed = JSON.parse(text);
  console.log(`\nSample draft from ${model}:`);
  for (const phase of parsed.phases ?? []) {
    console.log(`  ${phase.title}${phase.summary ? ` — ${phase.summary}` : ""}`);
    for (const task of phase.tasks ?? []) console.log(`     · ${task.title}`);
  }
  if ((parsed.questions ?? []).length > 0) console.log(`  Questions it asked: ${parsed.questions.join(" | ")}`);
  console.log("\nQuota used this run:", JSON.stringify(data.usageMetadata ?? {}));
}

await listModels();
if (process.argv.includes("--draft")) await tryDraft();
console.log("\nGemini key verified for roadmap suggestions.");
