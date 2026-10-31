import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/authz";
import { badRequest, parseUuid, unauthorized } from "@/lib/api";

type TimelineItem = {
  kind: "task" | "meeting" | "announcement";
  id: string;
  title: string;
  detail: string;
  at: string;
  status?: string;
  link: string;
};

/**
 * Merges tasks, meetings and announcements into one chronological feed so the
 * timeline screen renders real database rows rather than mock data.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const teamId = parseUuid(url.searchParams.get("teamId"));
  if (!teamId) return badRequest("A valid team is required.");

  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return unauthorized();

  const from = url.searchParams.get("from") ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const to = url.searchParams.get("to") ?? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

  const [tasks, meetings, announcements] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, title, status, priority, due_at, description")
      .eq("team_id", teamId)
      .not("due_at", "is", null)
      .gte("due_at", from)
      .lte("due_at", to)
      .order("due_at", { ascending: true })
      .limit(200),
    supabase
      .from("meetings")
      .select("id, title, starts_at, ends_at, status, timezone")
      .eq("team_id", teamId)
      .gte("starts_at", from)
      .lte("starts_at", to)
      .order("starts_at", { ascending: true })
      .limit(200),
    supabase
      .from("announcements")
      .select("id, title, body, created_at")
      .eq("team_id", teamId)
      .gte("created_at", from)
      .lte("created_at", to)
      .order("created_at", { ascending: true })
      .limit(100),
  ]);

  if (tasks.error) return badRequest(tasks.error.message);
  if (meetings.error) return badRequest(meetings.error.message);
  if (announcements.error) return badRequest(announcements.error.message);

  const items: TimelineItem[] = [
    ...(tasks.data ?? []).map((task) => ({
      kind: "task" as const,
      id: task.id,
      title: task.title,
      detail: task.status === "completed" ? "Completed task" : `Due · ${task.priority} priority`,
      at: task.due_at as string,
      status: task.status as string,
      link: `/tasks/${task.id}`,
    })),
    ...(meetings.data ?? []).map((meeting) => ({
      kind: "meeting" as const,
      id: meeting.id,
      title: meeting.title,
      detail: meeting.status === "cancelled" ? "Cancelled" : `Meeting · ${meeting.timezone}`,
      at: meeting.starts_at as string,
      status: meeting.status as string,
      link: `/meetings/${meeting.id}`,
    })),
    ...(announcements.data ?? []).map((item) => ({
      kind: "announcement" as const,
      id: item.id,
      title: item.title,
      detail: (item.body ?? "").slice(0, 120),
      at: item.created_at as string,
      link: "/timeline",
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return NextResponse.json({ items, range: { from, to } });
}
