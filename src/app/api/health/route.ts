import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit, requestOrigin, tooManyRequests } from "@/lib/rate-limit";
import { configuredSenderDomain, emailKeyLooksValid, isEmailConfigured } from "@/lib/email";

type EmailProbe = { provider: string; sender: string };

/**
 * Proves both halves of transactional email: the API key is accepted, and the
 * RESEND_FROM_EMAIL domain is actually verified — Resend rejects a send from
 * any other domain, which is the most common silent failure.
 */
async function probeEmail(): Promise<EmailProbe> {
  if (!isEmailConfigured()) return { provider: "unconfigured", sender: "unconfigured" };
  // A key that cannot be a Resend key is reported without a network round trip.
  if (!emailKeyLooksValid()) return { provider: "invalid", sender: "unknown" };
  const senderDomain = configuredSenderDomain();
  try {
    const response = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY?.trim()}` },
      cache: "no-store",
    });
    // 400 is a malformed key, 401/403 a revoked one.
    if (response.status === 400 || response.status === 401 || response.status === 403) return { provider: "invalid", sender: "unknown" };
    if (!response.ok) return { provider: "error", sender: "unknown" };
    const body = (await response.json().catch(() => null)) as { data?: Array<{ name?: string; status?: string }> } | null;
    const verified = new Set(
      (body?.data ?? []).filter((domain) => (domain.status ?? "verified") === "verified").map((domain) => (domain.name ?? "").toLowerCase()),
    );
    return { provider: "connected", sender: senderDomain && verified.has(senderDomain) ? "verified" : "unverified" };
  } catch {
    return { provider: "error", sender: "unknown" };
  }
}

export async function GET(request: Request) {
  const limited = rateLimit(`health:${requestOrigin(request)}`, 30, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const startedAt = Date.now();
  try {
    const admin = createAdminClient();
    const { error: dbError } = await admin.from("teams").select("id").limit(1);
    if (dbError) throw new Error("database");

    const { data: buckets, error: storageError } = await admin.storage.listBuckets();
    if (storageError) throw new Error("storage");

    const bucketIds = new Set((buckets ?? []).map((bucket) => bucket.id));
    const storageReady = ["project-files", "message-attachments"].every((id) => bucketIds.has(id));
    const email = await probeEmail();

    return NextResponse.json({
      status: storageReady && email.provider === "connected" && email.sender === "verified" ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      responseTimeMs: Date.now() - startedAt,
      services: {
        database: "connected",
        storage: storageReady ? "ready" : "partial",
        email: email.provider,
        emailSender: email.sender,
        jobs: process.env.CRON_SECRET ? "configured" : "unconfigured",
      },
    });
  } catch {
    return NextResponse.json(
      {
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        error: "One or more required services are unavailable.",
      },
      { status: 503 },
    );
  }
}
