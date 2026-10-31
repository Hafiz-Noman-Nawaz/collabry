import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/authz";
import { badRequest, parseUuid, unauthorized } from "@/lib/api";

function csv(rows: Array<[string, string | number]>) {
  return rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const teamId = parseUuid(url.searchParams.get("teamId"));
  if (!teamId) return badRequest("A valid team is required.");
  const format = url.searchParams.get("format");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  // RLS scopes every one of these counts to teams the caller belongs to.
  const [tasks, members, files, meetings, conversations, announcements] = await Promise.all([
    supabase.from("tasks").select("id, status, priority, due_at, created_by").eq("team_id", teamId),
    supabase.from("team_members").select("user_id, role, joined_at").eq("team_id", teamId),
    supabase.from("project_files").select("id, file_size, category, submission_status, uploaded_by").eq("team_id", teamId),
    supabase.from("meetings").select("id, status, starts_at").eq("team_id", teamId),
    supabase.from("conversations").select("id").eq("team_id", teamId),
    supabase.from("announcements").select("id").eq("team_id", teamId),
  ]);
  if (tasks.error) return badRequest(tasks.error.message);
  if (files.error) return badRequest(files.error.message);

  const taskRows = tasks.data ?? [];
  const now = Date.now();
  const byStatus: Record<string, number> = { todo: 0, in_progress: 0, in_review: 0, completed: 0 };
  const byPriority: Record<string, number> = { low: 0, medium: 0, high: 0, urgent: 0 };
  let overdue = 0;
  for (const task of taskRows) {
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
    byPriority[task.priority] = (byPriority[task.priority] ?? 0) + 1;
    if (task.due_at && new Date(task.due_at).getTime() < now && task.status !== "completed") overdue += 1;
  }
  const completed = byStatus.completed ?? 0;
  const completionRate = taskRows.length > 0 ? Math.round((completed / taskRows.length) * 100) : 0;

  const fileRows = files.data ?? [];
  const usedBytes = fileRows.reduce((sum, file) => sum + Number(file.file_size ?? 0), 0);
  const bySubmission: Record<string, number> = { draft: 0, submitted: 0, approved: 0, changes_requested: 0 };
  for (const file of fileRows) {
    const status = (file as { submission_status?: string }).submission_status ?? "draft";
    bySubmission[status] = (bySubmission[status] ?? 0) + 1;
  }

  const byRole: Record<string, number> = {};
  for (const member of members.data ?? []) byRole[member.role] = (byRole[member.role] ?? 0) + 1;

  const meetingRows = meetings.data ?? [];
  const meetingsByStatus: Record<string, number> = { scheduled: 0, cancelled: 0, completed: 0 };
  for (const meeting of meetingRows) meetingsByStatus[meeting.status] = (meetingsByStatus[meeting.status] ?? 0) + 1;

  let messageTotal = 0;
  const conversationIds = (conversations.data ?? []).map((row) => row.id);
  if (conversationIds.length > 0) {
    const { count } = await supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .in("conversation_id", conversationIds)
      .is("deleted_at", null);
    messageTotal = count ?? 0;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    tasks: {
      total: taskRows.length,
      byStatus,
      byPriority,
      overdue,
      completionRate,
    },
    files: {
      total: fileRows.length,
      usedBytes,
      quotaBytes: null,
      bySubmission,
    },
    meetings: { total: meetingRows.length, byStatus: meetingsByStatus },
    team: {
      members: (members.data ?? []).length,
      byRole,
      announcements: (announcements.data ?? []).length,
      messages: messageTotal,
    },
  };

  if (format === "csv") {
    const rows: Array<[string, string | number]> = [
      ["Metric", "Value"],
      ["Generated at", report.generatedAt],
      ["Tasks total", report.tasks.total],
      ["Tasks todo", byStatus.todo],
      ["Tasks in progress", byStatus.in_progress],
      ["Tasks in review", byStatus.in_review],
      ["Tasks completed", completed],
      ["Tasks overdue", overdue],
      ["Completion rate %", completionRate],
      ["Priority low", byPriority.low],
      ["Priority medium", byPriority.medium],
      ["Priority high", byPriority.high],
      ["Priority urgent", byPriority.urgent],
      ["Files total", report.files.total],
      ["Storage used bytes", usedBytes],
      ["Submissions draft", bySubmission.draft],
      ["Submissions submitted", bySubmission.submitted],
      ["Submissions approved", bySubmission.approved],
      ["Submissions changes requested", bySubmission.changes_requested],
      ["Meetings total", report.meetings.total],
      ["Meetings scheduled", meetingsByStatus.scheduled],
      ["Meetings cancelled", meetingsByStatus.cancelled],
      ["Meetings completed", meetingsByStatus.completed],
      ["Members", report.team.members],
      ["Announcements", report.team.announcements],
      ["Messages", messageTotal],
      ...Object.entries(byRole).map(([role, count]): [string, string | number] => [`Members with role ${role}`, count]),
    ];
    return new NextResponse(csv(rows), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="collabry-report-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  return NextResponse.json(report);
}
