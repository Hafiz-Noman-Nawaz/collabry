import { createAdminClient } from "@/lib/supabase/admin";
import { notifyTeam, teamMemberIds } from "@/lib/notify";
import { configuredAppUrl } from "@/lib/app-url";

type JobRow = {
  id: string;
  job_key: string;
  kind: string;
  payload: Record<string, unknown>;
  run_at: string;
  attempts: number;
  locked_at: string | null;
};

const MAX_ATTEMPTS = 5;
const LOCK_TTL_MS = 5 * 60 * 1000;
/** Jobs that reschedule themselves instead of completing. */
const RECURRING = new Set(["invitation_expiry_sweep"]);

function lockFilter(value: string | null) {
  return value ? `locked_at.eq."${value}"` : "locked_at.is.null";
}

/**
 * Inserts a job keyed by job_key. Duplicate keys are ignored, so scheduling the
 * same reminder twice never creates a second run (deduplication).
 */
export async function enqueueJob(input: { jobKey: string; kind: string; runAt: string; payload?: Record<string, unknown> }) {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("scheduled_jobs").upsert(
      { job_key: input.jobKey, kind: input.kind, run_at: input.runAt, payload: input.payload ?? {} },
      { onConflict: "job_key", ignoreDuplicates: true },
    );
    if (error) console.error("[jobs] enqueue", error.message);
    return !error;
  } catch (error) {
    console.error("[jobs] enqueue", error instanceof Error ? error.message : error);
    return false;
  }
}

async function handleMeetingReminder(job: JobRow) {
  const admin = createAdminClient();
  const meetingId = String(job.payload.meetingId ?? "");
  if (!meetingId) throw new Error("meeting_reminder payload is missing meetingId");
  const { data: meeting } = await admin
    .from("meetings")
    .select("id, team_id, title, agenda, starts_at, ends_at, timezone, status, meeting_url, created_by")
    .eq("id", meetingId)
    .maybeSingle();
  if (!meeting || meeting.status !== "scheduled") return; // cancelled or removed: nothing to remind
  if (new Date(meeting.starts_at).getTime() <= Date.now()) return; // already started
  const members = await teamMemberIds(meeting.team_id);
  // Emails need the canonical host; a reminder fired from the job runner has no request.
  const origin = configuredAppUrl();
  await notifyTeam({
    userIds: members,
    teamId: meeting.team_id,
    kind: "meeting",
    title: `Reminder: ${meeting.title}`,
    body: `Starts ${new Date(meeting.starts_at).toLocaleString()}`,
    resourceType: "meeting",
    resourceId: meeting.id,
    organizerId: meeting.created_by,
    meeting: {
      action: "reminder",
      details: {
        title: meeting.title,
        agenda: meeting.agenda,
        startsAt: meeting.starts_at,
        endsAt: meeting.ends_at,
        timezone: meeting.timezone,
        joinUrl: meeting.meeting_url,
        meetingUrl: origin ? `${origin}/meetings/${meeting.id}` : "",
      },
    },
  });
}

async function handleInvitationSweep() {
  const admin = createAdminClient();
  const { error } = await admin
    .from("invitations")
    .update({ status: "expired" })
    .eq("status", "pending")
    .lt("expires_at", new Date().toISOString());
  if (error) throw new Error(error.message);
}

const handlers: Record<string, (job: JobRow) => Promise<void>> = {
  meeting_reminder: handleMeetingReminder,
  invitation_expiry_sweep: handleInvitationSweep,
};

async function settleJob(job: JobRow, patch: Record<string, unknown>) {
  const admin = createAdminClient();
  const { error } = await admin.from("scheduled_jobs").update(patch).eq("id", job.id);
  if (error) console.error("[jobs] settle", error.message);
}

function nextRunIn(minutes: number) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

/**
 * Claims and runs every due job. Claims are optimistic (locked_at compare-and-set)
 * so overlapping callers never execute the same job twice, locks older than the
 * TTL are reclaimed after a crash, and failures retry with exponential backoff
 * before eventually parking as failed.
 */
export async function runDueJobs(limit = 10) {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const staleLock = new Date(Date.now() - LOCK_TTL_MS).toISOString();

  const { data, error } = await admin
    .from("scheduled_jobs")
    .select("id, job_key, kind, payload, run_at, attempts, locked_at")
    .lte("run_at", nowIso)
    .is("completed_at", null)
    .is("failed_at", null)
    .or(`locked_at.is.null,locked_at.lt."${staleLock}"`)
    .order("run_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);

  const results: Record<string, number> = { completed: 0, failed: 0, skipped: 0, claimed: 0 };
  for (const raw of data ?? []) {
    const job = raw as JobRow;
    const claim = await admin
      .from("scheduled_jobs")
      .update({ locked_at: new Date().toISOString() })
      .eq("id", job.id)
      .or(lockFilter(job.locked_at))
      .select("id");
    results.claimed += 1;
    if (!claim.data || claim.data.length === 0) {
      results.skipped += 1;
      continue;
    }
    const handler = handlers[job.kind];
    if (!handler) {
      await settleJob(job, { attempts: job.attempts + 1, last_error: `No handler for job kind "${job.kind}"`, locked_at: null });
      results.failed += 1;
      continue;
    }
    try {
      await handler(job);
      if (RECURRING.has(job.kind)) {
        // The job reschedules itself; only release the lock and reset counters.
        await settleJob(job, { run_at: nextRunIn(15), attempts: 0, locked_at: null, last_error: null });
      } else {
        await settleJob(job, { completed_at: new Date().toISOString(), locked_at: null });
      }
      results.completed += 1;
    } catch (error) {
      const attempts = job.attempts + 1;
      const message = error instanceof Error ? error.message : "Job failed";
      if (attempts >= MAX_ATTEMPTS) {
        await settleJob(job, { attempts, failed_at: new Date().toISOString(), last_error: message, locked_at: null });
      } else {
        await settleJob(job, { attempts, last_error: message, locked_at: null, run_at: nextRunIn(Math.min(60, 2 ** attempts)) });
      }
      results.failed += 1;
    }
  }
  return results;
}

/** Schedules the 24-hour meeting reminder when a meeting is created or moved. */
export async function scheduleMeetingReminder(meeting: { id: string; starts_at: string; status: string }) {
  if (meeting.status !== "scheduled") return;
  const remindAt = new Date(meeting.starts_at).getTime() - 24 * 60 * 60 * 1000;
  if (remindAt <= Date.now()) return;
  await enqueueJob({
    jobKey: `meeting-reminder-24h:${meeting.id}`,
    kind: "meeting_reminder",
    runAt: new Date(remindAt).toISOString(),
    payload: { meetingId: meeting.id },
  });
}

/** Ensures the recurring invitation expiry sweep exists. Safe to call often. */
export async function ensureInvitationSweep() {
  await enqueueJob({
    jobKey: "invitation-expiry-sweep",
    kind: "invitation_expiry_sweep",
    runAt: nextRunIn(5),
    payload: {},
  });
}
