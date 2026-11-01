import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/authz";
import { badRequest, forbidden, notFound, parseUuid, unauthorized } from "@/lib/api";
import { recordAudit } from "@/lib/audit";
import { PHASE_STATUSES } from "@/lib/roadmap";

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a calendar date like 2026-11-06.")
  .nullable();

const patchSchema = z.object({
  title: z.string().trim().min(1).max(140).optional(),
  summary: z.string().trim().max(320).optional(),
  status: z.enum(PHASE_STATUSES).optional(),
  position: z.number().int().min(1).max(50).optional(),
  start_date: day.optional(),
  end_date: day.optional(),
});

/**
 * Updates or removes one phase. Tasks are never deleted with a phase: they fall
 * back to the unassigned list so recorded progress cannot silently disappear.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const phaseId = parseUuid(id);
  if (!phaseId) return badRequest("A valid phase is required.");
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Those phase details are not valid.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data: current } = await supabase
    .from("roadmap_phases")
    .select("id, team_id, title, start_date, end_date")
    .eq("id", phaseId)
    .maybeSingle();
  if (!current) return notFound("Phase not found, or you are not a member of this project.");

  const start = parsed.data.start_date !== undefined ? parsed.data.start_date : current?.start_date ?? null;
  const end = parsed.data.end_date !== undefined ? parsed.data.end_date : current?.end_date ?? null;
  if (start && end && new Date(end).getTime() < new Date(start).getTime()) {
    return badRequest("A phase cannot end before it starts.");
  }

  const { data, error } = await supabase
    .from("roadmap_phases")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", phaseId)
    .select("id, team_id, title, summary, position, status, start_date, end_date, source, created_by")
    .maybeSingle();
  if (error) return badRequest(error.message);
  if (!data) return forbidden("Only your own phases, or a project lead, can change this phase.");

  await recordAudit({ actorId: user.id, teamId: data.team_id, action: "roadmap.updated", resourceType: "phase", resourceId: phaseId, metadata: parsed.data });
  return NextResponse.json({ phase: data });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const phaseId = parseUuid(id);
  if (!phaseId) return badRequest("A valid phase is required.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data: current } = await supabase.from("roadmap_phases").select("id, team_id, title").eq("id", phaseId).maybeSingle();
  if (!current) return notFound("Phase not found, or you are not a member of this project.");

  const { error } = await supabase.from("roadmap_phases").delete().eq("id", phaseId);
  if (error) return badRequest(error.message);

  await recordAudit({ actorId: user.id, teamId: current.team_id, action: "roadmap.deleted", resourceType: "phase", resourceId: phaseId, metadata: { title: current.title } });
  return NextResponse.json({ ok: true });
}
