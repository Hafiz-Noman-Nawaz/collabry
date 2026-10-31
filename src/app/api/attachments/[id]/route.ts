import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/authz";
import { notFound, unauthorized, badRequest } from "@/lib/api";

/**
 * Returns a short-lived signed URL for a message attachment.
 * Access is enforced first by message_attachments RLS (conversation
 * membership) before the signed URL is generated.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data: attachment, error } = await supabase
    .from("message_attachments")
    .select("id, storage_path, file_name")
    .eq("id", id)
    .single();
  if (error || !attachment) return notFound("Attachment not found or you cannot access it.");

  const admin = createAdminClient();
  const { data: signed, error: signedError } = await admin.storage
    .from("message-attachments")
    .createSignedUrl(attachment.storage_path, 60 * 5, { download: attachment.file_name });
  if (signedError) return badRequest(signedError.message);
  return NextResponse.json({ url: signed.signedUrl, expiresIn: 300 });
}
