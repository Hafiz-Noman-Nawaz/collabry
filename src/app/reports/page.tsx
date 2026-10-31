"use client";

import { useEffect, useState } from "react";
import { WorkspaceShell } from "@/components/WorkspaceShell";
import { useWorkspace } from "@/lib/useWorkspace";
import { formatBytes, titleCase } from "@/lib/format";

type Report = {
  generatedAt: string;
  tasks: { total: number; byStatus: Record<string, number>; byPriority: Record<string, number>; overdue: number; completionRate: number };
  files: { total: number; usedBytes: number; bySubmission: Record<string, number> };
  meetings: { total: number; byStatus: Record<string, number> };
  team: { members: number; byRole: Record<string, number>; announcements: number; messages: number };
};

function BarRow({ label, value, max, cyan }: { label: string; value: number; max: number; cyan?: boolean }) {
  const width = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="bar-row">
      <span>{label}</span>
      <span className="track"><span className={`fill${cyan ? " cyan" : ""}`} style={{ width: `${width}%` }} /></span>
      <b>{value}</b>
    </div>
  );
}

export default function ReportsPage() {
  const { ready, teamId, error } = useWorkspace();
  const [report, setReport] = useState<Report | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    async function load() {
      const response = await fetch(`/api/reports?teamId=${teamId}`);
      if (cancelled) return;
      if (response.ok) setReport(await response.json());
      else {
        const result = await response.json().catch(() => ({}));
        setMessage(result.error ?? "Unable to load the report.");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const statusMax = report ? Math.max(1, ...Object.values(report.tasks.byStatus)) : 1;
  const priorityMax = report ? Math.max(1, ...Object.values(report.tasks.byPriority)) : 1;
  const roleMax = report ? Math.max(1, ...Object.values(report.team.byRole)) : 1;
  const submissionMax = report ? Math.max(1, ...Object.values(report.files.bySubmission)) : 1;

  return (
    <WorkspaceShell active="Reports">
      <div className="screen-heading">
        <div>
          <p className="overline">REPORTS</p>
          <h1>Reports</h1>
          <p>Task, submission and team figures for the selected project.</p>
        </div>
        <button className="new-project" disabled={!teamId} onClick={() => window.open(`/api/reports?teamId=${teamId}&format=csv`, "_blank", "noopener,noreferrer")}>
          ↓ Export CSV
        </button>
      </div>

      {message && <p className="screen-message error" role="status">{message}</p>}
      {error && <p className="screen-message error" role="status">{error}</p>}

      {!ready ? (
        <div className="screen-empty"><strong>Loading report…</strong></div>
      ) : !teamId ? (
        <div className="screen-empty">
          <strong>No project selected</strong>
          <p>Create a project to see task, submission and team figures.</p>
        </div>
      ) : !report ? (
        <div className="screen-empty"><strong>Preparing the report…</strong></div>
      ) : (
        <>
          <section className="stat-grid">
            <article className="stat-card accent"><span>Tasks total</span><strong>{report.tasks.total}</strong><small>{report.tasks.completionRate}% complete</small></article>
            <article className="stat-card warn"><span>Overdue tasks</span><strong>{report.tasks.overdue}</strong><small>Past their due date</small></article>
            <article className="stat-card cyan"><span>Storage used</span><strong>{formatBytes(report.files.usedBytes)}</strong><small>{report.files.total} files stored</small></article>
            <article className="stat-card"><span>Meetings</span><strong>{report.meetings.total}</strong><small>{report.meetings.byStatus.scheduled ?? 0} scheduled</small></article>
            <article className="stat-card"><span>Team</span><strong>{report.team.members}</strong><small>{report.team.messages} messages sent</small></article>
            <article className="stat-card"><span>Announcements</span><strong>{report.team.announcements}</strong><small>Posted to the team</small></article>
          </section>

          <div className="report-grid">
            <section className="panel">
              <h2>Tasks by status</h2>
              <p className="panel-sub">Tasks in each stage</p>
              <BarRow label="To do" value={report.tasks.byStatus.todo ?? 0} max={statusMax} />
              <BarRow label="In progress" value={report.tasks.byStatus.in_progress ?? 0} max={statusMax} />
              <BarRow label="In review" value={report.tasks.byStatus.in_review ?? 0} max={statusMax} />
              <BarRow label="Completed" value={report.tasks.byStatus.completed ?? 0} max={statusMax} cyan />
            </section>

            <section className="panel">
              <h2>Tasks by priority</h2>
              <p className="panel-sub">Tasks grouped by priority</p>
              <BarRow label="Urgent" value={report.tasks.byPriority.urgent ?? 0} max={priorityMax} />
              <BarRow label="High" value={report.tasks.byPriority.high ?? 0} max={priorityMax} />
              <BarRow label="Medium" value={report.tasks.byPriority.medium ?? 0} max={priorityMax} cyan />
              <BarRow label="Low" value={report.tasks.byPriority.low ?? 0} max={priorityMax} cyan />
            </section>

            <section className="panel">
              <h2>Submissions</h2>
              <p className="panel-sub">Files moving through review</p>
              <BarRow label="Draft" value={report.files.bySubmission.draft ?? 0} max={submissionMax} />
              <BarRow label="Submitted" value={report.files.bySubmission.submitted ?? 0} max={submissionMax} />
              <BarRow label="Approved" value={report.files.bySubmission.approved ?? 0} max={submissionMax} cyan />
              <BarRow label="Changes" value={report.files.bySubmission.changes_requested ?? 0} max={submissionMax} />
            </section>

            <section className="panel">
              <h2>Team composition</h2>
              <p className="panel-sub">Team members by role</p>
              {Object.keys(report.team.byRole).length === 0 ? (
                <p className="panel-sub">No members yet.</p>
              ) : (
                Object.entries(report.team.byRole).map(([role, count]) => (
                  <BarRow key={role} label={titleCase(role)} value={count} max={roleMax} cyan />
                ))
              )}
            </section>
          </div>

          <p className="panel-sub">Generated {new Date(report.generatedAt).toLocaleString()}</p>
        </>
      )}
    </WorkspaceShell>
  );
}
