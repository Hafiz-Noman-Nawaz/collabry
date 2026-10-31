// Authenticated integration tests for Collabry.
//
// Usage:
//   npm run build            (the harness boots `next start` itself)
//   npm run test:integration
//
// Optional: BASE_URL=http://localhost:3000 npm run test:integration
// to run against an already-running server instead.
//
// The suite creates three throwaway users in the configured Supabase project,
// exercises the real API routes with real RLS, then deletes everything it made.
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { createClient as createServiceClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.TEST_PORT ?? 3311);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const RUN_ID = Date.now().toString(36);
const PASSWORD = `Collabry!Test-${randomUUID().slice(0, 8)}`;

function loadEnv() {
  const env = {};
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (match) env[match[1]] = match[2].trim();
  }
  return env;
}

const env = loadEnv();
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing Supabase environment variables in .env.local");
  process.exit(1);
}

const admin = createServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let passed = 0;
const failures = [];
function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A real Supabase session whose cookies are replayed against the Next server. */
function createSession() {
  const jar = new Map();
  const client = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => [...jar.entries()].map(([ name, value ]) => ({ name, value })),
      setAll: (cookies) => {
        for (const cookie of cookies) jar.set(cookie.name, cookie.value);
      },
    },
  });
  const cookieHeader = () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  const api = async (path, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    headers.set("Cookie", cookieHeader());
    if (init.body && typeof init.body === "string") headers.set("Content-Type", "application/json");
    return fetch(`${BASE_URL}${path}`, { ...init, headers });
  };
  return { client, cookieHeader, api };
}

