// Unit tests for Collabry validation and authorization helpers
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

const { configuredSenderDomain, emailKeyLooksValid, isEmailConfigured, sendInvitationEmail, sendMeetingEmail } = await import("../src/lib/email.ts");
const { formatShortDate, invitationDeliveryMessage, toDateTimeInput } = await import("../src/lib/format.ts");
const {
  addDaysToField,
  describeFieldValue,
  durationMinutes,
  fieldToIso,
  formatDuration,
  formatFieldValue,
  parseFieldValue,
  shiftEndForDuration,
  startOfNextSlot,
} = await import("../src/lib/datetime-fields.ts");

const uuidSchema = z.string().uuid();
function parseUuid(value) {
  return uuidSchema.safeParse(value).success ? value : null;
}

function queryInt(url, key, fallback, max) {
  const raw = Number.parseInt(url.searchParams.get(key) ?? "", 10);
  if (!Number.isFinite(raw) || raw < 0) return fallback;
  return Math.min(raw, max);
}

const MANAGER_ROLES = ["owner", "supervisor", "leader"];
const INVITER_ROLES = ["owner", "leader"];
const REVIEWER_ROLES = ["owner", "supervisor", "leader", "reviewer"];

function hasRole(role, allowed) {
  return !!role && allowed.includes(role);
}

// In-memory rate limiter testing
function createRateLimiter() {
  const store = new Map();
  return function rateLimit(key, limit, windowMs) {
    const now = Date.now();
    const bucket = store.get(key);
    if (!bucket || bucket.resetAt <= now) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return { ok: true, remaining: limit - 1 };
    }
    if (bucket.count >= limit) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    }
    bucket.count += 1;
    return { ok: true, remaining: limit - bucket.count };
  };
}

test("parseUuid: valid UUIDs", () => {
  const valid = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(parseUuid(valid), valid);
});

test("parseUuid: invalid UUIDs and falsy inputs", () => {
  assert.equal(parseUuid("invalid-uuid"), null);
  assert.equal(parseUuid(""), null);
  assert.equal(parseUuid(null), null);
  assert.equal(parseUuid(undefined), null);
  assert.equal(parseUuid("12345"), null);
});

test("queryInt: parses valid positive integers within bounds", () => {
  const url = new URL("http://localhost?limit=25&offset=50&negative=-5&bad=abc");
  assert.equal(queryInt(url, "limit", 10, 100), 25);
  assert.equal(queryInt(url, "offset", 0, 1000), 50);
});

test("queryInt: clamps to maximum value", () => {
  const url = new URL("http://localhost?limit=500");
  assert.equal(queryInt(url, "limit", 10, 100), 100);
});

test("queryInt: uses fallback for invalid, negative, or missing keys", () => {
  const url = new URL("http://localhost?negative=-5&bad=abc");
  assert.equal(queryInt(url, "negative", 20, 100), 20);
  assert.equal(queryInt(url, "bad", 20, 100), 20);
  assert.equal(queryInt(url, "missing", 15, 100), 15);
});

test("hasRole: validates roles correctly against permission sets", () => {
  assert.equal(hasRole("owner", MANAGER_ROLES), true);
  assert.equal(hasRole("supervisor", MANAGER_ROLES), true);
  assert.equal(hasRole("leader", MANAGER_ROLES), true);
  assert.equal(hasRole("member", MANAGER_ROLES), false);
  assert.equal(hasRole("reviewer", MANAGER_ROLES), false);

  assert.equal(hasRole("owner", INVITER_ROLES), true);
  assert.equal(hasRole("leader", INVITER_ROLES), true);
  assert.equal(hasRole("supervisor", INVITER_ROLES), false);

  assert.equal(hasRole("reviewer", REVIEWER_ROLES), true);
  assert.equal(hasRole("member", REVIEWER_ROLES), false);

  assert.equal(hasRole(null, MANAGER_ROLES), false);
  assert.equal(hasRole(undefined, MANAGER_ROLES), false);
  assert.equal(hasRole("unknown", MANAGER_ROLES), false);
});

