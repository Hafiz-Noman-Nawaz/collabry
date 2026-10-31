import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/authz";
import { badRequest, notFound, parseUuid, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

const createSchema = z.object({ body: z.string().trim().min(1).max(200) });
const updateSchema = z.object({
  id: z.string().uuid(),
  body: z.string().trim().min(1).max(200).optional(),
  done: z.boolean().optional(),
  position: z.number().int().min(0).max(500).optional(),
});

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data, error } = await supabase
    .from("task_checklist_items")
    .select("id, task_id, body, done, position, created_by, created_at")
    .eq("task_id", id)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) return badRequest(error.message);
  return NextResponse.json({ items: data ?? [] });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Checklist item cannot be empty.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limited = rateLimit(`task:checklist:${user.id}`, 60, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const { data: task } = await supabase.from("tasks").select("id").eq("id", id).maybeSingle();
  if (!task) return notFound("Task not found.");

  const { data: positionData } = await supabase
    .from("task_checklist_items")
    .select("position")
    .eq("task_id", id)
    .order("position", { ascending: false })
    .limit(1);
  const nextPosition = (positionData?.[0]?.position ?? -1) + 1;

  const { data, error } = await supabase
    .from("task_checklist_items")
    .insert({ task_id: id, body: parsed.data.body, created_by: user.id, position: nextPosition })
    .select("id, task_id, body, done, position, created_by, created_at")
    .single();
  if (error) return badRequest(error.message);
  return NextResponse.json({ item: data }, { status: 201 });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid checklist update.");

  const patch: Record<string, unknown> = {};
  if (parsed.data.body !== undefined) patch.body = parsed.data.body;
  if (parsed.data.done !== undefined) patch.done = parsed.data.done;
  if (parsed.data.position !== undefined) patch.position = parsed.data.position;
  if (Object.keys(patch).length === 0) return badRequest("Nothing to update.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data, error } = await supabase
    .from("task_checklist_items")
    .update(patch)
    .eq("id", parsed.data.id)
    .eq("task_id", id)
    .select("id, task_id, body, done, position, created_by, created_at")
    .single();
  if (error || !data) return notFound("Checklist item not found or you cannot edit it.");
  return NextResponse.json({ item: data });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const itemId = parseUuid(new URL(request.url).searchParams.get("id"));
  if (!itemId) return badRequest("A checklist item id is required.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data, error } = await supabase
    .from("task_checklist_items")
    .delete()
    .eq("id", itemId)
    .eq("task_id", id)
    .select("id");
  if (error) return badRequest(error.message);
  if (!data || data.length === 0) return notFound("Checklist item not found or you cannot delete it.");
  return NextResponse.json({ ok: true });
}
