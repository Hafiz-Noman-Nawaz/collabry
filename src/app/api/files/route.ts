import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/authz";
import { badRequest, parseUuid, queryInt, unauthorized } from "@/lib/api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { recordAudit } from "@/lib/audit";
import { ALLOWED_UPLOAD_TYPE_SET } from "@/lib/uploads";

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const DEFAULT_QUOTA = 1024 * 1024 * 1024;

const BASE_FILE_SELECT = "id, team_id, file_name, category, content_type, file_size, created_at, uploaded_by";
const EXT_FILE_SELECT =
  "id, team_id, file_name, category, content_type, file_size, created_at, uploaded_by, task_id, submission_status, review_note, reviewed_by, reviewed_at";

let _hasWorkflowColumns: boolean | null = null;
async function supportsWorkflowColumns(supabase: Awaited<ReturnType<typeof createClient>>): Promise<boolean> {
  if (_hasWorkflowColumns !== null) return _hasWorkflowColumns;
  const { error } = await supabase.from("project_files").select("task_id").limit(0);
  _hasWorkflowColumns = !error;
  return _hasWorkflowColumns;
}

function normalizeFile(file: unknown) {
  const obj = (file && typeof file === "object" ? file : {}) as Record<string, unknown>;
  return {
    task_id: null,
    submission_status: "draft",
    review_note: "",
    reviewed_by: null,
    reviewed_at: null,
    ...obj,
  };
}

function safeName(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 140) || "upload";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const teamId = parseUuid(url.searchParams.get("teamId"));
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();
  if (!teamId) return badRequest("A team is required.");

  const limit = queryInt(url, "limit", 50, 200);
  const offset = queryInt(url, "offset", 0, 5000);
  const search = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
  const category = (url.searchParams.get("category") ?? "").trim().slice(0, 40);
  const status = url.searchParams.get("status");
  const sort = url.searchParams.get("sort") === "name" ? "file_name" : "created_at";

  const hasWorkflow = await supportsWorkflowColumns(supabase);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query = (supabase.from("project_files") as any)
    .select(hasWorkflow ? EXT_FILE_SELECT : BASE_FILE_SELECT, { count: "exact" })
    .eq("team_id", teamId)
    .order(sort, { ascending: sort === "file_name" })
    .range(offset, offset + limit - 1);
  if (search) query = query.or(`file_name.ilike.%${search}%,category.ilike.%${search}%`);
  if (category) query = query.eq("category", category);
  if (hasWorkflow && status && ["draft", "submitted", "approved", "changes_requested"].includes(status)) {
    query = query.eq("submission_status", status);
  }

  const { data, error, count } = await query;
  if (error) return badRequest(error.message);

  const { data: totals } = await supabase
    .from("project_files")
    .select("file_size")
    .eq("team_id", teamId);
  const usedBytes = (totals ?? []).reduce((sum, row) => sum + Number(row.file_size ?? 0), 0);
  const { data: teamRow } = await supabase.from("teams").select("storage_quota_bytes").eq("id", teamId).maybeSingle();
  const quotaBytes = Number(teamRow?.storage_quota_bytes ?? DEFAULT_QUOTA);

  return NextResponse.json({
    files: (Array.isArray(data) ? data : []).map(normalizeFile),
    total: count ?? 0,
    usage: { usedBytes, quotaBytes, percentUsed: quotaBytes > 0 ? Math.round((usedBytes / quotaBytes) * 100) : 0 },
  });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const limited = rateLimit(`file:upload:${user.id}`, 20, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds);

  const formData = await request.formData();
  const teamId = String(formData.get("teamId") ?? "");
  const category = String(formData.get("category") ?? "general").trim().slice(0, 40) || "general";
  const taskId = String(formData.get("taskId") ?? "");
  const file = formData.get("file");
  if (!parseUuid(teamId) || !(file instanceof File)) return badRequest("A team and file are required.");
  if (file.size === 0 || file.size > MAX_FILE_SIZE) return badRequest("Files must be smaller than 100 MB.");
  if (!ALLOWED_UPLOAD_TYPE_SET.has(file.type)) {
    return NextResponse.json({ error: "This file type is not supported." }, { status: 415 });
  }

  // Quota is checked before the storage write so the team never exceeds its limit.
  const { data: teamRow } = await supabase.from("teams").select("storage_quota_bytes").eq("id", teamId).maybeSingle();
  const quotaBytes = Number(teamRow?.storage_quota_bytes ?? DEFAULT_QUOTA);
  const { data: usageRows } = await supabase.from("project_files").select("file_size").eq("team_id", teamId);
  const usedBytes = (usageRows ?? []).reduce((sum, row) => sum + Number(row.file_size ?? 0), 0);
  if (usedBytes + file.size > quotaBytes) {
    return NextResponse.json(
      { error: `Team storage quota exceeded (${Math.round(quotaBytes / 1048576)} MB). Delete files to free space.` },
      { status: 413 },
    );
  }

  let linkedTaskId: string | null = null;
  if (taskId && parseUuid(taskId)) {
    const { data: task } = await supabase.from("tasks").select("id").eq("id", taskId).eq("team_id", teamId).maybeSingle();
    if (!task) return badRequest("That task does not belong to this team.");
    linkedTaskId = task.id;
  }

  const fileName = safeName(file.name);
  const storagePath = `${teamId}/${user.id}/${randomUUID()}-${fileName}`;
  const upload = await supabase.storage.from("project-files").upload(storagePath, await file.arrayBuffer(), { contentType: file.type, upsert: false });
  if (upload.error) return badRequest(upload.error.message);

  const hasWorkflow = await supportsWorkflowColumns(supabase);
  const insertPayload: Record<string, unknown> = {
    team_id: teamId,
    uploaded_by: user.id,
    storage_path: storagePath,
    file_name: fileName,
    category,
    content_type: file.type,
    file_size: file.size,
  };
  if (hasWorkflow && linkedTaskId) {
    insertPayload.task_id = linkedTaskId;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase.from("project_files") as any)
    .insert(insertPayload)
    .select(hasWorkflow ? EXT_FILE_SELECT : BASE_FILE_SELECT)
    .single();
  if (error) {
    await supabase.storage.from("project-files").remove([storagePath]);
    return badRequest(error.message);
  }

  const normalized = normalizeFile(data);
  const fileId = String((normalized as Record<string, unknown>).id ?? "");
  await recordAudit({ actorId: user.id, teamId, action: "file.uploaded", resourceType: "file", resourceId: fileId, metadata: { fileName, bytes: file.size } });
  return NextResponse.json({ file: normalized, usage: { usedBytes: usedBytes + file.size, quotaBytes } }, { status: 201 });
}
