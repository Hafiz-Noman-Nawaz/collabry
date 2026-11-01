import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/authz";
import { badRequest, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { GEMINI_MODEL, generateRoadmapDraft, geminiConfigured } from "@/lib/gemini";

const briefSchema = z.object({
  projectName: z.string().trim().min(2).max(120),
  description: z.string().trim().min(40, "Describe the project in a couple of sentences so the plan is grounded in it.").max(6000),
  technologies: z.string().trim().max(1200).default(""),
  notes: z.string().trim().max(2000).default(""),
});

/**
 * Turns a plain-English brief into a roadmap draft. Nothing is written here: the
 * response is shown in the editor so the team can fix or delete any line before
 * it becomes project data.
 */
export async function POST(request: Request) {
  const parsed = briefSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return badRequest(first?.message ?? "The project description is not readable yet.");
  }

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  if (!geminiConfigured()) {
    return badRequest("AI planning is not switched on yet. Add GEMINI_API_KEY to the server environment, or write the roadmap yourself below.");
  }

  const limited = rateLimit(`roadmap:generate:${user.id}`, 8, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const { draft, error } = await generateRoadmapDraft(parsed.data);
  if (error) return badRequest(error);
  return NextResponse.json({ draft, model: GEMINI_MODEL });
}
