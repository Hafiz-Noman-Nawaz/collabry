import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only service-role client. RLS is bypassed, so never import this from a
 * client component and never expose SUPABASE_SERVICE_ROLE_KEY to the browser.
 * It writes audit logs, notifications and scheduled jobs, none of which have
 * authenticated insert policies by design.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase service-role environment variables.");
  return createSupabaseClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
