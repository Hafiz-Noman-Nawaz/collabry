type Bucket = { count: number; resetAt: number };

// Survives dev hot reloads within one runtime instance.
const store = ((globalThis as { __collabryRateLimit?: Map<string, Bucket> }).__collabryRateLimit ??= new Map());

export type RateLimitResult = { ok: true; remaining: number } | { ok: false; retryAfterSeconds: number };

/**
 * Fixed-window in-memory rate limiter. It protects a single server instance,
 * which is the correct scope for a self-hosted Node deployment; a multi-instance
 * deployment should swap this module for a shared store without touching callers.
 */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  if (store.size > 5000) {
    for (const [entryKey, bucket] of store) if (bucket.resetAt <= now) store.delete(entryKey);
  }
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
}

/** Best caller identity for anonymous or pre-auth traffic. */
export function requestOrigin(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export function tooManyRequests(retryAfterSeconds: number) {
  return new Response(JSON.stringify({ error: `Too many requests. Try again in ${retryAfterSeconds}s.` }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": String(retryAfterSeconds) },
  });
}
