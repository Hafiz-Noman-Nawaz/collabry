// Verifies that the four Supabase migrations are applied in the configured project.
// Usage: node scripts/verify-migrations.mjs
// Never prints secrets.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  const env = {};
  const text = readFileSync(resolve(root, ".env.local"), "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (match) env[match[1]] = match[2].trim();
  }
  return env;
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !serviceKey || !anonKey) {
  console.error("Missing Supabase environment variables in .env.local");
  process.exit(1);
}

const expectedTables = [
  "profiles", "teams", "team_members", "invitations", "tasks", "task_assignees",
  "meetings", "meeting_attendees", "meeting_minutes", "conversations",
  "conversation_members", "messages", "message_attachments", "project_files",
  "announcements", "notifications", "notification_preferences", "scheduled_jobs", "audit_logs",
  "task_comments", "task_checklist_items", "task_events", "task_reviews",
  "message_reactions", "meeting_action_items",
];

// Migration-5 columns the workspace screens select on; their absence used to
// pass unnoticed while every dependent API route returned 400.
const expectedColumns = [
  ["teams", "storage_quota_bytes"],
  ["project_files", "task_id"],
  ["project_files", "submission_status"],
  ["project_files", "review_note"],
  ["project_files", "reviewed_by"],
  ["project_files", "reviewed_at"],
  ["messages", "edited_at"],
  ["messages", "deleted_at"],
];

// handle_new_user is a trigger function returning `trigger`, which PostgREST
// never exposes over RPC, so it cannot be probed here; the integration test
// verifies it indirectly by creating a user and checking the auto-created profile.
const expectedFunctions = ["create_team", "accept_invitation", "accept_invitation_by_token", "is_team_member", "has_team_role", "is_conversation_member", "is_conversation_creator", "conversation_team_id"];

const serviceHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

let failures = 0;
const fail = (message) => { failures += 1; console.log(`  FAIL  ${message}`); };
const ok = (message) => console.log(`  ok    ${message}`);

// 1. Schema: use PostgREST OpenAPI to list exposed tables and RPC functions.
console.log("\nSchema (via PostgREST OpenAPI):");
const openapi = await fetch(`${url}/rest/v1/`, {
  headers: { ...serviceHeaders, Accept: "application/openapi+json" },
});
if (!openapi.ok) {
  fail(`OpenAPI request failed with HTTP ${openapi.status}`);
} else {
  const spec = await openapi.json();
  const definitions = Object.keys(spec.definitions ?? {});
  const rpcs = Object.keys(spec.paths ?? {})
    .filter((path) => path.startsWith("/rpc/"))
    .map((path) => path.slice("/rpc/".length));
  for (const table of expectedTables) {
    if (definitions.includes(table)) ok(`table ${table}`);
    else fail(`table ${table} missing (migration not applied?)`);
  }
  for (const fn of expectedFunctions) {
    if (rpcs.includes(fn)) ok(`function ${fn}`);
    else fail(`function ${fn} missing`);
  }
  for (const [table, column] of expectedColumns) {
    const properties = spec.definitions?.[table]?.properties ?? {};
    if (Object.keys(properties).includes(column)) ok(`column ${table}.${column}`);
    else fail(`column ${table}.${column} missing (workflow migration not applied?)`);
  }
}

// 2. RLS: anon requests without a session must return zero rows on protected tables.
console.log("\nRow Level Security (anon, unauthenticated):");
const anonHeaders = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
for (const table of ["teams", "tasks", "project_files", "notifications", "audit_logs"]) {
  const response = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, { headers: anonHeaders });
  if (!response.ok) {
    const body = await response.text();
    // 401/403 means the endpoint is locked down for anon; that also proves RLS/privileges block reads.
    if (response.status === 401 || response.status === 403) ok(`${table} blocked for anon (HTTP ${response.status})`);
    else fail(`${table} returned HTTP ${response.status}: ${body.slice(0, 160)}`);
    continue;
  }
  const rows = await response.json();
  if (rows.length === 0) ok(`${table} RLS hides rows from anon`);
  else fail(`${table} leaked ${rows.length} row(s) to anon`);
}

// 3. Storage buckets must exist and stay private.
console.log("\nStorage buckets:");
const bucketsResponse = await fetch(`${url}/storage/v1/bucket`, { headers: serviceHeaders });
if (!bucketsResponse.ok) {
  fail(`bucket list failed with HTTP ${bucketsResponse.status}`);
} else {
  const buckets = await bucketsResponse.json();
  const byId = new Map(buckets.map((bucket) => [bucket.id, bucket]));
  for (const id of ["project-files", "message-attachments"]) {
    const bucket = byId.get(id);
    if (!bucket) fail(`bucket ${id} missing`);
    else if (bucket.public === false) ok(`bucket ${id} is private`);
    else fail(`bucket ${id} is public`);
  }
}

console.log("\nEmail (Resend):");
const resendKey = env.RESEND_API_KEY;
const resendFrom = env.RESEND_FROM_EMAIL;
if (!resendKey || !resendFrom) {
  console.log("  skip  RESEND_API_KEY or RESEND_FROM_EMAIL is not set (invitations still work via shareable links)");
} else {
  try {
    const resend = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${resendKey}` },
    });
    if (resend.ok) ok("Resend API accepted the configured key");
    else if (resend.status === 401 || resend.status === 403) fail("Resend API key was rejected");
    else fail(`Resend probe returned HTTP ${resend.status}`);
  } catch {
    fail("Resend probe unreachable (network or DNS error)");
  }
}

console.log(failures === 0 ? "\nAll migration checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
