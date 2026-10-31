"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { WorkspaceShell } from "@/components/WorkspaceShell";
import { createClient } from "@/lib/supabase/browser";

type Team = {
  id: string;
  name: string;
  description: string;
  university?: string | null;
  department?: string | null;
  category?: string | null;
  target_date: string | null;
};

type LiveTask = {
  id: string;
  title: string;
  status: "todo" | "in_progress" | "in_review" | "completed";
  priority: "low" | "medium" | "high" | "urgent";
  due_at: string | null;
};

type LiveMeeting = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  status: string;
};

type TeamMember = {
  user_id: string;
  role: string;
  profiles: { full_name: string } | null;
};

type ReportStats = {
  tasks: { total: number; byStatus: Record<string, number>; completionRate: number; overdue: number };
  storage: { usedBytes: number };
};

export default function Home() {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [authReady, setAuthReady] = useState(false);
  const [teams, setTeams] = useState<Team[]>([]);
  const [activeTeamIndex, setActiveTeamIndex] = useState(0);
  const [teamMessage, setTeamMessage] = useState("");

  const [liveTasks, setLiveTasks] = useState<LiveTask[]>([]);
  const [liveMeetings, setLiveMeetings] = useState<LiveMeeting[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [stats, setStats] = useState<ReportStats | null>(null);

  // Modals state
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [projectMessage, setProjectMessage] = useState("");
  const [savingProject, setSavingProject] = useState(false);

  const [inviteTeam, setInviteTeam] = useState<Team | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviteMessage, setInviteMessage] = useState("");
  const [inviting, setInviting] = useState(false);

  const [showTaskForm, setShowTaskForm] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskPriority, setTaskPriority] = useState<"low" | "medium" | "high" | "urgent">("medium");
  const [taskMessage, setTaskMessage] = useState("");
  const [savingTask, setSavingTask] = useState(false);

  const [showMeetingForm, setShowMeetingForm] = useState(false);
  const [meetingTitle, setMeetingTitle] = useState("");
  const [meetingStartsAt, setMeetingStartsAt] = useState("");
  const [meetingEndsAt, setMeetingEndsAt] = useState("");
  const [meetingMessage, setMeetingMessage] = useState("");
  const [savingMeeting, setSavingMeeting] = useState(false);

  const activeTeam = teams[activeTeamIndex] ?? null;

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) {
        startTransition(() => router.replace("/login"));
        return;
      }

      const { data: teamData, error } = await supabase
        .from("teams")
        .select("id, name, description, university, department, category, target_date")
        .order("created_at", { ascending: false });

      if (error) {
        if (!cancelled) setTeamMessage(error.message);
      } else if (!cancelled) {
        const teamList = teamData ?? [];
        setTeams(teamList);

        const first = teamList[0];
        if (first) {
          loadTeamContext(first.id);
        }
      }

      if (!cancelled) setAuthReady(true);
    }).catch(() => {
      startTransition(() => router.replace("/login"));
    });

    return () => {
      cancelled = true;
    };
  }, [router]);

  async function loadTeamContext(teamId: string) {
    try {
      const [tasksRes, meetingsRes, membersRes, reportsRes] = await Promise.all([
        fetch(`/api/tasks?teamId=${teamId}`),
        fetch(`/api/meetings?teamId=${teamId}`),
        fetch(`/api/members?teamId=${teamId}`),
        fetch(`/api/reports?teamId=${teamId}`),
      ]);

      if (tasksRes.ok) {
        const tData = await tasksRes.json();
        setLiveTasks(tData.tasks ?? []);
      }
      if (meetingsRes.ok) {
        const mData = await meetingsRes.json();
        setLiveMeetings(mData.meetings ?? []);
      }
      if (membersRes.ok) {
        const memData = await membersRes.json();
        setMembers(memData.members ?? []);
      }
      if (reportsRes.ok) {
        const rData = await reportsRes.json();
        setStats(rData);
      }
    } catch {
      // Non-blocking context fetch
    }
  }

  function handleSwitchTeam(index: number) {
    setActiveTeamIndex(index);
    const chosen = teams[index];
    if (chosen) {
      loadTeamContext(chosen.id);
    }
  }

  async function createProject() {
    if (!projectName.trim()) return;
    setSavingProject(true);
    setProjectMessage("");
    try {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("create_team", {
        team_name: projectName.trim(),
        team_description: projectDescription.trim(),
      });
      if (error) throw error;
      if (data) {
        const newTeam = data as Team;
        setTeams((current) => [newTeam, ...current]);
        setActiveTeamIndex(0);
        loadTeamContext(newTeam.id);
      }
      setProjectMessage("Project created. Your owner membership is active.");
      setProjectName("");
      setProjectDescription("");
      setShowProjectForm(false);
    } catch (error) {
      setProjectMessage(error instanceof Error ? error.message : "Unable to create project.");
    } finally {
      setSavingProject(false);
    }
  }

  async function sendInvitation() {
    if (!inviteTeam || !inviteEmail.trim()) return;
    setInviting(true);
    setInviteMessage("");
    try {
      const response = await fetch("/api/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId: inviteTeam.id, email: inviteEmail.trim(), role: inviteRole }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Unable to create invitation.");
      setInviteMessage(
        result.emailSent
          ? `Invitation emailed to ${inviteEmail.trim()}. They can accept it straight from their inbox.`
          : `Invitation created for ${inviteEmail.trim()}, but the email could not be sent. Share this link instead:\n${result.inviteUrl}`,
      );
      setInviteEmail("");
    } catch (error) {
      setInviteMessage(error instanceof Error ? error.message : "Unable to create invitation.");
    } finally {
      setInviting(false);
    }
  }

  async function createTask() {
    if (!activeTeam || !taskTitle.trim()) return;
    setSavingTask(true);
    setTaskMessage("");
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId: activeTeam.id, title: taskTitle.trim(), priority: taskPriority }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Unable to create task.");
      setLiveTasks((current) => [result.task, ...current]);
      setTaskTitle("");
      setTaskMessage("Task created.");
      setShowTaskForm(false);
      loadTeamContext(activeTeam.id);
    } catch (error) {
      setTaskMessage(error instanceof Error ? error.message : "Unable to create task.");
    } finally {
      setSavingTask(false);
    }
  }

  async function createMeeting() {
    if (!activeTeam || !meetingTitle.trim() || !meetingStartsAt || !meetingEndsAt) return;
    setSavingMeeting(true);
    setMeetingMessage("");
    try {
      const response = await fetch("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamId: activeTeam.id,
          title: meetingTitle.trim(),
          startsAt: new Date(meetingStartsAt).toISOString(),
          endsAt: new Date(meetingEndsAt).toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Unable to schedule meeting.");
      setLiveMeetings((current) => [...current, result.meeting].sort((a, b) => a.starts_at.localeCompare(b.starts_at)));
      setMeetingMessage("Meeting scheduled.");
      setMeetingTitle("");
      setMeetingStartsAt("");
      setMeetingEndsAt("");
      setShowMeetingForm(false);
    } catch (error) {
      setMeetingMessage(error instanceof Error ? error.message : "Unable to schedule meeting.");
    } finally {
      setSavingMeeting(false);
    }
  }

  if (!authReady) {
    return (
      <main className="auth-loading">
        <div className="auth-loading-spinner" />
        <span>Loading your workspace...</span>
      </main>
    );
  }

  const completionRate = stats?.tasks?.completionRate ?? 0;
  const totalTasks = stats?.tasks?.total ?? liveTasks.length;
  const completedTasks = stats?.tasks?.byStatus?.completed ?? liveTasks.filter((t) => t.status === "completed").length;

  return (
    <WorkspaceShell active="Overview">
      {/* Workspace Headline Row */}
      {activeTeam ? (
        <div className="page-title-row">
          <div>
            <p className="overline">
              {activeTeam.university ? `${activeTeam.university.toUpperCase()} / ` : ""}
              {activeTeam.category ? activeTeam.category.toUpperCase() : "ACTIVE WORKSPACE"}
            </p>
            <h1>{activeTeam.name}</h1>
            <p className="subtitle">
              {totalTasks > 0 ? (
                <>
                  Progress: <strong>{completionRate}%</strong> completed ({completedTasks} of {totalTasks} tasks)
                </>
              ) : (
                "Workspace initialized. Add tasks and invite teammates to start collaborating."
              )}
            </p>
          </div>

          {/* Real Team Members Avatars */}
          <div className="head-people" title={`${members.length} team members`}>
            {members.slice(0, 4).map((member) => {
              const name = member.profiles?.full_name || "Member";
              const initials = name.slice(0, 2).toUpperCase();
              return (
                <span key={member.user_id} title={`${name} (${member.role})`}>
                  {initials}
                </span>
              );
            })}
            {members.length > 4 && <b>+{members.length - 4}</b>}
          </div>
        </div>
      ) : (
        <div className="page-title-row">
          <div>
            <p className="overline">WORKSPACE OVERVIEW</p>
            <h1>Welcome to Collabry</h1>
            <p className="subtitle">A secure workspace for final-year projects and research teams.</p>
          </div>
        </div>
      )}

      {/* Team Selector & Strip */}
      <section className="teams-strip">
        <div className="section-heading">
          <div>
            <h2>Your projects</h2>
            <p>Private workspaces connected to your account.</p>
          </div>
          <button
            className="text-action"
            onClick={() => {
              setShowProjectForm(true);
              setProjectMessage("");
            }}
          >
            + Create project
          </button>
        </div>

        {teamMessage && <p className="team-error" role="status">{teamMessage}</p>}

        {teams.length === 0 ? (
          <div className="team-empty">
            <span>+</span>
            <div>
              <strong>No projects yet</strong>
              <p>Create your first project workspace to start inviting teammates and organizing milestones.</p>
            </div>
            <button
              onClick={() => {
                setShowProjectForm(true);
                setProjectMessage("");
              }}
            >
              Create project
            </button>
          </div>
        ) : (
          <div className="team-list">
            {teams.map((team, idx) => (
              <article
                className={`team-item ${idx === activeTeamIndex ? "active-team-card" : ""}`}
                key={team.id}
                onClick={() => handleSwitchTeam(idx)}
                style={{ cursor: "pointer" }}
              >
                <span className="team-mark">{team.name.slice(0, 1).toUpperCase()}</span>
                <div>
                  <strong>{team.name}</strong>
                  <p>{team.description || "No project description provided."}</p>
                </div>
                <small>{team.target_date ? `Due ${team.target_date}` : "Ongoing"}</small>
                <button
                  className="team-invite"
                  onClick={(e) => {
                    e.stopPropagation();
                    setInviteTeam(team);
                    setInviteMessage("");
                  }}
                >
                  Invite
                </button>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* Live Workspace Stats & Progress (Real Data) */}
      {activeTeam && (
        <div className="hero-grid" style={{ marginTop: 24 }}>
          {/* Milestone & Task Progress Card */}
          <section className="mastery-card">
            <div className="card-heading">
              <div>
                <h2>Project progress</h2>
                <p>TASKS COMPLETED</p>
              </div>
              <span className="spark">{completionRate}%</span>
            </div>
            <div className="mastery-ring">
              <div>
                <strong>{completionRate}</strong>
                <span>%</span>
                <small>COMPLETED</small>
              </div>
            </div>
            <p className="mastery-copy">
              {completedTasks} of {totalTasks} tasks completed
              <br />
              {stats?.tasks?.overdue ? `${stats.tasks.overdue} task(s) overdue` : "No overdue tasks"}
            </p>
          </section>

          {/* Quick Metrics & App Shortcuts Card */}
          <section className="flux-card" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div>
              <div className="card-heading">
                <div>
                  <h2>Quick links</h2>
                  <p>MESSAGES AND FILES</p>
                </div>
              </div>
              <p style={{ color: "#8d8eae", fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
                Open your team conversation or the shared file library for <strong>{activeTeam.name}</strong>.
              </p>
            </div>

            <div className="launcher-grid">
              <button
                className="launcher-card-btn"
                onClick={() => router.push("/messages")}
              >
                <svg className="launcher-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5Z" />
                </svg>
                <strong>Messages</strong>
                <small>Team conversations</small>
              </button>
              <button
                className="launcher-card-btn"
                onClick={() => router.push("/files")}
              >
                <svg className="launcher-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 6h7l2 2h9v10H3z" />
                </svg>
                <strong>Project files</strong>
                <small>Shared documents</small>
              </button>
            </div>
          </section>
        </div>
      )}

      {/* Real Live Task Queue */}
      <section className="live-tasks" style={{ marginTop: 24 }}>
        <div className="section-heading">
          <div>
            <h2>Tasks</h2>
            <p>Open work in {activeTeam?.name ?? "your project"}.</p>
          </div>
          <button
            className="text-action"
            disabled={!teams.length}
            onClick={() => {
              setShowTaskForm(true);
              setTaskMessage("");
            }}
          >
            + Add task
          </button>
        </div>

        {taskMessage && <p className="task-message" role="status">{taskMessage}</p>}

        {!teams.length ? (
          <div className="task-empty">Create a project first to manage tasks.</div>
        ) : !liveTasks.length ? (
          <div className="task-empty">No tasks added yet. Add the first task for this project.</div>
        ) : (
          <div className="live-task-list">
            {liveTasks.slice(0, 6).map((task) => (
              <button className="live-task" key={task.id} onClick={() => router.push(`/tasks/${task.id}`)}>
                <span className={`task-dot ${task.priority === "urgent" || task.priority === "high" ? "violet" : "cyan"}`} />
                <strong style={{ flex: 1 }}>{task.title}</strong>
                <span className={`badge ${task.status === "completed" ? "" : task.status === "in_review" ? "violet" : "muted"}`}>
                  {task.status.replace("_", " ")}
                </span>
                <small style={{ marginLeft: 8 }}>{task.priority}</small>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Real Upcoming Meetings */}
      <section className="live-tasks" style={{ marginTop: 24 }}>
        <div className="section-heading">
          <div>
            <h2>Upcoming meetings</h2>
            <p>Scheduled reviews and supervisor sessions.</p>
          </div>
          <button
            className="text-action"
            disabled={!teams.length}
            onClick={() => {
              setShowMeetingForm(true);
              setMeetingMessage("");
            }}
          >
            + Schedule
          </button>
        </div>

        {meetingMessage && !showMeetingForm && <p className="task-message" role="status">{meetingMessage}</p>}

        {!teams.length ? (
          <div className="task-empty">Create a project first to schedule meetings.</div>
        ) : !liveMeetings.length ? (
          <div className="task-empty">No meetings scheduled. Use &quot;Schedule&quot; to plan a session.</div>
        ) : (
          <div className="live-task-list">
            {liveMeetings.slice(0, 4).map((meeting) => (
              <button className="live-task" key={meeting.id} onClick={() => router.push(`/meetings/${meeting.id}`)}>
                <span className="meeting-dot">◷</span>
                <strong style={{ flex: 1 }}>{meeting.title}</strong>
                <small>
                  {new Date(meeting.starts_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                </small>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Real Kanban Work Stream */}
      <section className="kanban-card" style={{ marginTop: 24 }}>
        <div className="section-heading">
          <div>
            <h2>Task board</h2>
            <p>Every task in the active project, grouped by status.</p>
          </div>
          <button
            className="text-action"
            onClick={() => {
              if (activeTeam) router.push("/timeline");
            }}
          >
            View timeline →
          </button>
        </div>

        {liveTasks.length === 0 ? (
          <div className="task-empty" style={{ margin: "16px 0 0" }}>
            Add a task to see it on the board.
          </div>
        ) : (
          <div className="kanban-row">
            {liveTasks.map((task) => (
              <button className="kanban-item" key={task.id} onClick={() => router.push(`/tasks/${task.id}`)}>
                <span className={`task-dot ${task.priority === "urgent" ? "warn" : task.priority === "high" ? "violet" : "cyan"}`} />
                <strong style={{ flex: 1 }}>{task.title}</strong>
                <small style={{ textTransform: "capitalize" }}>
                  {task.status.replace("_", " ")} · {task.priority}
                </small>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Modal: Create Project */}
      {showProjectForm && (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowProjectForm(false)}>
          <section className="project-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" aria-label="Close" onClick={() => setShowProjectForm(false)}>✕</button>
            <p className="overline">NEW PROJECT</p>
            <h2>Create a project</h2>
            <p className="modal-copy">Start a private project space, then invite your supervisor and teammates.</p>
            <label>
              Project name
              <input
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="e.g. Autonomous Navigation Thesis"
                autoFocus
              />
            </label>
            <label>
              Description
              <textarea
                value={projectDescription}
                onChange={(e) => setProjectDescription(e.target.value)}
                placeholder="What is the team building or researching?"
                rows={3}
              />
            </label>
            {projectMessage && <p className="modal-message" role="status">{projectMessage}</p>}
            <div className="modal-actions">
              <button className="cancel-button" onClick={() => setShowProjectForm(false)}>Cancel</button>
              <button
                className="new-project"
                disabled={savingProject || !projectName.trim()}
                onClick={createProject}
              >
                {savingProject ? "Creating..." : "Create project"}
              </button>
            </div>
          </section>
        </div>
      )}

      {/* Modal: Invite Collaborator */}
      {inviteTeam && (
        <div className="modal-backdrop" role="presentation" onClick={() => setInviteTeam(null)}>
          <section className="project-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" aria-label="Close" onClick={() => setInviteTeam(null)}>✕</button>
            <p className="overline">{inviteTeam.name.toUpperCase()}</p>
            <h2>Invite a collaborator</h2>
            <p className="modal-copy">We&apos;ll email them a secure Collabry invitation right away. It expires after 72 hours and only works for that email address.</p>
            <label>
              Email address
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="student@university.edu"
                autoFocus
              />
            </label>
            <label>
              Role
              <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                <option value="member">Team member</option>
                <option value="supervisor">Supervisor</option>
                <option value="leader">Team leader</option>
                <option value="reviewer">Reviewer</option>
              </select>
            </label>
            {inviteMessage && (
              <p
                className="modal-message"
                role="status"
                style={{ whiteSpace: "pre-line", wordBreak: "break-all" }}
              >
                {inviteMessage}
              </p>
            )}
            <div className="modal-actions">
              <button className="cancel-button" onClick={() => setInviteTeam(null)}>Close</button>
              <button
                className="new-project"
                disabled={inviting || !inviteEmail.trim()}
                onClick={sendInvitation}
              >
                {inviting ? "Sending..." : "Send invitation"}
              </button>
            </div>
          </section>
        </div>
      )}

      {/* Modal: Add Task */}
      {showTaskForm && activeTeam && (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowTaskForm(false)}>
          <section className="project-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" aria-label="Close" onClick={() => setShowTaskForm(false)}>✕</button>
            <p className="overline">{activeTeam.name.toUpperCase()}</p>
            <h2>Add a task</h2>
            <p className="modal-copy">Add a task for this project.</p>
            <label>
              Task title
              <input
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder="e.g. Complete literature review draft"
                autoFocus
              />
            </label>
            <label>
              Priority
              <select
                value={taskPriority}
                onChange={(e) => setTaskPriority(e.target.value as "low" | "medium" | "high" | "urgent")}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
            {taskMessage && <p className="modal-message" role="status">{taskMessage}</p>}
            <div className="modal-actions">
              <button className="cancel-button" onClick={() => setShowTaskForm(false)}>Cancel</button>
              <button
                className="new-project"
                disabled={savingTask || !taskTitle.trim()}
                onClick={createTask}
              >
                {savingTask ? "Saving..." : "Create task"}
              </button>
            </div>
          </section>
        </div>
      )}

      {/* Modal: Schedule Meeting */}
      {showMeetingForm && activeTeam && (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowMeetingForm(false)}>
          <section className="project-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" aria-label="Close" onClick={() => setShowMeetingForm(false)}>✕</button>
            <p className="overline">{activeTeam.name.toUpperCase()}</p>
            <h2>Schedule a meeting</h2>
            <p className="modal-copy">Times use your local time zone.</p>
            <label>
              Meeting title
              <input
                value={meetingTitle}
                onChange={(e) => setMeetingTitle(e.target.value)}
                placeholder="e.g. Supervisor check-in"
                autoFocus
              />
            </label>
            <label>
              Starts
              <input
                type="datetime-local"
                value={meetingStartsAt}
                onChange={(e) => setMeetingStartsAt(e.target.value)}
              />
            </label>
            <label>
              Ends
              <input
                type="datetime-local"
                value={meetingEndsAt}
                onChange={(e) => setMeetingEndsAt(e.target.value)}
              />
            </label>
            {meetingMessage && <p className="modal-message" role="status">{meetingMessage}</p>}
            <div className="modal-actions">
              <button className="cancel-button" onClick={() => setShowMeetingForm(false)}>Cancel</button>
              <button
                className="new-project"
                disabled={savingMeeting || !meetingTitle.trim() || !meetingStartsAt || !meetingEndsAt}
                onClick={createMeeting}
              >
                {savingMeeting ? "Scheduling..." : "Schedule meeting"}
              </button>
            </div>
          </section>
        </div>
      )}
    </WorkspaceShell>
  );
}
