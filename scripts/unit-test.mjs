// Unit tests for Collabry validation and authorization helpers
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

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

