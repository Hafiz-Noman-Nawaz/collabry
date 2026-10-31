import type { SupabaseServer } from "@/lib/authz";

export type ProfileLite = { id: string; full_name: string; avatar_url: string | null; university: string | null };

/**
 * Loads display profiles for a set of user ids.
 *
 * PostgREST cannot embed `profiles` through `user_id` foreign keys (both sides
 * point at auth.users), so every route that needs names loads them here instead
 * of selecting `profiles(...)` inline.
 */
export async function loadProfiles(supabase: SupabaseServer, userIds: Array<string | null | undefined>) {
  const ids = Array.from(new Set(userIds.filter((id): id is string => typeof id === "string" && id.length > 0)));
  const map = new Map<string, ProfileLite>();
  if (ids.length === 0) return map;
  const { data, error } = await supabase.from("profiles").select("id, full_name, avatar_url, university").in("id", ids);
  if (error || !data) return map;
  for (const row of data) map.set(row.id, row as ProfileLite);
  return map;
}

/** Returns the to-one `profiles` object PostgREST would have produced. */
export function profileOf(map: Map<string, ProfileLite>, userId: string | null | undefined) {
  if (!userId) return null;
  return map.get(userId) ?? null;
}

/** Attaches `profiles` to flat rows that carry a user id field. */
export async function attachProfiles<R extends Record<string, unknown>>(supabase: SupabaseServer, rows: R[], idField: string) {
  const map = await loadProfiles(supabase, rows.map((row) => row[idField] as string | null | undefined));
  return rows.map((row) => ({ ...row, profiles: profileOf(map, row[idField] as string | null | undefined) }));
}
