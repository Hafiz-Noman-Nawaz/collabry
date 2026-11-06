import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getMembership, getSessionUser, MANAGER_ROLES } from "@/lib/authz";
import { badRequest, forbidden, unauthorized } from "@/lib/api";

const sourceTypes = ["task", "roadmap", "message", "meeting", "file", "announcement", "manual"] as const;
const schema = z.object({
  teamId: z.string().uuid(),
  sourceType: z.enum(sourceTypes),
  sourceId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(240).default(""),
  content: z.string().trim().min(1).max(12_000),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("A project, source type, and non-empty knowledge content are required.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();
  const membership = await getMembership(supabase, parsed.data.teamId, user.id);
  if (!membership) return forbidden("You do not have access to this project.");

  const contentHash = createHash("sha256").update(`${parsed.data.title}\n${parsed.data.content}`).digest("hex");
  const { data, error } = await supabase
    .from("ai_knowledge_chunks")
    .upsert(
      {
        team_id: parsed.data.teamId,
        source_type: parsed.data.sourceType,
        source_id: parsed.data.sourceId ?? null,
        title: parsed.data.title,
        content: parsed.data.content,
        metadata: parsed.data.metadata,
        content_hash: contentHash,
        created_by: user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "team_id,source_type,source_id,content_hash" },
    )
    .select("id, source_type, source_id, title, content, metadata, created_at, updated_at")
    .single();
  if (error || !data) return badRequest(error?.message ?? "Unable to index project knowledge.");
  return NextResponse.json({ knowledge: data }, { status: 201 });
}

export async function DELETE(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = z.object({ teamId: z.string().uuid(), id: z.string().uuid() }).safeParse(body);
  if (!parsed.success) return badRequest("A valid project and knowledge id are required.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();
  const membership = await getMembership(supabase, parsed.data.teamId, user.id);
  if (!membership || !MANAGER_ROLES.includes(membership.role)) return forbidden("Only project managers can remove indexed knowledge.");

  const { error } = await supabase.from("ai_knowledge_chunks").delete().eq("id", parsed.data.id).eq("team_id", parsed.data.teamId);
  if (error) return badRequest(error.message);
  return NextResponse.json({ ok: true });
}
