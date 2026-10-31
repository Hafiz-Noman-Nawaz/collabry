import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser, getMembership } from "@/lib/authz";
import { badRequest, forbidden, queryInt, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { recordAudit } from "@/lib/audit";

const settingsSchema = z.object({
  teamId: z.string().uuid(),
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(4000).optional(),
  university: z.string().trim().max(160).nullable().optional(),
  department: z.string().trim().max(160).nullable().optional(),
  category: z.string().trim().max(80).nullable().optional(),
  startDate: z.string().date().nullable().optional(),
  targetDate: z.string().date().nullable().optional(),
  storageQuotaBytes: z.number().int().min(1024 * 1024).max(1024 * 1024 * 1024 * 100).optional(),
});

const TEAM_SELECT =
  "id, name, description, university, department, category, start_date, target_date, created_at, updated_at, storage_quota_bytes, team_members(user_id, role)";
const TEAM_UPDATE_SELECT = "id, name, description, university, department, category, start_date, target_date, created_at, updated_at, storage_quota_bytes";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limit = queryInt(url, "limit", 12, 50);
  const offset = queryInt(url, "offset", 0, 1000);
  const search = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
  const category = (url.searchParams.get("category") ?? "").trim().slice(0, 80);
  const status = url.searchParams.get("status");

  // RLS already restricts teams to memberships of the caller; the embedded
  // team_members filter additionally reports the caller's own role per team.
  let query = supabase
    .from("teams")
    .select(TEAM_SELECT, { count: "exact" })
    .eq("team_members.user_id", user.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (search) query = query.or(`name.ilike.%${search}%,description.ilike.%${search}%,university.ilike.%${search}%`);
  if (category) query = query.eq("category", category);
  if (status === "active") query = query.or("target_date.is.null,target_date.gte." + new Date().toISOString().slice(0, 10));
  if (status === "overdue") query = query.lt("target_date", new Date().toISOString().slice(0, 10));

  const { data, error, count } = await query;
  if (error) return badRequest(error.message);

  const teams = (data ?? []).map((team) => ({
    ...team,
    role: (team.team_members as Array<{ role: string }>)[0]?.role ?? null,
    memberCount: (team.team_members ?? []).length,
  }));

  const { data: categories } = await supabase.from("teams").select("category").eq("team_members.user_id", user.id).not("category", "is", null);
  const distinctCategories = Array.from(new Set((categories ?? []).map((row) => row.category).filter(Boolean)));

  return NextResponse.json({ teams, total: count ?? 0, categories: distinctCategories });
}

export async function PATCH(request: Request) {
  const parsed = settingsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid project settings.");
  const teamId = parsed.data.teamId;

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limited = rateLimit(`team:update:${user.id}`, 30, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const membership = await getMembership(supabase, teamId, user.id);
  if (!membership || membership.role !== "owner") return forbidden("Only the project owner can change project settings.");

  const patch: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.description !== undefined) patch.description = parsed.data.description;
  if (parsed.data.university !== undefined) patch.university = parsed.data.university;
  if (parsed.data.department !== undefined) patch.department = parsed.data.department;
  if (parsed.data.category !== undefined) patch.category = parsed.data.category;
  if (parsed.data.startDate !== undefined) patch.start_date = parsed.data.startDate;
  if (parsed.data.targetDate !== undefined) patch.target_date = parsed.data.targetDate;
  if (parsed.data.storageQuotaBytes !== undefined) patch.storage_quota_bytes = parsed.data.storageQuotaBytes;
  if (Object.keys(patch).length === 0) return badRequest("Nothing to update.");
  patch.updated_at = new Date().toISOString();

  const { data, error } = await supabase.from("teams").update(patch).eq("id", teamId).select(TEAM_UPDATE_SELECT).single();
  if (error || !data) return badRequest(error?.message ?? "Unable to save project settings.");

  await recordAudit({ actorId: user.id, teamId, action: "team.settings_updated", resourceType: "team", resourceId: teamId, metadata: { fields: Object.keys(patch) } });
  return NextResponse.json({ team: data });
}
