import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getMembership, getSessionUser } from "@/lib/authz";
import { badRequest, forbidden, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { generateGroundedAnswer, GROQ_MODEL, groqConfigured } from "@/lib/groq";

const requestSchema = z.object({
  teamId: z.string().uuid(),
  type: z.enum(["conversation_summary", "meeting_actions"]),
  conversationId: z.string().uuid().optional(),
  meetingId: z.string().uuid().optional(),
});

function parseJson(value: string) {
  const text = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] ?? value;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Choose a communication analysis and its source.");
  if (parsed.data.type === "conversation_summary" && !parsed.data.conversationId) return badRequest("A conversation is required.");
  if (parsed.data.type === "meeting_actions" && !parsed.data.meetingId) return badRequest("A meeting is required.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();
  if (!groqConfigured()) return badRequest("AI is not configured. Add GROQ_API_KEY to the server environment.");
  if (!(await getMembership(supabase, parsed.data.teamId, user.id))) return forbidden("You do not have access to this project.");

  const limited = rateLimit(`ai:communication:${user.id}`, 12, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  let context = "";
  let sourceCount = 0;
  if (parsed.data.type === "conversation_summary" && parsed.data.conversationId) {
    const { data: conversation } = await supabase.from("conversations").select("id, title, team_id").eq("id", parsed.data.conversationId).eq("team_id", parsed.data.teamId).maybeSingle();
    if (!conversation) return forbidden("Conversation not found in this project.");
    const { data: messages, error } = await supabase.from("messages").select("sender_id, body, created_at").eq("conversation_id", conversation.id).is("deleted_at", null).order("created_at", { ascending: false }).limit(100);
    if (error) return badRequest(error.message);
    sourceCount = messages?.length ?? 0;
    context = JSON.stringify({ conversation, messages: messages ?? [] });
  } else if (parsed.data.meetingId) {
    const { data: meeting } = await supabase.from("meetings").select("id, team_id, title, agenda, starts_at, status, meeting_minutes(body, decisions), meeting_action_items(title, done, assignee_id)").eq("id", parsed.data.meetingId).eq("team_id", parsed.data.teamId).maybeSingle();
    if (!meeting) return forbidden("Meeting not found in this project.");
    sourceCount = 1;
    context = JSON.stringify(meeting);
  }

  const instructions =
    parsed.data.type === "conversation_summary"
      ? 'Return JSON only: {"summary":"string","decisions":["string"],"actionItems":[{"title":"string","reason":"string"}],"questions":["string"]}. Summarize only the supplied messages. Do not invent identities, deadlines, or decisions.'
      : 'Return JSON only: {"summary":"string","decisions":["string"],"actionItems":[{"title":"string","reason":"string"}],"questions":["string"]}. Suggest action items only when supported by the agenda, minutes, or existing items. They are suggestions and must be reviewed.';
  const generated = await generateGroundedAnswer({
    system: `You are Collabry's communication assistant. ${instructions} If evidence is missing, say so in questions.`,
    question: parsed.data.type === "conversation_summary" ? "Summarize this conversation and extract decisions and possible action items." : "Summarize this meeting and suggest reviewable action items.",
    context: context.slice(0, 30_000),
  });
  if (generated.error || !generated.answer) return badRequest(generated.error ?? "Unable to analyze communication.");
  const result = parseJson(generated.answer);
  if (!result || typeof result !== "object") return badRequest("The AI returned an unusable communication analysis.");

  await supabase.from("ai_usage_events").insert({
    team_id: parsed.data.teamId,
    user_id: user.id,
    feature: parsed.data.type,
    provider: "groq",
    model: GROQ_MODEL,
    input_tokens: generated.usage.inputTokens,
    output_tokens: generated.usage.outputTokens,
    source_count: sourceCount,
  });
  return NextResponse.json({ type: parsed.data.type, result, model: GROQ_MODEL });
}
