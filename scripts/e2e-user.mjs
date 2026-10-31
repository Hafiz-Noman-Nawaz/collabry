// Creates one confirmed throwaway user for browser-based smoke testing and
// writes its credentials to .next/e2e-credentials.json (build dir, gitignored).
// Delete the user afterwards with: node scripts/e2e-user.mjs remove
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const credsPath = resolve(root, ".next", "e2e-credentials.json");

function loadEnv() {
  const env = {};
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (match) env[match[1]] = match[2].trim();
  }
  return env;
}

const env = loadEnv();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

if (process.argv[2] === "remove") {
  const creds = JSON.parse(readFileSync(credsPath, "utf8"));
  const { error } = await admin.auth.admin.deleteUser(creds.userId);
  if (error) {
    console.error("Delete failed:", error.message);
    process.exit(1);
  }
  rmSync(credsPath);
  console.log("E2E test user deleted and credentials file removed.");
} else {
  const email = `collabry-e2e-${Date.now().toString(36)}@example.com`;
  const password = `Collabry!E2E-${randomUUID().slice(0, 8)}`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "E2E Smoke Tester" },
  });
  if (error) {
    console.error("Create failed:", error.message);
    process.exit(1);
  }
  writeFileSync(credsPath, JSON.stringify({ email, password, userId: data.user.id }, null, 2));
  console.log("E2E test user created; credentials written to .next/e2e-credentials.json");
}
