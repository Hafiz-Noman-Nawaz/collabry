import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/authz";
import { notFound, unauthorized, badRequest } from "@/lib/api";

/**
 * Returns a short-lived signed URL for a message attachment.
 * Access is enforced first by message_attachments RLS (conversation
 * membership) before the signed URL is generated.
 *
 * `?inline=1` serves the bytes as-is so an <img> can render a preview; without
 * it the file is offered as a download under its original name.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const inline = new URL(request.url).searchParams.get("inline") === "1";
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data: attachment, error } = await supabase
    .from("message_attachments")
    .select("id, storage_path, file_name, content_type")
    .eq("id", id)
    .single();
  if (error || !attachment) return notFound("Attachment not found or you cannot access it.");

  const admin = createAdminClient();
  const { data: signed, error: signedError } = await admin.storage
    .from("message-attachments")
    .createSignedUrl(attachment.storage_path, 60 * 5, inline ? {} : { download: attachment.file_name });
  if (signedError) return badRequest(signedError.message);
  // Inline requests redirect instead of returning JSON so an <img src> can be
  // pointed straight at this route; membership is still checked before signing.
  if (inline) return NextResponse.redirect(signed.signedUrl, 302);
  return NextResponse.json({ url: signed.signedUrl, expiresIn: 300, contentType: attachment.content_type });
}
