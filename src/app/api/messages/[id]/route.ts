import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/authz";
import { badRequest, forbidden, notFound, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { loadProfiles, profileOf } from "@/lib/profiles";

const updateSchema = z.object({ body: z.string().trim().min(1).max(4000) });

/** Edits the caller's own message; RLS restricts updates to the sender. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Message cannot be empty.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limited = rateLimit(`message:edit:${user.id}`, 60, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const { data, error } = await supabase
    .from("messages")
    .update({ body: parsed.data.body, edited_at: new Date().toISOString() })
    .eq("id", id)
    .eq("sender_id", user.id)
    .is("deleted_at", null)
    .select("id, conversation_id, sender_id, body, kind, created_at, edited_at")
    .single();
  if (error || !data) return forbidden("You can only edit your own messages.");

  const sender = await loadProfiles(supabase, [user.id]);
  return NextResponse.json({ message: { ...data, profiles: profileOf(sender, user.id) } });
}

/** Soft-deletes the caller's own message so history stays consistent. */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data, error } = await supabase
    .from("messages")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("sender_id", user.id)
    .is("deleted_at", null)
    .select("id");
  if (error) return badRequest(error.message);
  if (!data || data.length === 0) return notFound("Message not found or you cannot delete it.");
  return NextResponse.json({ ok: true });
}