test("rateLimit: enforces request quotas within time windows", () => {
  const rateLimit = createRateLimiter();
  const key = "user-123";

  // Limit 3 requests
  const r1 = rateLimit(key, 3, 60000);
  assert.equal(r1.ok, true);
  assert.equal(r1.remaining, 2);

  const r2 = rateLimit(key, 3, 60000);
  assert.equal(r2.ok, true);
  assert.equal(r2.remaining, 1);

  const r3 = rateLimit(key, 3, 60000);
  assert.equal(r3.ok, true);
  assert.equal(r3.remaining, 0);

  const r4 = rateLimit(key, 3, 60000);
  assert.equal(r4.ok, false);
  assert.ok(r4.retryAfterSeconds > 0);
});

/** Runs a function with a stubbed Resend endpoint and the env vars it reads. */
async function withEmailEnv(env, response, run) {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  const requests = [];
  for (const key of ["RESEND_API_KEY", "RESEND_FROM_EMAIL"]) delete process.env[key];
  Object.assign(process.env, env);
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = realFetch;
    for (const key of ["RESEND_API_KEY", "RESEND_FROM_EMAIL"]) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

const MEETING = {
  title: "Weekly <progress> sync",
  agenda: "Draft review & next steps",
  startsAt: "2026-11-06T10:00:00Z",
  endsAt: "2026-11-06T11:00:00Z",
  timezone: "Asia/Karachi",
  joinUrl: "https://meet.example.com/room-9",
  meetingUrl: "https://collabryy.tech/meetings/abc",
};

test("configuredSenderDomain: reads the domain from both sender formats", () => {
  const saved = process.env.RESEND_FROM_EMAIL;
  process.env.RESEND_FROM_EMAIL = "Collabry <notifications@mail.collabryy.tech>";
  assert.equal(configuredSenderDomain(), "mail.collabryy.tech");
  process.env.RESEND_FROM_EMAIL = "alerts@collabryy.tech";
  assert.equal(configuredSenderDomain(), "collabryy.tech");
  process.env.RESEND_FROM_EMAIL = "not an address";
  assert.equal(configuredSenderDomain(), null);
  if (saved === undefined) delete process.env.RESEND_FROM_EMAIL;
  else process.env.RESEND_FROM_EMAIL = saved;
});

test("isEmailConfigured: false when the key or sender is missing", async () => {
  await withEmailEnv({ RESEND_API_KEY: "k" }, { status: 200 }, () => {
    assert.equal(isEmailConfigured(), false);
  });
  await withEmailEnv({ RESEND_FROM_EMAIL: "a@b.co" }, { status: 200 }, () => {
    assert.equal(isEmailConfigured(), false);
  });
  await withEmailEnv({ RESEND_API_KEY: "k", RESEND_FROM_EMAIL: "a@b.co" }, { status: 200 }, () => {
    assert.equal(isEmailConfigured(), true);
  });
});

test("emailKeyLooksValid: only Resend-shaped keys are worth probing", async () => {
  await withEmailEnv({ RESEND_API_KEY: "integration-suite-sandbox-key" }, { status: 200 }, () => {
    assert.equal(emailKeyLooksValid(), false);
  });
  await withEmailEnv({ RESEND_API_KEY: `re_${"a".repeat(36)}` }, { status: 200 }, () => {
    assert.equal(emailKeyLooksValid(), true);
  });
  await withEmailEnv({ RESEND_API_KEY: "" }, { status: 200 }, () => {
    assert.equal(emailKeyLooksValid(), false);
  });
});

test("sendInvitationEmail: reports configuration instead of failing silently", async () => {
  const { result, requests } = await withEmailEnv({}, { status: 200 }, async (all) => ({
    result: await sendInvitationEmail({ to: "dev@umt.edu.pk", teamName: "Grad Project", inviteUrl: "https://collabryy.tech/invite/t", role: "member" }),
    requests: all,
  }));
  assert.equal(result.sent, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /not configured/i);
  assert.equal(requests.length, 0);
});

test("sendInvitationEmail: turns an unverified sender into actionable wording", async () => {
  const result = await withEmailEnv(
    { RESEND_API_KEY: "k", RESEND_FROM_EMAIL: "Collabry <alerts@umt.edu.pk>" },
    { status: 403, body: { message: "The umt.edu.pk domain is not verified. Please, add and verify your domain on https://resend.com/domains", name: "validation_error" } },
    () => sendInvitationEmail({ to: "dev@umt.edu.pk", teamName: "Grad Project", inviteUrl: "https://collabryy.tech/invite/t", role: "supervisor" }),
  );
  assert.equal(result.sent, false);
  assert.equal(result.skipped, false);
  assert.match(result.reason, /not on a domain verified with Resend/);
});

test("sendInvitationEmail: names the API key when Resend rejects it", async () => {
  const result = await withEmailEnv(
    { RESEND_API_KEY: "revoked", RESEND_FROM_EMAIL: "Collabry <notifications@mail.collabryy.tech>" },
    { status: 400, body: { statusCode: 400, message: "API key is invalid", name: "validation_error" } },
    () => sendInvitationEmail({ to: "dev@umt.edu.pk", teamName: "Grad Project", inviteUrl: "https://collabryy.tech/invite/t", role: "member" }),
  );
  assert.match(result.reason, /rejected the API key/);
});

test("sendMeetingEmail: reports a provider that cannot be reached", async () => {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = "k";
  process.env.RESEND_FROM_EMAIL = "Collabry <notifications@mail.collabryy.tech>";
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  try {
    const result = await sendMeetingEmail({ to: "dev@umt.edu.pk", teamName: "Grad Project", action: "reminder", meeting: MEETING });
    assert.equal(result.sent, false);
    assert.match(result.reason, /could not be reached/);
  } finally {
    globalThis.fetch = realFetch;
    for (const key of ["RESEND_API_KEY", "RESEND_FROM_EMAIL"]) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("sendInvitationEmail: sends a branded invitation with the inviter named", async () => {
  const { result, requests } = await withEmailEnv(
    { RESEND_API_KEY: "k", RESEND_FROM_EMAIL: "Collabry <notifications@mail.collabryy.tech>" },
    { status: 200, body: { id: "email-1" } },
    async (all) => ({
      result: await sendInvitationEmail({
        to: "dev@umt.edu.pk",
        teamName: "Grad Project",
        inviteUrl: "https://collabryy.tech/invite/token-1",
        role: "supervisor",
        inviterName: "Nawaz",
        inviterEmail: "nawaz@collabryy.tech",
      }),
      requests: all,
    }),
  );
  assert.equal(result.sent, true);
  const payload = requests[0].body;
  assert.equal(requests[0].url, "https://api.resend.com/emails");
  assert.equal(payload.from, "Collabry <notifications@mail.collabryy.tech>");
  assert.equal(payload.reply_to, "nawaz@collabryy.tech");
  assert.equal(payload.subject, "Nawaz invited you to join Grad Project on Collabry");
  assert.match(payload.html, /Accept invitation/);
  assert.match(payload.html, /Supervisor/);
  assert.match(payload.text, /https:\/\/collabryy\.tech\/invite\/token-1/);
});

test("sendMeetingEmail: professional copy per action, with escaping and time zone", async () => {
  const requests = await withEmailEnv(
    { RESEND_API_KEY: "k", RESEND_FROM_EMAIL: "Collabry <notifications@mail.collabryy.tech>" },
    { status: 200, body: { id: "email-1" } },
    (all) =>
      Promise.all(
        ["scheduled", "updated", "cancelled", "added", "reminder"].map((action) =>
          sendMeetingEmail({ to: "dev@umt.edu.pk", recipientName: "Ayesha", teamName: "Grad Project", organizerName: "Nawaz", action, meeting: MEETING }).then((r) => [action, r]),
        ),
      ).then(() => all),
  );
  assert.equal(requests.length, 5);
  const subjects = requests.map((request) => request.body.subject);
  assert.match(subjects[0], /^Meeting scheduled: Weekly <progress> sync — Friday, 6 November 2026$/);
  assert.match(subjects[1], /^Meeting rescheduled:/);
  assert.match(subjects[2], /^Meeting cancelled: Weekly <progress> sync$/);
  assert.match(subjects[3], /^You've been added to/);
  assert.match(subjects[4], /^Reminder: Weekly <progress> sync starts tomorrow at/);

  const scheduled = requests[0].body;
  assert.equal(requests[2].body.html.includes("Accept invitation"), false);
  assert.equal(requests[2].body.html.includes("Open in Collabry"), false);
  assert.match(requests[2].body.html, /has been cancelled/);
  assert.match(scheduled.html, /Weekly &lt;progress&gt; sync/);
  assert.doesNotMatch(scheduled.html, /<h1[^>]*>Weekly <progress>/);
  assert.match(scheduled.html, /03:00 pm – 04:00 pm/);
  assert.match(scheduled.html, /Asia\/Karachi/);
  assert.match(scheduled.html, /Draft review &amp; next steps/);
  assert.match(scheduled.html, /https:\/\/collabryy\.tech\/meetings\/abc/);
  assert.match(scheduled.text, /Join link: https:\/\/meet\.example\.com\/room-9/);
  // Details appear once in the plain-text version.
  assert.equal(scheduled.text.split("Date: Friday, 6 November 2026").length - 1, 1);
});

test("invitationDeliveryMessage: names the real reason instead of blaming the recipient", () => {
  const link = "https://collabryy.tech/invite/abc";
  assert.match(
    invitationDeliveryMessage("dev@umt.edu.pk", { emailSent: true, inviteUrl: link }),
    /^Invitation emailed to dev@umt\.edu\.pk\./,
  );
  // A deployment with no sender must never be reported as the recipient opting out.
  const unconfigured = invitationDeliveryMessage("dev@umt.edu.pk", {
    emailSent: false,
    emailCause: "not-configured",
    emailReason: "Email is not configured on this server.",
    inviteUrl: link,
  });
  assert.match(unconfigured, /no email sender configured/);
  assert.match(unconfigured, /Email is not configured on this server\./);
  assert.doesNotMatch(unconfigured, /turns off invitation emails/);
  assert.match(invitationDeliveryMessage("dev@umt.edu.pk", { emailSent: false, emailCause: "opted-out", inviteUrl: link }), /that account turns off invitation emails/);
  assert.match(
    invitationDeliveryMessage("dev@umt.edu.pk", { emailSent: false, emailCause: "provider", emailReason: "Resend rejected the API key.", inviteUrl: link }),
    /the email was not delivered\. Resend rejected the API key\./,
  );
  // Every failure keeps the shareable link.
  for (const cause of ["not-configured", "opted-out", "provider"]) {
    assert.ok(
      invitationDeliveryMessage("dev@umt.edu.pk", { emailSent: false, emailCause: cause, inviteUrl: link }).includes(link),
      `the ${cause} message must still offer the invite link`,
    );
  }
});

test("parseFieldValue: reads wall-clock values in the local zone", () => {
  const both = parseFieldValue("2026-11-06T15:30", "datetime");
  assert.equal(both.getHours(), 15);
  assert.equal(both.getMinutes(), 30);
  // A date-only value must stay on the 6th, not slide a day in a negative-offset zone.
  const dayOnly = parseFieldValue("2026-11-06", "date");
  assert.equal(dayOnly.getDate(), 6);
  assert.equal(dayOnly.getMonth(), 10);
  assert.equal(dayOnly.getHours(), 0);
  assert.equal(parseFieldValue("", "datetime"), null);
  assert.equal(parseFieldValue("2026-13-45", "date"), null);
  assert.equal(parseFieldValue("tomorrow", "datetime"), null);
});

test("formatFieldValue and fieldToIso: round-trip without a zone shift", () => {
  assert.equal(formatFieldValue(new Date(2026, 10, 6, 9, 5), "datetime"), "2026-11-06T09:05");
  assert.equal(formatFieldValue(new Date(2026, 10, 6, 9, 5), "date"), "2026-11-06");
  const iso = fieldToIso("2026-11-06T15:30");
  assert.match(iso, /^2\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(Z|[+-]\d{2}:\d{2})$/);
  assert.equal(formatFieldValue(new Date(iso), "datetime"), "2026-11-06T15:30");
  assert.equal(fieldToIso(""), null);
});

test("describeFieldValue: one deterministic label for trigger and email copy", () => {
  assert.equal(describeFieldValue("2026-11-06T15:00", "datetime"), "Fri, 6 Nov 2026 · 3:00 pm");
  assert.equal(describeFieldValue("2026-11-06T00:15", "datetime"), "Fri, 6 Nov 2026 · 12:15 am");
  assert.equal(describeFieldValue("2026-11-06T12:00", "datetime"), "Fri, 6 Nov 2026 · 12:00 pm");
  assert.equal(describeFieldValue("2026-11-06", "date"), "Fri, 6 Nov 2026");
  assert.equal(describeFieldValue("", "datetime"), "Pick a date and time");
  assert.equal(describeFieldValue("", "date", "Optional"), "Optional");
});

test("startOfNextSlot: never a past or odd-minute start", () => {
  assert.equal(startOfNextSlot(30, new Date(2026, 10, 6, 9, 17)), "2026-11-06T09:30");
  assert.equal(startOfNextSlot(30, new Date(2026, 10, 6, 9, 31)), "2026-11-06T10:00");
  assert.equal(startOfNextSlot(30, new Date(2026, 10, 6, 9, 0)), "2026-11-06T09:00");
});

test("durationMinutes and formatDuration: the length shown next to the chips", () => {
  assert.equal(durationMinutes("2026-11-06T09:00", "2026-11-06T10:30"), 90);
  assert.equal(durationMinutes("2026-11-06T10:00", "2026-11-06T10:00"), null);
  assert.equal(durationMinutes("2026-11-06T11:00", "2026-11-06T09:00"), null);
  assert.equal(durationMinutes("", "2026-11-06T09:00"), null);
  assert.equal(formatDuration(90), "1 h 30 min");
  assert.equal(formatDuration(60), "1 h");
  assert.equal(formatDuration(30), "30 min");
  assert.equal(formatDuration(null), "");
});

test("shiftEndForDuration: moving the start keeps the meeting the same length", () => {
  assert.equal(shiftEndForDuration("2026-11-06T14:00", "2026-11-06T10:30", "2026-11-06T09:00"), "2026-11-06T15:30");
  // No usable previous duration (cleared or inverted end) falls back to one hour.
  assert.equal(shiftEndForDuration("2026-11-06T14:00", "", "2026-11-06T09:00"), "2026-11-06T15:00");
  assert.equal(shiftEndForDuration("2026-11-06T14:00", "2026-11-06T08:00", "2026-11-06T09:00"), "2026-11-06T15:00");
  // Crossing midnight keeps the 90-minute length and still yields a valid value.
  assert.equal(shiftEndForDuration("2026-11-06T23:30", "2026-11-07T00:30", "2026-11-06T23:00"), "2026-11-07T01:00");
});

test("addDaysToField: today / tomorrow / next week keep the chosen time", () => {
  assert.equal(addDaysToField("2026-11-06T15:30", 1, "datetime"), "2026-11-07T15:30");
  assert.equal(addDaysToField("2026-01-31", 1, "date"), "2026-02-01");
  assert.equal(addDaysToField("2026-11-06T23:30", 7, "datetime"), "2026-11-13T23:30");
});

test("formatShortDate and toDateTimeInput: stored values reach the field without a zone shift", () => {
  assert.equal(formatShortDate("2026-11-06"), "6 Nov 2026");
  assert.equal(formatShortDate(""), "");
  const iso = "2026-11-06T15:00:00.000Z";
  const local = toDateTimeInput(iso);
  assert.equal(parseFieldValue(local, "datetime").getTime(), new Date(iso).getTime());
});



