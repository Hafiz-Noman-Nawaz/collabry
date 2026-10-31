import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runDueJobs, ensureInvitationSweep } from "@/lib/jobs";

function cronSecretMatches(provided: string) {
  const secret = process.env.CRON_SECRET ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Cron entry point. Protected by CRON_SECRET; a platform scheduler should POST
 * here every minute. Jobs are claimed with an optimistic lock, so overlapping
 * runs are safe and retries/backoff are handled inside runDueJobs.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const provided =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";

  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured. Set it in the deployment platform, then retry with the x-cron-secret header." },
      { status: 503 },
    );
  }
  if (!cronSecretMatches(provided)) return NextResponse.json({ error: "Invalid cron secret." }, { status: 401 });

  try {
    await ensureInvitationSweep();
    const results = await runDueJobs();
    return NextResponse.json({ ok: true, results });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Job run failed." }, { status: 500 });
  }
}

/** Reports the queue depth for health checks; requires the same secret. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const provided = request.headers.get("x-cron-secret") ?? "";
  if (!secret || !cronSecretMatches(provided)) return NextResponse.json({ error: "Invalid cron secret." }, { status: 401 });
  return NextResponse.json({ ok: true, configured: true });
}
