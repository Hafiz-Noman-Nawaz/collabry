import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/authz";
import { badRequest, notFound, parseUuid, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { attachProfiles } from "@/lib/profiles";

const createSchema = z.object({ body: z.string().trim().min(1).max(4000) });
const updateSchema = z.object({ id: z.string().uuid(), body: z.string().trim().min(1).max(4000) });

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data, error } = await supabase
    .from("task_comments")
    .select("id, task_id, body, author_id, created_at, updated_at")
    .eq("task_id", id)
    .order("created_at", { ascending: true });
  if (error) return badRequest(error.message);
  return NextResponse.json({ comments: await attachProfiles(supabase, data ?? [], "author_id") });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Comment cannot be empty.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limited = rateLimit(`task:comment:${user.id}`, 30, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const { data: task } = await supabase.from("tasks").select("id, team_id").eq("id", id).maybeSingle();
  if (!task) return notFound("Task not found.");

  const { data, error } = await supabase
    .from("task_comments")
    .insert({ task_id: id, author_id: user.id, body: parsed.data.body })
    .select("id, task_id, body, author_id, created_at, updated_at")
    .single();
  if (error) return badRequest(error.message);
  return NextResponse.json({ comment: (await attachProfiles(supabase, [data], "author_id"))[0] }, { status: 201 });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid comment update.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data, error } = await supabase
    .from("task_comments")
    .update({ body: parsed.data.body, updated_at: new Date().toISOString() })
    .eq("id", parsed.data.id)
    .eq("task_id", id)
    .select("id, task_id, body, author_id, created_at, updated_at")
    .single();
  // RLS only lets the author update their own comment, so a missing row means denied.
  if (error || !data) return notFound("Comment not found or you cannot edit it.");
  return NextResponse.json({ comment: (await attachProfiles(supabase, [data], "author_id"))[0] });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const commentId = parseUuid(new URL(request.url).searchParams.get("id"));
  if (!commentId) return badRequest("A comment id is required.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data, error } = await supabase
    .from("task_comments")
    .delete()
    .eq("id", commentId)
    .eq("task_id", id)
    .select("id");
  if (error) return badRequest(error.message);
  if (!data || data.length === 0) return notFound("Comment not found or you cannot delete it.");
  return NextResponse.json({ ok: true });
}
