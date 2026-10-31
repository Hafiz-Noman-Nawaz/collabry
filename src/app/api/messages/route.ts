import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
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

const MESSAGE_SELECT =
  "id, conversation_id, sender_id, body, kind, created_at, edited_at, message_attachments(id, file_name, content_type, file_size, storage_path), message_reactions(user_id, emoji)";

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
  const messages = rows.map((row) => ({
    ...row,
    profiles: profileOf(senders, row.sender_id),
    message_attachments: (row.message_attachments ?? []).filter((attachment: { storage_path: string }) => !attachment.storage_path.startsWith("_")),
  }));
  return NextResponse.json({ messages, total: count ?? 0 });
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  const isMultipart = contentType.includes("multipart/form-data");

  let conversationId = "";
  let body = "";
  let file: File | null = null;
  if (isMultipart) {
    const formData = await request.formData();
    conversationId = String(formData.get("conversationId") ?? "");
    body = String(formData.get("body") ?? "").trim();
    const candidate = formData.get("file");
    file = candidate instanceof File && candidate.size > 0 ? candidate : null;
  } else {
    const parsed = jsonSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return badRequest("Invalid message.");
    conversationId = parsed.data.conversationId;
    body = parsed.data.body;
  }
  if (!parseUuid(conversationId)) return badRequest("A valid conversation is required.");
  if (body.length === 0 && !file) return badRequest("Message cannot be empty.");
  if (body.length > 4000) return badRequest("Message is too long.");
  if (file) {
    if (file.size > MAX_ATTACHMENT_SIZE) return badRequest("Attachments must be smaller than 25 MB.");
    if (!ALLOWED_UPLOAD_TYPE_SET.has(file.type)) return badRequest("This file type is not supported.");
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
    .select("id, conversation_id, sender_id, body, kind, created_at, edited_at")
    .single();
  if (error || !data) return badRequest(error?.message ?? "Unable to send the message.");

  let attachmentRow: Record<string, unknown> | null = null;
  if (file) {
    const fileName = safeName(file.name);
    const storagePath = `${user.id}/${randomUUID()}-${fileName}`;
    const upload = await supabase.storage.from("message-attachments").upload(storagePath, await file.arrayBuffer(), { contentType: file.type, upsert: false });
    if (upload.error) return badRequest(upload.error.message);
    const { data: inserted, error: attachmentError } = await supabase
      .from("message_attachments")
      .insert({ message_id: data.id, storage_path: storagePath, file_name: fileName, content_type: file.type, file_size: file.size })
      .select("id, file_name, content_type, file_size, storage_path")
      .single();
    if (attachmentError) {
      await supabase.storage.from("message-attachments").remove([storagePath]);
      return badRequest(attachmentError.message);
    }
    attachmentRow = inserted;
  }

  // Delivery marker for the sender plus notifications for everyone else.
  await supabase
    .from("conversation_members")
    .update({ last_read_at: new Date().toISOString() })
    .eq("conversation_id", conversationId)
    .eq("user_id", user.id);

  const { data: members } = await supabase.from("conversation_members").select("user_id").eq("conversation_id", conversationId);
  const recipientIds = (members ?? []).map((row) => row.user_id).filter((id) => id !== user.id);
  if (recipientIds.length > 0) {
    await notifyTeam({
      userIds: recipientIds,
      teamId: conversation.team_id,
      kind: "message",
      title: `New message in ${conversation.title ?? "Team conversation"}`,
      body: (body || "Sent an attachment").slice(0, 140),
      resourceType: "conversation",
      resourceId: conversationId,
    });
  }

  const sender = await loadProfiles(supabase, [user.id]);
  return NextResponse.json(
    {
      message: {
        ...data,
        profiles: profileOf(sender, user.id),
        message_attachments: attachmentRow ? [attachmentRow] : [],
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
