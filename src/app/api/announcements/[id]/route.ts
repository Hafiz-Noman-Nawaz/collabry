import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/authz";
import { badRequest, notFound, unauthorized } from "@/lib/api";
import { recordAudit } from "@/lib/audit";

const updateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1).max(10000).optional(),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid announcement update.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.title !== undefined) patch.title = parsed.data.title;
  if (parsed.data.body !== undefined) patch.body = parsed.data.body;

  const { data, error } = await supabase
    .from("announcements")
    .update(patch)
    .eq("id", id)
    .select("id, team_id, author_id, title, body, created_at, updated_at")
    .single();
  // RLS limits updates to the author or a team manager.
  if (error || !data) return notFound("Announcement not found or you cannot edit it.");
  await recordAudit({ actorId: user.id, teamId: data.team_id, action: "announcement.updated", resourceType: "announcement", resourceId: id });
  return NextResponse.json({ announcement: data });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data, error } = await supabase.from("announcements").delete().eq("id", id).select("id, team_id");
  if (error) return badRequest(error.message);
  if (!data || data.length === 0) return notFound("Announcement not found or you cannot delete it.");
  await recordAudit({ actorId: user.id, teamId: data[0].team_id, action: "announcement.deleted", resourceType: "announcement", resourceId: id });
  return NextResponse.json({ ok: true });
}
