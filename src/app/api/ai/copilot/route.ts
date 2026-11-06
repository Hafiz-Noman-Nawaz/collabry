import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getMembership, getSessionUser } from "@/lib/authz";
import { badRequest, forbidden, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { generateGroundedAnswer, GROQ_MODEL, groqConfigured } from "@/lib/groq";

const requestSchema = z.object({
  teamId: z.string().uuid(),
  question: z.string().trim().min(3).max(2000),
});

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("A valid project and question are required.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();
  if (!groqConfigured()) return badRequest("AI is not configured. Add GROQ_API_KEY to the server environment.");

  const membership = await getMembership(supabase, parsed.data.teamId, user.id);
  if (!membership) return forbidden("You do not have access to this project.");

  const limited = rateLimit(`ai:copilot:${user.id}`, 20, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const { data: sources, error } = await supabase.rpc("search_ai_knowledge", {
    target_team: parsed.data.teamId,
    query_text: parsed.data.question,
    result_limit: 8,
  });
  if (error && !/function .*search_ai_knowledge.*does not exist|schema cache/i.test(error.message)) {
    return badRequest(`AI knowledge search failed: ${error.message}`);
  }

  const rows = (sources ?? []) as Array<{ id: string; source_type: string; source_id: string | null; title: string; content: string; metadata: Record<string, unknown>; score: number }>;
  if (rows.length === 0) {
    const [tasks, phases, meetings, announcements] = await Promise.all([
      supabase.from("tasks").select("id, title, description, status, priority, due_at").eq("team_id", parsed.data.teamId).order("updated_at", { ascending: false }).limit(40),
      supabase.from("roadmap_phases").select("id, title, summary, status, position").eq("team_id", parsed.data.teamId).order("position", { ascending: true }).limit(20),
      supabase.from("meetings").select("id, title, agenda, starts_at, status").eq("team_id", parsed.data.teamId).order("starts_at", { ascending: false }).limit(20),
      supabase.from("announcements").select("id, title, body, created_at").eq("team_id", parsed.data.teamId).order("created_at", { ascending: false }).limit(20),
    ]);
    for (const task of tasks.data ?? []) rows.push({
      id: `task-${task.id}`, source_type: "task", source_id: task.id, title: task.title,
      content: `${task.description || "No description"} Status: ${task.status}. Priority: ${task.priority}. Due: ${task.due_at ?? "not set"}.`,
      metadata: {}, score: 1,
    });
    for (const phase of phases.data ?? []) rows.push({
      id: `roadmap-${phase.id}`, source_type: "roadmap", source_id: phase.id, title: phase.title,
      content: `${phase.summary || "No summary"} Status: ${phase.status}. Position: ${phase.position}.`,
      metadata: {}, score: 1,
    });
    for (const meeting of meetings.data ?? []) rows.push({
      id: `meeting-${meeting.id}`, source_type: "meeting", source_id: meeting.id, title: meeting.title,
      content: `${meeting.agenda || "No agenda"} Status: ${meeting.status}. Starts: ${meeting.starts_at}.`,
      metadata: {}, score: 1,
    });
    for (const announcement of announcements.data ?? []) rows.push({
      id: `announcement-${announcement.id}`, source_type: "announcement", source_id: announcement.id, title: announcement.title,
      content: announcement.body, metadata: {}, score: 1,
    });
  }
  const context = rows.length > 0
    ? rows.map((row, index) => `[S${index + 1}] ${row.title}\n${row.content}`).join("\n\n")
    : "No indexed project knowledge matched this question.";

  const generated = await generateGroundedAnswer({
    system:
      "You are Collabry's project copilot. Answer only from the supplied project context. If the context does not contain the answer, say that clearly and ask what source or detail is needed. Never invent dates, people, progress, requirements, or decisions. Cite factual statements with [S1], [S2] using only the supplied source labels. Keep the answer concise and actionable.",
    question: parsed.data.question,
    context,
  });
  if (generated.error || !generated.answer) return badRequest(generated.error ?? "Unable to generate an answer.");

  await supabase.from("ai_usage_events").insert({
    team_id: parsed.data.teamId,
    user_id: user.id,
    feature: "copilot",
    provider: "groq",
    model: GROQ_MODEL,
    input_tokens: generated.usage.inputTokens,
    output_tokens: generated.usage.outputTokens,
    source_count: rows.length,
  });

  return NextResponse.json({
    answer: generated.answer,
    model: GROQ_MODEL,
    sources: rows.map((row, index) => ({
      citation: `S${index + 1}`,
      id: row.id,
      type: row.source_type,
      sourceId: row.source_id,
      title: row.title,
      score: row.score,
    })),
  });
}
