import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser, getMembership, hasRole, REVIEWER_ROLES } from "@/lib/authz";
import { badRequest, forbidden, notFound, unauthorized } from "@/lib/api";
import { recordAudit } from "@/lib/audit";
import { notifyTeam } from "@/lib/notify";

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

const patchSchema = z
  .object({
    category: z.string().trim().min(1).max(40).optional(),
    submissionStatus: z.enum(["draft", "submitted", "approved", "changes_requested"]).optional(),
    reviewNote: z.string().trim().max(2000).optional(),
    taskId: z.string().uuid().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update." });

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data: file, error } = await supabase.from("project_files").select("storage_path, file_name").eq("id", id).single();
  if (error || !file) return notFound("File not found.");
  const admin = createAdminClient();
  const { data: signed, error: signedError } = await admin.storage.from("project-files").createSignedUrl(file.storage_path, 60 * 5, { download: file.file_name });
  if (signedError) return badRequest(signedError.message);
  return NextResponse.json({ url: signed.signedUrl, expiresIn: 300 });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid file update.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data: current } = await supabase
    .from("project_files")
    .select("id, team_id, file_name, uploaded_by")
    .eq("id", id)
    .maybeSingle();
  if (!current) return notFound("File not found.");

  const membership = await getMembership(supabase, current.team_id, user.id);
  const isReviewer = hasRole(membership?.role, REVIEWER_ROLES);
  const isOwnerFile = current.uploaded_by === user.id;

  const hasWorkflow = await supportsWorkflowColumns(supabase);
  const patch: Record<string, unknown> = {};
  if (parsed.data.category !== undefined) {
    if (!isOwnerFile && !isReviewer) return forbidden("Only the uploader can recategorise this file.");
    patch.category = parsed.data.category;
  }
  if (parsed.data.taskId !== undefined && hasWorkflow) {
    if (!isOwnerFile && !isReviewer) return forbidden("Only the uploader can link this file to a task.");
    patch.task_id = parsed.data.taskId;
  }
  if (parsed.data.submissionStatus !== undefined && hasWorkflow) {
    const reviewerDecision = ["approved", "changes_requested"].includes(parsed.data.submissionStatus);
    if (reviewerDecision) {
      if (!isReviewer) return forbidden("Only reviewers can approve or reject submissions.");
      patch.reviewed_by = user.id;
      patch.reviewed_at = new Date().toISOString();
      patch.review_note = parsed.data.reviewNote ?? "";
    } else {
      if (!isOwnerFile) return forbidden("Only the uploader can submit this file for review.");
    }
    patch.submission_status = parsed.data.submissionStatus;
  } else if (parsed.data.reviewNote !== undefined && isReviewer && hasWorkflow) {
    patch.review_note = parsed.data.reviewNote;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ file: normalizeFile(current) });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase.from("project_files") as any)
    .update(patch)
    .eq("id", id)
    .select(hasWorkflow ? EXT_FILE_SELECT : BASE_FILE_SELECT)
    .single();
  if (error || !data) return badRequest(error?.message ?? "Unable to update the file.");

  await recordAudit({ actorId: user.id, teamId: current.team_id, action: "file.updated", resourceType: "file", resourceId: id, metadata: { fields: Object.keys(patch) } });

  if (parsed.data.submissionStatus === "submitted") {
    const { data: teamMembers } = await supabase.from("team_members").select("user_id, role").eq("team_id", current.team_id);
    const reviewers = (teamMembers ?? []).filter((row) => ["owner", "supervisor", "leader", "reviewer"].includes(row.role)).map((row) => row.user_id);
    if (reviewers.length > 0) {
      await notifyTeam({
        userIds: reviewers,
        teamId: current.team_id,
        kind: "review",
        title: `Submission for review: ${current.file_name}`,
        body: "A teammate submitted a file.",
        resourceType: "file",
        resourceId: id,
      });
    }
  }

  return NextResponse.json({ file: normalizeFile(data) });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const { data: current } = await supabase
    .from("project_files")
    .select("id, team_id, file_name, storage_path, uploaded_by")
    .eq("id", id)
    .maybeSingle();
  if (!current) return notFound("File not found.");

  const { error } = await supabase.from("project_files").delete().eq("id", id);
  // RLS only allows the uploader or a team manager to delete.
  if (error) return forbidden("You cannot delete this file.");
  await supabase.storage.from("project-files").remove([current.storage_path]);
  await recordAudit({ actorId: user.id, teamId: current.team_id, action: "file.deleted", resourceType: "file", resourceId: id, metadata: { fileName: current.file_name } });
  return NextResponse.json({ ok: true });
}
