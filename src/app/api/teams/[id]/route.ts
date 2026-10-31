import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/authz";
import { forbidden, notFound, unauthorized } from "@/lib/api";
import { recordAudit } from "@/lib/audit";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limited = rateLimit(`team:delete:${user.id}`, 5, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const { data: team } = await supabase.from("teams").select("id, name, owner_id").eq("id", id).maybeSingle();
  if (!team) return notFound("Project not found.");
  if (team.owner_id !== user.id) return forbidden("Only the project owner can delete this project.");

  const admin = createAdminClient();

  const [{ data: projectFiles }, { data: conversations }] = await Promise.all([
    admin.from("project_files").select("storage_path").eq("team_id", id),
    admin.from("conversations").select("id").eq("team_id", id),
  ]);

  const attachmentPaths: string[] = [];
  const conversationIds = (conversations ?? []).map((row) => row.id as string);
  if (conversationIds.length > 0) {
    const { data: messages } = await admin.from("messages").select("id").in("conversation_id", conversationIds);
    const messageIds = (messages ?? []).map((row) => row.id as string);
    if (messageIds.length > 0) {
      const { data: attachments } = await admin.from("message_attachments").select("storage_path").in("message_id", messageIds);
      for (const attachment of attachments ?? []) attachmentPaths.push(attachment.storage_path as string);
    }
  }

  // Remove stored objects first: if this fails the project row survives and the
  // owner can retry, instead of leaving unreachable files behind.
  const filePaths = (projectFiles ?? []).map((row) => row.storage_path as string);
  if (filePaths.length > 0) {
    const { error } = await admin.storage.from("project-files").remove(filePaths);
    if (error) return NextResponse.json({ error: "Project files could not be removed. Try again." }, { status: 500 });
  }
  if (attachmentPaths.length > 0) {
    await admin.storage.from("message-attachments").remove(attachmentPaths);
  }

  // Service role delete after the explicit ownership check above; teams has no
  // DELETE policy because removal is intentionally server-mediated.
  const { error } = await admin.from("teams").delete().eq("id", id);
  if (error) return NextResponse.json({ error: "The project could not be deleted. Try again." }, { status: 500 });

  await recordAudit({
    actorId: user.id,
    teamId: null,
    action: "project.deleted",
    resourceType: "team",
    resourceId: id,
    metadata: { name: team.name },
  });

  return NextResponse.json({ ok: true });
}
