import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/authz";
import { badRequest, notFound, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

const reactionSchema = z.object({ emoji: z.string().trim().min(1).max(8) });

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data, error } = await supabase.from("message_reactions").select("message_id, user_id, emoji, created_at").eq("message_id", id);
  if (error) return badRequest(error.message);
  return NextResponse.json({ reactions: data ?? [] });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = reactionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Reaction must be a short emoji.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limited = rateLimit(`message:reaction:${user.id}`, 120, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  // RLS only allows reacting inside conversations the caller belongs to.
  const { data: message } = await supabase.from("messages").select("id").eq("id", id).maybeSingle();
  if (!message) return notFound("Message not found or you cannot react to it.");

  const { data, error } = await supabase
    .from("message_reactions")
    .upsert({ message_id: id, user_id: user.id, emoji: parsed.data.emoji }, { onConflict: "message_id,user_id,emoji" })
    .select("message_id, user_id, emoji, created_at");
  if (error) return badRequest(error.message);
  return NextResponse.json({ reaction: data?.[0] ?? null }, { status: 201 });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const emoji = new URL(request.url).searchParams.get("emoji");
  if (!emoji || emoji.length > 8) return badRequest("A reaction is required.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data, error } = await supabase
    .from("message_reactions")
    .delete()
    .eq("message_id", id)
    .eq("user_id", user.id)
    .eq("emoji", emoji)
    .select("emoji");
  if (error) return badRequest(error.message);
  if (!data || data.length === 0) return notFound("Reaction not found.");
  return NextResponse.json({ ok: true });
}
