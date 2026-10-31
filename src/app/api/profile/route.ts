import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/authz";
import { badRequest, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { recordAudit } from "@/lib/audit";

const profileSchema = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  university: z.string().trim().max(160).nullable().optional(),
  department: z.string().trim().max(160).nullable().optional(),
  avatarUrl: z.string().url().max(500).nullable().optional(),
});

const SELECT = "id, full_name, avatar_url, university, department, created_at, updated_at";

export async function GET() {
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data, error } = await supabase.from("profiles").select(SELECT).eq("id", user.id).maybeSingle();
  if (error) return badRequest(error.message);
  if (!data) {
    // The signup trigger normally creates the row; recover if it is missing.
    const { data: created } = await createAdminClient()
      .from("profiles")
      .upsert({ id: user.id, full_name: (user.user_metadata?.full_name as string) ?? "" }, { onConflict: "id" })
      .select(SELECT)
      .single();
    return NextResponse.json({ profile: created ?? null });
  }
  return NextResponse.json({ profile: data });
}

export async function PATCH(request: Request) {
  const parsed = profileSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid profile details.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limited = rateLimit(`profile:update:${user.id}`, 20, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.fullName !== undefined) patch.full_name = parsed.data.fullName;
  if (parsed.data.university !== undefined) patch.university = parsed.data.university;
  if (parsed.data.department !== undefined) patch.department = parsed.data.department;
  if (parsed.data.avatarUrl !== undefined) patch.avatar_url = parsed.data.avatarUrl;
  if (Object.keys(patch).length === 1) return badRequest("Nothing to update.");

  const { data, error } = await supabase.from("profiles").update(patch).eq("id", user.id).select(SELECT).single();
  if (error || !data) {
    // No row yet: create it with the service-role client, then apply the change.
    const { data: created, error: createError } = await createAdminClient()
      .from("profiles")
      .upsert({ id: user.id, ...patch }, { onConflict: "id" })
      .select(SELECT)
      .single();
    if (createError || !created) return badRequest(error?.message ?? createError?.message ?? "Unable to save the profile.");
    return NextResponse.json({ profile: created });
  }

  await recordAudit({ actorId: user.id, action: "profile.updated", resourceType: "profile", resourceId: user.id, metadata: { fields: Object.keys(patch) } });
  return NextResponse.json({ profile: data });
}