async function createUser(label) {
  const email = `collabry-it-${label}-${RUN_ID}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: `Integration ${label}` },
  });
  if (error) throw new Error(`Unable to create user ${label}: ${error.message}`);
  return { email, id: data.user.id };
}

const createdUsers = [];
const createdTeams = [];

async function signIn(session, email) {
  const { error } = await session.client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`Sign in failed for ${email}: ${error.message}`);
}

async function waitForServer(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/login`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not become ready at ${BASE_URL}`);
}

async function cleanup() {
  // Storage objects first, then team rows (which cascade to tasks, files,
  // meetings and conversations), then the users themselves.
  for (const teamId of createdTeams) {
    const { data: files } = await admin.from("project_files").select("storage_path").eq("team_id", teamId);
    if (files?.length) await admin.storage.from("project-files").remove(files.map((row) => row.storage_path));
    await admin.from("teams").delete().eq("id", teamId);
  }
  for (const user of createdUsers) {
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) console.error(`  cleanup: could not delete ${user.email}: ${error.message}`);
  }
}

async function main() {
  let server = null;
  if (!process.env.BASE_URL) {
    if (!existsSync(resolve(root, ".next"))) {
      console.error("No .next build found. Run `npm run build` first.");
      process.exit(1);
    }
    server = spawn("npx", ["next", "start", "-p", String(PORT)], {
      cwd: root,
      stdio: "ignore",
      env: { ...process.env },
      shell: process.platform === "win32",
    });
  }

  try {
    await waitForServer();
    console.log(`\nRunning Collabry integration tests against ${BASE_URL}\n`);

    // --- Users and the signup trigger -------------------------------------
    console.log("Accounts:");
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const carol = await createUser("carol");
    createdUsers.push(alice, bob, carol);

    const { data: aliceProfile } = await admin.from("profiles").select("id, full_name").eq("id", alice.id).maybeSingle();
    const { data: bobProfile } = await admin.from("profiles").select("id").eq("id", bob.id).maybeSingle();
    check("signup trigger creates a profile for user A", !!aliceProfile);
    check("signup trigger creates a profile for user B", !!bobProfile);

    const sessionA = createSession();
    const sessionB = createSession();
    const sessionC = createSession();
    await signIn(sessionA, alice.email);
    await signIn(sessionB, bob.email);
    await signIn(sessionC, carol.email);
    check("both users sign in with real sessions", true);

    // --- Two separate projects --------------------------------------------
    console.log("\nProject creation:");
    const { data: teamAData, error: teamAError } = await sessionA.client.rpc("create_team", {
      team_name: `Alpha ${RUN_ID}`,
      team_description: "Integration test project A",
      team_category: "testing",
    });
    check("user A creates a project", !teamAError && !!teamAData, teamAError?.message);
    const teamA = teamAData?.id;
    createdTeams.push(teamA);

    const { data: teamBData } = await sessionB.client.rpc("create_team", {
      team_name: `Bravo ${RUN_ID}`,
      team_description: "Integration test project B",
    });
    const teamB = teamBData?.id;
    createdTeams.push(teamB);
    check("user B creates a separate project", !!teamB);

    const { data: ownerMembership } = await admin
      .from("team_members")
      .select("role")
      .eq("team_id", teamA)
      .eq("user_id", alice.id)
      .maybeSingle();
    check("project creation grants owner membership", ownerMembership?.role === "owner");

    // --- Cross-team isolation ---------------------------------------------
    console.log("\nCross-team isolation (B against A's project):");
    const tasksAsB = await sessionB.api(`/api/tasks?teamId=${teamA}`);
    const tasksBody = await tasksAsB.json();
    check("B sees no tasks from A's project", tasksAsB.ok && (tasksBody.tasks ?? []).length === 0, JSON.stringify(tasksBody).slice(0, 120));

    const createTaskAsB = await sessionB.api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ teamId: teamA, title: "Injected task" }),
    });
    check("B cannot create a task in A's project", !createTaskAsB.ok, `status ${createTaskAsB.status}`);

    const membersAsB = await sessionB.api(`/api/members?teamId=${teamA}`);
    const membersBody = await membersAsB.json();
    check("B sees no members of A's project", membersAsB.ok && (membersBody.members ?? []).length === 0);

    const roleChangeAsB = await sessionB.api("/api/members", {
      method: "PATCH",
      body: JSON.stringify({ teamId: teamA, userId: bob.id, role: "owner" }),
    });
    check("B cannot change roles in A's project", !roleChangeAsB.ok, `status ${roleChangeAsB.status}`);

    const teamsAsB = await sessionB.api("/api/teams");
    const teamsBody = await teamsAsB.json();
    check("B's project list excludes A's project", (teamsBody.teams ?? []).every((team) => team.id !== teamA));

    const reportsAsB = await sessionB.api(`/api/reports?teamId=${teamA}`);
    const reportsBody = await reportsAsB.json();
    check("B's report of A's project shows zero tasks", reportsAsB.ok && reportsBody.tasks?.total === 0);

    const { data: directTasks } = await sessionB.client.from("tasks").select("id").eq("team_id", teamA);
    check("RLS hides A's tasks from B's direct query", (directTasks ?? []).length === 0);

    const { data: directUpdate } = await sessionB.client.from("tasks").update({ title: "hijacked" }).eq("team_id", teamA).select("id");
    check("RLS blocks B updating A's tasks", (directUpdate ?? []).length === 0);

    const { data: directAudit } = await sessionB.client.from("audit_logs").select("id").limit(1);
    check("audit logs are hidden from non-managers", (directAudit ?? []).length === 0);

    // --- Private files -----------------------------------------------------
    console.log("\nPrivate files:");
    const uploadForm = new FormData();
    uploadForm.set("teamId", teamA);
    uploadForm.set("category", "research");
    uploadForm.set("file", new File(["integration test payload"], "integration-test.txt", { type: "text/plain" }));
    const uploadResponse = await sessionA.api("/api/files", { method: "POST", body: uploadForm });
    const uploadBody = await uploadResponse.json();
    check("A uploads a private file", uploadResponse.status === 201 && !!uploadBody.file?.id, JSON.stringify(uploadBody).slice(0, 160));
    const fileId = uploadBody.file?.id;
    check("upload reports storage usage", !!uploadBody.usage && typeof uploadBody.usage.usedBytes === "number");

    const signedAsB = fileId ? await sessionB.api(`/api/files/${fileId}`) : null;
    if (signedAsB) check("B cannot sign a download before joining", signedAsB.status === 404, `status ${signedAsB.status}`);

    const badForm = new FormData();
    badForm.set("teamId", teamA);
    badForm.set("file", new File(["MZ"], "setup.exe", { type: "application/x-msdownload" }));
    const badUpload = await sessionA.api("/api/files", { method: "POST", body: badForm });
    check("unsupported file types are rejected", badUpload.status === 415, `status ${badUpload.status}`);

    // --- Invitations -------------------------------------------------------
    console.log("\nInvitations:");
    const inviteResponse = await sessionA.api("/api/invitations", {
      method: "POST",
      body: JSON.stringify({ teamId: teamA, email: bob.email, role: "member" }),
    });
    const inviteBody = await inviteResponse.json();
    check("A invites B", inviteResponse.status === 201, JSON.stringify(inviteBody).slice(0, 160));
    const token = inviteBody.inviteUrl?.split("/invite/")[1];

    if (token) {
      const wrongRecipient = await sessionC.api("/api/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      check("wrong recipient cannot accept B's invitation", !wrongRecipient.ok, `status ${wrongRecipient.status}`);

      const accept = await sessionB.api("/api/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      check("B accepts the invitation", accept.ok, `status ${accept.status}`);

      const repeat = await sessionB.api("/api/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      check("a consumed invitation cannot be replayed", !repeat.ok, `status ${repeat.status}`);

      const membersAfter = await sessionB.api(`/api/members?teamId=${teamA}`);
      const membersAfterBody = await membersAfter.json();
      check("B now appears in A's member directory", (membersAfterBody.members ?? []).length === 2);

      const signedAfter = fileId ? await sessionB.api(`/api/files/${fileId}`) : null;
      if (signedAfter) {
        const signedAfterBody = await signedAfter.json();
        check("B can sign a download after joining", signedAfter.ok && signedAfterBody.expiresIn === 300, JSON.stringify(signedAfterBody).slice(0, 120));
      }
    }

    const inviteTwo = await sessionA.api("/api/invitations", {
      method: "POST",
      body: JSON.stringify({ teamId: teamA, email: carol.email, role: "reviewer" }),
    });
    const inviteTwoBody = await inviteTwo.json();
    const carolToken = inviteTwoBody.inviteUrl?.split("/invite/")[1];
    if (carolToken) {
      const { data: rows } = await admin
        .from("invitations")
        .select("id")
        .eq("team_id", teamA)
        .eq("invitee_email", carol.email)
        .order("created_at", { ascending: false })
        .limit(1);
      const invitationId = rows?.[0]?.id;
      if (invitationId) {
        await admin.from("invitations").update({ expires_at: new Date(Date.now() - 60000).toISOString() }).eq("id", invitationId);
        const expired = await sessionC.api("/api/invitations/accept", { method: "POST", body: JSON.stringify({ token: carolToken }) });
        check("an expired invitation is rejected", !expired.ok, `status ${expired.status}`);

        await admin.from("invitations").update({ status: "revoked", expires_at: new Date(Date.now() + 3600000).toISOString() }).eq("id", invitationId);
        const revoked = await sessionC.api("/api/invitations/accept", { method: "POST", body: JSON.stringify({ token: carolToken }) });
        check("a revoked invitation is rejected", !revoked.ok, `status ${revoked.status}`);
      }
      check("invitation lookup succeeded", !!invitationId);
    }

    // --- Rate limiting -----------------------------------------------------
    console.log("\nRate limiting:");
    let sawLimit = false;
    let limitStatus = 0;
    for (let index = 0; index < 14 && !sawLimit; index += 1) {
      const response = await sessionA.api("/api/invitations", {
        method: "POST",
        body: JSON.stringify({ teamId: teamA, email: `nobody-${index}-${RUN_ID}@example.com`, role: "member" }),
      });
      limitStatus = response.status;
      if (response.status === 429) sawLimit = true;
    }
    check("invitation endpoint enforces a rate limit", sawLimit, `last status ${limitStatus}`);

    // --- Audit log ---------------------------------------------------------
    console.log("\nAudit trail:");
    const { data: auditRows } = await admin
      .from("audit_logs")
      .select("action, resource_type, actor_id")
      .eq("team_id", teamA);
    const actions = new Set((auditRows ?? []).map((row) => row.action));
    check("invitation creation was audited", actions.has("invitation.created"));
    check("file upload was audited", actions.has("file.uploaded"));
    const { data: auditAsB } = await sessionB.client.from("audit_logs").select("id").eq("team_id", teamA).limit(1);
    check("B still cannot read A's audit trail", (auditAsB ?? []).length === 0);

    // --- Team chat (RLS recursion regression) --------------------------------
    // These routes query conversations with embedded conversation_members and
    // messages, the shape that previously failed with "infinite recursion
    // detected in policy for relation conversation_members".
    console.log("\nTeam chat:");
    const createConversation = await sessionA.api("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ teamId: teamA, title: `Thesis sync ${RUN_ID}`, isGroup: true, memberIds: [bob.id] }),
    });
    const conversationBody = await createConversation.json();
    const conversationId = conversationBody.conversation?.id;
    check("A creates a conversation with B", createConversation.status === 201 && !!conversationId, JSON.stringify(conversationBody).slice(0, 160));

    if (conversationId) {
      const listAsA = await sessionA.api(`/api/conversations?teamId=${teamA}`);
      const listAsABody = await listAsA.json();
      const seenByA = (listAsABody.conversations ?? []).some((row) => row.id === conversationId);
      check("A loads the conversation list without an RLS error", listAsA.ok && seenByA, JSON.stringify(listAsABody).slice(0, 160));

      const membersAsA = await sessionA.api(`/api/conversations/${conversationId}/members`);
      const membersBody = await membersAsA.json();
      check("the creator is stored with every requested member", membersAsA.ok && (membersBody.members ?? []).length === 2, JSON.stringify(membersBody).slice(0, 160));

      const listAsB = await sessionB.api(`/api/conversations?teamId=${teamA}`);
      const listAsBBody = await listAsB.json();
      check("B sees the conversation they were added to", listAsB.ok && (listAsBBody.conversations ?? []).some((row) => row.id === conversationId));

      const listAsC = await sessionC.api(`/api/conversations?teamId=${teamA}`);
      const listAsCBody = await listAsC.json();
      check("non-member C sees no conversations from A's project", listAsC.ok && (listAsCBody.conversations ?? []).length === 0, JSON.stringify(listAsCBody).slice(0, 160));

      const sendMessage = await sessionA.api("/api/messages", {
        method: "POST",
        body: JSON.stringify({ conversationId, body: "Please review the literature outline." }),
      });
      const messageBody = await sendMessage.json();
      const messageId = messageBody.message?.id;
      check("A sends a message", sendMessage.status === 201 && !!messageId, JSON.stringify(messageBody).slice(0, 160));

      const readAsB = await sessionB.api(`/api/messages?conversationId=${conversationId}&limit=50&offset=0`);
      const readAsBBody = await readAsB.json();
      check("B reads the message with sender profile attached", readAsB.ok && (readAsBBody.messages ?? []).length === 1 && !!readAsBBody.messages?.[0]?.profiles?.full_name, JSON.stringify(readAsBBody).slice(0, 160));

      const readAsC = await sessionC.api(`/api/messages?conversationId=${conversationId}&limit=50&offset=0`);
      const readAsCBody = await readAsC.json();
      check("non-member C reads zero messages from that conversation", readAsC.ok && (readAsCBody.messages ?? []).length === 0, JSON.stringify(readAsCBody).slice(0, 160));

      if (messageId) {
        const reactAsB = await sessionB.api(`/api/messages/${messageId}/reactions`, {
          method: "POST",
          body: JSON.stringify({ emoji: "👍" }),
        });
        check("B reacts to the message", reactAsB.status === 201, `status ${reactAsB.status}`);

        const reactAsC = await sessionC.api(`/api/messages/${messageId}/reactions`, {
          method: "POST",
          body: JSON.stringify({ emoji: "🎉" }),
        });
        check("non-member C cannot react inside that conversation", !reactAsC.ok, `status ${reactAsC.status}`);

        const reactionsBody = await (await sessionA.api(`/api/messages/${messageId}/reactions`)).json();
        check("the reaction is visible to conversation members", (reactionsBody.reactions ?? []).length === 1, JSON.stringify(reactionsBody).slice(0, 160));
      }

      const rejoinSelf = await sessionA.api(`/api/conversations/${conversationId}/members`, {
        method: "POST",
        body: JSON.stringify({ userId: alice.id }),
      });
      check("the creator re-adding themselves does not hit an RLS error", rejoinSelf.ok, `status ${rejoinSelf.status}`);

      const addByNonCreator = await sessionB.api(`/api/conversations/${conversationId}/members`, {
        method: "POST",
        body: JSON.stringify({ userId: carol.id }),
      });
      check("a plain member cannot add members", !addByNonCreator.ok, `status ${addByNonCreator.status}`);
    }

    // --- Task and meeting detail screens -------------------------------------
    // These endpoints back /tasks/[id] and /meetings/[id]. Their rules are
    // per-row rather than per-team (comment authors, reviewer roles, action
    // item assignees), so a single-signed-in smoke test cannot prove them.
    console.log("\nTask detail endpoints:");
    const createTask = await sessionA.api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ teamId: teamA, title: `Rewrite methodology chapter ${RUN_ID}`, description: "Two pages of methods.", assigneeIds: [bob.id] }),
    });
    const createdTaskBody = await createTask.json();
    const taskId = createdTaskBody.task?.id;
    check("A creates a task assigned to B", createTask.status === 201 && !!taskId, JSON.stringify(createdTaskBody).slice(0, 160));

    if (taskId) {
      const taskAsC = await sessionC.api(`/api/tasks/${taskId}`);
      check("non-member C cannot open the task detail", taskAsC.status === 404, `status ${taskAsC.status}`);

      const taskAsB = await sessionB.api(`/api/tasks/${taskId}`);
      const taskAsBBody = await taskAsB.json();
      const assigneeName = taskAsBBody.task?.task_assignees?.[0]?.profiles?.full_name ?? "";
      check(
        "the assignee opens the task with member names attached",
        taskAsB.ok && assigneeName.startsWith("Integration"),
        JSON.stringify(taskAsBBody.task?.task_assignees ?? []).slice(0, 160),
      );

      const checklistAsB = await sessionB.api(`/api/tasks/${taskId}/checklist`, { method: "POST", body: JSON.stringify({ body: "Draft the outline" }) });
      const checklistBody = await checklistAsB.json();
      check("a project member adds a checklist step", checklistAsB.status === 201 && !!checklistBody.item?.id, JSON.stringify(checklistBody).slice(0, 160));

      const checklistAsC = await sessionC.api(`/api/tasks/${taskId}/checklist`, { method: "POST", body: JSON.stringify({ body: "Injected step" }) });
      check("non-member C cannot add a checklist step", !checklistAsC.ok, `status ${checklistAsC.status}`);

      if (checklistBody.item?.id) {
        const toggleAsB = await sessionB.api(`/api/tasks/${taskId}/checklist`, { method: "PATCH", body: JSON.stringify({ id: checklistBody.item.id, done: true }) });
        const toggleBody = await toggleAsB.json();
        check("the member marks their own step done", toggleAsB.ok && toggleBody.item?.done === true, JSON.stringify(toggleBody).slice(0, 160));
      }

      const commentAsB = await sessionB.api(`/api/tasks/${taskId}/comments`, { method: "POST", body: JSON.stringify({ body: "Outline is ready for feedback." }) });
      const commentBody = await commentAsB.json();
      const commentId = commentBody.comment?.id;
      check("B posts a comment with the author profile attached", commentAsB.status === 201 && !!commentId && !!commentBody.comment?.profiles?.full_name, JSON.stringify(commentBody).slice(0, 160));

      if (commentId) {
        const editAsOwner = await sessionA.api(`/api/tasks/${taskId}/comments`, {
          method: "PATCH",
          body: JSON.stringify({ id: commentId, body: "Rewritten by the project owner" }),
        });
        check("the project owner cannot rewrite B's comment", editAsOwner.status === 404, `status ${editAsOwner.status}`);

        const editAsAuthor = await sessionB.api(`/api/tasks/${taskId}/comments`, {
          method: "PATCH",
          body: JSON.stringify({ id: commentId, body: "Outline is ready, with a timeline." }),
        });
        check("the author edits their own comment", editAsAuthor.ok, `status ${editAsAuthor.status}`);
      }

      const reviewAsMember = await sessionB.api(`/api/tasks/${taskId}/reviews`, { method: "POST", body: JSON.stringify({ state: "approved", body: "Self-approved" }) });
      check("a plain member cannot record a review", reviewAsMember.status === 403, `status ${reviewAsMember.status}`);

      const reviewAsOutsider = await sessionC.api(`/api/tasks/${taskId}/reviews`, { method: "POST", body: JSON.stringify({ state: "approved", body: "Outsider" }) });
      check("non-member C cannot record a review", !reviewAsOutsider.ok, `status ${reviewAsOutsider.status}`);

      await sessionA.api(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify({ status: "in_review" }) });
      const reviewAsOwner = await sessionA.api(`/api/tasks/${taskId}/reviews`, { method: "POST", body: JSON.stringify({ state: "approved", body: "Looks complete." }) });
      check("the owner records an approval", reviewAsOwner.status === 201, `status ${reviewAsOwner.status}`);

      const afterReviewBody = await (await sessionA.api(`/api/tasks/${taskId}`)).json();
      const statusEvent = (afterReviewBody.task?.task_events ?? []).some((row) => row.from_value === "in_review" && row.to_value === "completed");
      check("an approval on a task awaiting review completes it", afterReviewBody.task?.status === "completed", `status ${afterReviewBody.task?.status}`);
      check("the automatic completion is recorded in the activity trail", statusEvent, JSON.stringify(afterReviewBody.task?.task_events ?? []).slice(0, 160));
    }

    console.log("\nMeeting detail endpoints:");
    const startsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const endsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 3_600_000).toISOString();
    const createMeeting = await sessionA.api("/api/meetings", {
      method: "POST",
      body: JSON.stringify({ teamId: teamA, title: `Methodology sync ${RUN_ID}`, startsAt, endsAt, timezone: "UTC", attendeeIds: [bob.id] }),
    });
    const createdMeetingBody = await createMeeting.json();
    const meetingId = createdMeetingBody.meeting?.id;
    check("A schedules a meeting with B invited", createMeeting.status === 201 && !!meetingId, JSON.stringify(createdMeetingBody).slice(0, 160));

    if (meetingId) {
      const meetingAsC = await sessionC.api(`/api/meetings/${meetingId}`);
      check("non-member C cannot open the meeting detail", !meetingAsC.ok, `status ${meetingAsC.status}`);

      const rsvpAsB = await sessionB.api(`/api/meetings/${meetingId}/attendees`, { method: "POST", body: JSON.stringify({ rsvp: "accepted" }) });
      const rsvpBody = await rsvpAsB.json();
      check("B answers the invitation with an RSVP", rsvpAsB.ok && rsvpBody.attendee?.rsvp === "accepted", JSON.stringify(rsvpBody).slice(0, 160));

      const minutesAsMember = await sessionB.api(`/api/meetings/${meetingId}/minutes`, { method: "PUT", body: JSON.stringify({ body: "Written by a member", decisions: "" }) });
      check("a plain member cannot record minutes", minutesAsMember.status === 403, `status ${minutesAsMember.status}`);

      const minutesAsOwner = await sessionA.api(`/api/meetings/${meetingId}/minutes`, {
        method: "PUT",
        body: JSON.stringify({ body: "Defence format agreed.", decisions: "Use the mixed-methods design." }),
      });
      check("the owner records minutes", minutesAsOwner.ok, `status ${minutesAsOwner.status}`);

      const meetingDetailBody = await (await sessionB.api(`/api/meetings/${meetingId}`)).json();
      const minutesRow = Array.isArray(meetingDetailBody.meeting?.meeting_minutes)
        ? meetingDetailBody.meeting.meeting_minutes[0]
        : meetingDetailBody.meeting?.meeting_minutes;
      check(
        "attendees read the minutes with the author's name",
        minutesRow?.decisions === "Use the mixed-methods design." && !!meetingDetailBody.meeting?.profiles?.full_name,
        JSON.stringify(meetingDetailBody.meeting?.meeting_minutes).slice(0, 160),
      );

      const itemAsOwner = await sessionA.api(`/api/meetings/${meetingId}/action-items`, {
        method: "POST",
        body: JSON.stringify({ title: "Send the revised outline", assigneeId: bob.id, taskId: taskId ?? null }),
      });
      const itemAsOwnerBody = await itemAsOwner.json();
      const actionItemId = itemAsOwnerBody.item?.id;
      check("the owner adds an action item for B, linked to the task", itemAsOwner.status === 201 && itemAsOwnerBody.item?.task_id === taskId, JSON.stringify(itemAsOwnerBody).slice(0, 160));

      const itemAsMember = await sessionB.api(`/api/meetings/${meetingId}/action-items`, { method: "POST", body: JSON.stringify({ title: "Item by a member" }) });
      check("a plain member cannot add action items", itemAsMember.status === 403, `status ${itemAsMember.status}`);

      if (actionItemId) {
        const closeAsAssignee = await sessionB.api(`/api/meetings/${meetingId}/action-items`, { method: "PATCH", body: JSON.stringify({ id: actionItemId, done: true }) });
        check("the assignee closes their own action item", closeAsAssignee.ok, `status ${closeAsAssignee.status}`);

        const renameAsAssignee = await sessionB.api(`/api/meetings/${meetingId}/action-items`, { method: "PATCH", body: JSON.stringify({ id: actionItemId, title: "Renamed by the assignee" }) });
        check("the assignee cannot rename the action item", renameAsAssignee.status === 400, `status ${renameAsAssignee.status}`);

        const removeAsAssignee = await sessionB.api(`/api/meetings/${meetingId}/action-items?id=${actionItemId}`, { method: "DELETE" });
        check("the assignee cannot remove the action item", !removeAsAssignee.ok, `status ${removeAsAssignee.status}`);
      }

      const attendanceAsMember = await sessionB.api(`/api/meetings/${meetingId}/attendees`, { method: "PATCH", body: JSON.stringify({ records: [{ userId: alice.id, attended: true }] }) });
      check("a plain member cannot record attendance", attendanceAsMember.status === 403, `status ${attendanceAsMember.status}`);

      const attendanceAsOwner = await sessionA.api(`/api/meetings/${meetingId}/attendees`, { method: "PATCH", body: JSON.stringify({ records: [{ userId: bob.id, attended: true }] }) });
      const attendanceBody = await attendanceAsOwner.json();
      const bobPresent = (attendanceBody.attendees ?? []).some((row) => row.user_id === bob.id && row.attended === true);
      check("the owner marks B present", attendanceAsOwner.ok && bobPresent, JSON.stringify(attendanceBody).slice(0, 160));
    }
  } finally {
    console.log("\nCleaning up test data...");
    await cleanup();
    if (server) server.kill("SIGTERM");
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log("Failures:");
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(async (error) => {
  console.error(error);
  await cleanup();
  process.exit(1);
});
