import type { createClient } from "@/lib/supabase/server";

export type SupabaseServer = Awaited<ReturnType<typeof createClient>>;
export type TeamRole = "owner" | "supervisor" | "leader" | "member" | "reviewer";

export const MANAGER_ROLES: TeamRole[] = ["owner", "supervisor", "leader"];
export const INVITER_ROLES: TeamRole[] = ["owner", "leader"];
export const REVIEWER_ROLES: TeamRole[] = ["owner", "supervisor", "leader", "reviewer"];

/** Returns the authenticated user or null. Never throws. */
export async function getSessionUser(supabase: SupabaseServer) {
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
}

/** Loads a user's role in a team. RLS already scopes this query to real members. */
export async function getMembership(supabase: SupabaseServer, teamId: string, userId: string) {
  const { data } = await supabase
    .from("team_members")
    .select("role, joined_at")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .maybeSingle();
  return (data as { role: TeamRole; joined_at: string } | null) ?? null;
}

export function hasRole(role: string | null | undefined, allowed: TeamRole[]) {
  return !!role && (allowed as string[]).includes(role);
}

/** Returns the subset of userIds that are not members of the team (RLS-scoped query). */
export async function nonTeamMembers(supabase: SupabaseServer, teamId: string, userIds: string[]) {
  if (userIds.length === 0) return [];
  const { data } = await supabase
    .from("team_members")
    .select("user_id")
    .eq("team_id", teamId)
    .in("user_id", userIds);
  const memberSet = new Set((data ?? []).map((row) => row.user_id as string));
  return userIds.filter((userId) => !memberSet.has(userId));
}

/** Loads the signed-in user's most recent team membership, used by workspace screens. */
export async function getActiveTeam(supabase: SupabaseServer) {
  const { data } = await supabase
    .from("teams")
    .select("id, name, description, university, department, category, start_date, target_date, created_at, storage_quota_bytes")
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}
