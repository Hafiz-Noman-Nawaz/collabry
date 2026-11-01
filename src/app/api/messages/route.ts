import { randomUUID } from "node:crypto";
import { NextResponse, after } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/authz";
import { badRequest, notFound, parseUuid, queryInt, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { notifyTeam } from "@/lib/notify";
import { loadProfiles, profileOf } from "@/lib/profiles";
import { ALLOWED_UPLOAD_TYPE_SET } from "@/lib/uploads";

const jsonSchema = z.object({ conversationId: z.string().uuid(), body: z.string().trim().min(1).max(4000) });

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;
const MAX_ATTACHMENT_FILES = 5;

// Storage paths stay server-side: attachments are opened through /api/attachments/[id],
// which re-checks conversation membership before signing a URL.
const MESSAGE_SELECT =
  "id, conversation_id, sender_id, body, kind, created_at, edited_at, deleted_at, message_attachments(id, file_name, content_type, file_size), message_reactions(user_id, emoji)";

function safeName(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "attachment";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const conversationId = parseUuid(url.searchParams.get("conversationId"));
  if (!conversationId) return badRequest("A valid conversation is required.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limit = queryInt(url, "limit", 50, 100);
  const offset = queryInt(url, "offset", 0, 5000);

  const { data, error, count } = await supabase
    .from("messages")
    .select(MESSAGE_SELECT, { count: "exact" })
    .eq("conversation_id", conversationId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return badRequest(error.message);

  // Oldest first for rendering; names are merged because profiles cannot be embedded.
  const rows = (data ?? []).reverse();
  const senders = await loadProfiles(supabase, rows.map((row) => row.sender_id));
  const messages = rows.map((row) => ({ ...row, profiles: profileOf(senders, row.sender_id) }));
  return NextResponse.json({ messages, total: count ?? 0 });
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  const isMultipart = contentType.includes("multipart/form-data");

  let conversationId = "";
  let body = "";
  let files: File[] = [];
  if (isMultipart) {
    const formData = await request.formData();
    conversationId = String(formData.get("conversationId") ?? "");
    body = String(formData.get("body") ?? "").trim();
    files = formData.getAll("files").filter((entry): entry is File => entry instanceof File && entry.size > 0);
  } else {
    const parsed = jsonSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return badRequest("Invalid message.");
    conversationId = parsed.data.conversationId;
    body = parsed.data.body;
  }
  if (!parseUuid(conversationId)) return badRequest("A valid conversation is required.");
  if (body.length === 0 && files.length === 0) return badRequest("Message cannot be empty.");
  if (body.length > 4000) return badRequest("Message is too long.");
  if (files.length > MAX_ATTACHMENT_FILES) return badRequest(`Attach at most ${MAX_ATTACHMENT_FILES} files per message.`);
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_SIZE) return badRequest("Attachments must be smaller than 25 MB.");
    if (!ALLOWED_UPLOAD_TYPE_SET.has(file.type)) return badRequest(`${safeName(file.name)} is not a supported file type.`);
  }

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limited = rateLimit(`message:send:${user.id}`, 60, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const { data: conversation } = await supabase
    .from("conversations")
    .select("id, team_id, title")
    .eq("id", conversationId)
    .maybeSingle();
  if (!conversation) return notFound("Conversation not found or you are not a member.");

  const { data, error } = await supabase
    .from("messages")
    .insert({ conversation_id: conversationId, sender_id: user.id, body: body || "(attachment)" })
    .select("id, conversation_id, sender_id, body, kind, created_at, edited_at, deleted_at")
    .single();
  if (error || !data) return badRequest(error?.message ?? "Unable to send the message.");

  let attachmentRows: Record<string, unknown>[] = [];
  if (files.length > 0) {
    // Uploads run in parallel; a single failed file fails the whole message so
    // the sender never sees a half-delivered attachment.
    const staged: { path: string; row: Record<string, unknown> }[] = [];
    try {
      const uploaded = await Promise.all(
        files.map(async (file) => {
          const fileName = safeName(file.name);
          const storagePath = `${user.id}/${randomUUID()}-${fileName}`;
          const { error: uploadError } = await supabase.storage
            .from("message-attachments")
            .upload(storagePath, await file.arrayBuffer(), { contentType: file.type, upsert: false });
          if (uploadError) throw new Error(uploadError.message);
          return { storagePath, fileName, file };
        }),
      );
      for (const { storagePath, fileName, file } of uploaded) {
        staged.push({
          path: storagePath,
          row: { message_id: data.id, storage_path: storagePath, file_name: fileName, content_type: file.type, file_size: file.size },
        });
      }
      const { data: inserted, error: attachmentError } = await supabase
        .from("message_attachments")
        .insert(staged.map((entry) => entry.row))
        .select("id, file_name, content_type, file_size");
      if (attachmentError) throw new Error(attachmentError.message);
      attachmentRows = inserted ?? [];
    } catch (uploadFailure) {
      if (staged.length > 0) await supabase.storage.from("message-attachments").remove(staged.map((entry) => entry.path));
      // RLS gives members no DELETE policy on messages, so the orphaned row is
      // soft-deleted instead of removed; it never renders because GET filters on deleted_at.
      await supabase.from("messages").update({ deleted_at: new Date().toISOString() }).eq("id", data.id).eq("sender_id", user.id);
      return badRequest(uploadFailure instanceof Error ? uploadFailure.message : "Unable to attach that file.");
    }
  }

  const sender = await loadProfiles(supabase, [user.id]);
  const senderName = profileOf(sender, user.id)?.full_name?.trim().split(" ")[0] || "A teammate";

  // Delivery marking and notification fan-out must not delay the reply: the
  // sender's own copy already appears, and recipients get the row over Realtime
  // the moment the insert commits.
  after(async () => {
    await supabase
      .from("conversation_members")
      .update({ last_read_at: new Date().toISOString() })
      .eq("conversation_id", conversationId)
      .eq("user_id", user.id);

    const { data: members } = await supabase.from("conversation_members").select("user_id").eq("conversation_id", conversationId);
    const recipientIds = (members ?? []).map((row) => row.user_id).filter((id) => id !== user.id);
    if (recipientIds.length === 0) return;

    await notifyTeam({
      userIds: recipientIds,
      teamId: conversation.team_id,
      kind: "message",
      title: `${senderName} sent a message${conversation.title ? ` in ${conversation.title}` : ""}`,
      body: (body || "Sent an attachment").slice(0, 140),
      resourceType: "conversation",
      resourceId: conversationId,
    });
  });

  return NextResponse.json(
    {
      message: {
        ...data,
        profiles: profileOf(sender, user.id),
        message_attachments: attachmentRows,
        message_reactions: [],
      },
    },
    { status: 201 },
  );
}

/** Marks the caller's conversation as read. */
export async function PATCH(request: Request) {
  const parsed = z.object({ conversationId: z.string().uuid() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("A valid conversation is required.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data, error } = await supabase
    .from("conversation_members")
    .update({ last_read_at: new Date().toISOString() })
    .eq("conversation_id", parsed.data.conversationId)
    .eq("user_id", user.id)
    .select("conversation_id");
  if (error) return badRequest(error.message);
  if (!data || data.length === 0) return notFound("Conversation membership not found.");
  return NextResponse.json({ ok: true });
}
