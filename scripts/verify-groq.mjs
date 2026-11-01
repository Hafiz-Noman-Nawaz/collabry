// Verifies the Groq key used for roadmap suggestions.
// Usage: node scripts/verify-groq.mjs [--draft]
// Never prints the key.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = {};
try {
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (match) env[match[1]] = match[2].trim();
  }
} catch {
  // Use process.env when no local file exists.
}
Object.assign(env, process.env);

const key = env.GROQ_API_KEY;
const model = env.GROQ_MODEL || "openai/gpt-oss-120b";
if (!key) {
  console.error("GROQ_API_KEY is not set. Add it to .env.local (server-only, no NEXT_PUBLIC_ prefix).");
  process.exit(1);
}

const response = await fetch("https://api.groq.com/openai/v1/models", {
  headers: { Authorization: `Bearer ${key}` },
});
if (!response.ok) {
  const body = await response.json().catch(() => ({}));
  console.error(`Model list failed (HTTP ${response.status}): ${body?.error?.message ?? "no detail"}`);
  process.exit(1);
}

const data = await response.json();
const models = (data.data ?? []).map((entry) => entry.id).filter(Boolean);
console.log(`${models.length} models are available with this key:`);
console.log(models.map((name) => `  ${name}${name === model ? "   <- used by the app" : ""}`).join("\n"));
if (!models.includes(model)) {
  console.error(`\nGROQ_MODEL="${model}" is not available with this key.`);
  process.exit(1);
}

if (process.argv.includes("--draft")) {
  const draftResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "Return JSON only with phases and questions. Do not invent facts." },
        { role: "user", content: "Plan a campus event tracker built with Next.js, Supabase, and React. Return 3 phases with 2 tasks each." },
      ],
      response_format: { type: "json_object" },
      temperature: 0.35,
      max_tokens: 2048,
    }),
  });
  const result = await draftResponse.json().catch(() => ({}));
  if (!draftResponse.ok) {
    console.error(`Draft failed (HTTP ${draftResponse.status}): ${result?.error?.message ?? "no detail"}`);
    process.exit(1);
  }
  console.log(`\nSample roadmap draft generated successfully with ${model}.`);
}

console.log("\nGroq key verified for roadmap suggestions.");
