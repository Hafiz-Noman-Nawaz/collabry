import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit, requestOrigin, tooManyRequests } from "@/lib/rate-limit";

async function probeResend() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return "unconfigured";
  try {
    const response = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });
    if (response.ok) return "connected";
    if (response.status === 401 || response.status === 403) return "invalid";
    return "error";
  } catch {
    return "error";
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
    const mail = await probeResend();

    return NextResponse.json({
      status: storageReady && mail !== "invalid" ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      responseTimeMs: Date.now() - startedAt,
      services: {
        database: "connected",
        storage: storageReady ? "ready" : "partial",
        email: mail,
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
