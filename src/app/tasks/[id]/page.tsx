"use client";

import { FormEvent, Suspense, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useParams } from "next/navigation";
import { WorkspaceShell } from "@/components/WorkspaceShell";
import { createClient } from "@/lib/supabase/browser";
import { formatBytes, titleCase, toDateTimeInput } from "@/lib/format";

type ProfileLite = { id: string; full_name: string; university: string | null } | null;
type ChecklistItem = { id: string; body: string; done: boolean; position: number };
type Comment = { id: string; body: string; author_id: string; created_at: string; updated_at: string; profiles: ProfileLite };
type TaskEvent = { id: string; event_type: string; from_value: string | null; to_value: string | null; created_at: string; profiles: ProfileLite };
type Review = { id: string; state: string; body: string; created_at: string; profiles: ProfileLite };
type Member = { user_id: string; role: string; profiles: ProfileLite };
type LinkedFile = { id: string; file_name: string; file_size: number; category: string; submission_status: string; task_id: string | null; uploaded_by: string };
type Task = {
  id: string;
  team_id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  due_at: string | null;
  created_at: string;
  created_by: string;
  task_assignees: Array<{ user_id: string; profiles: ProfileLite }>;
  task_comments: Comment[];
  task_checklist_items: ChecklistItem[];
  task_events: TaskEvent[];
  task_reviews: Review[];
};

const STATUSES = ["todo", "in_progress", "in_review", "completed"];
const PRIORITIES = ["low", "medium", "high", "urgent"];
const REVIEWER_ROLES = ["owner", "supervisor", "leader", "reviewer"];
const MANAGER_ROLES = ["owner", "supervisor", "leader"];

const EVENT_LABELS: Record<string, string> = {
  created: "created this task",
  updated: "updated details",
  status: "changed status",
  assignees_changed: "changed assignees",
};

function eventLabel(eventType: string) {
  return EVENT_LABELS[eventType] ?? titleCase(eventType);
}

export default function TaskPage() {
  // useParams() and the shell's usePathname() need the runtime URL, so the boundary streams them
  // and its fallback stays free of any hook that reads URL data.
  return (
    <Suspense
      fallback={
        <div className="screen-empty">
          <strong>Loading task...</strong>
          <p>Reading its details, checklist and history.</p>
        </div>
      }
    >
      <TaskScreen />
    </Suspense>
  );
}

function TaskScreen() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const taskId = params?.id ?? "";

  const [task, setTask] = useState<Task | null>(null);
  const [userId, setUserId] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [files, setFiles] = useState<LinkedFile[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState("medium");
  const [dueAt, setDueAt] = useState("");
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);

  const [checklistBody, setChecklistBody] = useState("");
  const [commentBody, setCommentBody] = useState("");
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [attachFileId, setAttachFileId] = useState("");

  const load = useCallback(async () => {
    const response = await fetch(`/api/tasks/${taskId}`);
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      setMessage(result.error ?? "Task not found.");
      return;
    }
    const result = await response.json();
    const loaded: Task = result.task;
    setTask(loaded);
    setTitle(loaded.title);
    setDescription(loaded.description ?? "");
    setStatus(loaded.status);
    setPriority(loaded.priority);
    setDueAt(toDateTimeInput(loaded.due_at));
    setAssigneeIds((loaded.task_assignees ?? []).map((row) => row.user_id));

    const [memberResponse, fileResponse] = await Promise.all([
      fetch(`/api/members?teamId=${loaded.team_id}`),
      fetch(`/api/files?teamId=${loaded.team_id}&limit=100&offset=0`),
    ]);
    if (memberResponse.ok) setMembers((await memberResponse.json()).members ?? []);
    if (fileResponse.ok) {
      const fileResult = await fileResponse.json();
      setFiles(((fileResult.files ?? []) as LinkedFile[]).filter((file) => file.submission_status !== "draft" || file.task_id === taskId));
    }
  }, [taskId]);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    async function start() {
      const supabase = createClient();
      const { data } = await supabase.auth.getUser();
      if (cancelled) return;
      if (!data.user) {
        router.replace("/login");
        return;
      }
      setUserId(data.user.id);
      await load();
    }
    start();
    return () => {
      cancelled = true;
    };
  }, [taskId, load, router]);

  const myRole = members.find((member) => member.user_id === userId)?.role ?? null;
  const canReview = REVIEWER_ROLES.includes(myRole ?? "");
  const canDelete = !!task && (task.created_by === userId || MANAGER_ROLES.includes(myRole ?? ""));
  const doneCount = (task?.task_checklist_items ?? []).filter((item) => item.done).length;
  const totalItems = (task?.task_checklist_items ?? []).length;
  const attachedFiles = files.filter((file) => file.task_id === taskId);
  const attachableFiles = files.filter((file) => file.task_id !== taskId && file.submission_status !== "draft");
  // Embedded rows arrive unordered from PostgREST, so the screen sorts them itself.
  const checklist = [...(task?.task_checklist_items ?? [])].sort((a, b) => a.position - b.position);
  const comments = [...(task?.task_comments ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const events = [...(task?.task_events ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const reviews = [...(task?.task_reviews ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at));

  async function request(path: string, init?: RequestInit) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(result.error ?? "That did not work.");
        return null;
      }
      return result;
    } finally {
      setBusy(false);
    }
  }

  async function deleteTask() {
    if (!task) return;
    if (!window.confirm(`Delete "${task.title}"? Its comments, checklist and review history are removed too.`)) return;
    const result = await request(`/api/tasks/${taskId}`, { method: "DELETE" });
    if (result) router.push("/");
  }

  async function saveDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await request(`/api/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: title.trim(),
        description: description.trim(),
        status,
        priority,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        assigneeIds,
      }),
    });
    if (result) {
      setMessage("Task saved.");
      await load();
    }
  }

  async function addChecklist(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!checklistBody.trim()) return;
    const result = await request(`/api/tasks/${taskId}/checklist`, {
      method: "POST",
      body: JSON.stringify({ body: checklistBody.trim() }),
    });
    if (result) {
      setChecklistBody("");
      setTask((current) => (current ? { ...current, task_checklist_items: [...current.task_checklist_items, result.item] } : current));
    }
  }

  async function toggleChecklist(item: ChecklistItem) {
    const result = await request(`/api/tasks/${taskId}/checklist`, {
      method: "PATCH",
      body: JSON.stringify({ id: item.id, done: !item.done }),
    });
    if (result) {
      setTask((current) =>
        current
          ? { ...current, task_checklist_items: current.task_checklist_items.map((row) => (row.id === item.id ? { ...row, done: result.item.done } : row)) }
          : current,
      );
    }
  }

  async function removeChecklist(id: string) {
    const result = await request(`/api/tasks/${taskId}/checklist?id=${id}`, { method: "DELETE" });
    if (result) setTask((current) => (current ? { ...current, task_checklist_items: current.task_checklist_items.filter((row) => row.id !== id) } : current));
  }

  async function addComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!commentBody.trim()) return;
    const result = await request(`/api/tasks/${taskId}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: commentBody.trim() }),
    });
    if (result) {
      setCommentBody("");
      setTask((current) => (current ? { ...current, task_comments: [...current.task_comments, result.comment] } : current));
    }
  }

  async function saveComment() {
    if (!editing) return;
    const result = await request(`/api/tasks/${taskId}/comments`, {
      method: "PATCH",
      body: JSON.stringify({ id: editing.id, body: editing.body.trim() }),
    });
    if (result) {
      setEditing(null);
      setTask((current) => (current ? { ...current, task_comments: current.task_comments.map((row) => (row.id === result.comment.id ? result.comment : row)) } : current));
    }
  }

  async function removeComment(id: string) {
    const result = await request(`/api/tasks/${taskId}/comments?id=${id}`, { method: "DELETE" });
    if (result) setTask((current) => (current ? { ...current, task_comments: current.task_comments.filter((row) => row.id !== id) } : current));
  }

  async function linkFile(file: LinkedFile, attach: boolean) {
    const result = await request(`/api/files/${file.id}`, {
      method: "PATCH",
      body: JSON.stringify({ taskId: attach ? taskId : null }),
    });
    if (result) {
      setMessage(attach ? `Linked ${file.file_name} to this task.` : `Unlinked ${file.file_name}.`);
      await load();
    }
  }

  async function decide(state: "approved" | "changes_requested") {
    const result = await request(`/api/tasks/${taskId}/reviews`, {
      method: "POST",
      body: JSON.stringify({ state, body: reviewNote.trim() }),
    });
    if (result) {
      setReviewNote("");
      setMessage(state === "approved" ? "Approved." : "Changes requested.");
      await load();
    }
  }

  if (!task) {
    return (
      <WorkspaceShell active="">
        <div className="screen-empty">
          <strong>{message || "Loading task..."}</strong>
          <p>{message ? "Check the link or return to your dashboard." : "Reading its details, checklist and history."}</p>
          <button className="ghost" onClick={() => router.push("/")}>Back to dashboard</button>
        </div>
      </WorkspaceShell>
    );
  }

  return (
    <WorkspaceShell active="" dense>
      <div className="screen-heading">
        <div>
          <p className="overline">TASK</p>
          <h1>{task.title}</h1>
          <p>Work on this task with your team: checklist, comments and review decisions.</p>
        </div>
        <button className="ghost" onClick={() => router.push("/")}>← Dashboard</button>
      </div>

      {message && <p className="screen-message" role="status">{message}</p>}

      <section className="panel">
        <h2>Details</h2>
        <p className="panel-sub">Everyone on the project sees these details.</p>
        <form className="form-grid" onSubmit={saveDetails}>
          <label>
            Title
            <input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} />
          </label>
          <div className="form-grid two">
            <label>
              Status
              <select value={status} onChange={(event) => setStatus(event.target.value)}>
                {STATUSES.map((item) => <option key={item} value={item}>{titleCase(item)}</option>)}
              </select>
            </label>
            <label>
              Priority
              <select value={priority} onChange={(event) => setPriority(event.target.value)}>
                {PRIORITIES.map((item) => <option key={item} value={item}>{titleCase(item)}</option>)}
              </select>
            </label>
            <label>
              Due date
              <input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
            </label>
            <label>
              Assignees
              <div className="data-list" style={{ maxHeight: 150, overflowY: "auto" }}>
                {members.map((member) => (
                  <label key={member.user_id} style={{ gridAutoFlow: "column", alignItems: "center", justifyContent: "start", gap: 9, fontWeight: 400 }}>
                    <input
                      type="checkbox"
                      style={{ width: "auto" }}
                      checked={assigneeIds.includes(member.user_id)}
                      onChange={(event) =>
                        setAssigneeIds((current) => (event.target.checked ? [...current, member.user_id] : current.filter((id) => id !== member.user_id)))
                      }
                    />
                    {member.profiles?.full_name ?? "Unnamed member"}
                  </label>
                ))}
              </div>
            </label>
          </div>
          <label>
            Description
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} maxLength={4000} placeholder="What does done look like?" />
          </label>
          <div className="form-actions">
            <button className="primary" disabled={busy}>{busy ? "Saving..." : "Save changes"}</button>
            {canDelete && (
              <button className="ghost" disabled={busy} onClick={deleteTask}>Delete task</button>
            )}
          </div>
        </form>
      </section>

      <section className="panel">
        <h2>Checklist</h2>
        <p className="panel-sub">{totalItems > 0 ? `${doneCount} of ${totalItems} complete` : "No steps added yet."}</p>
        <form className="form-grid" onSubmit={addChecklist} style={{ marginBottom: 14 }}>
          <div className="form-grid inline-form-row two">
            <label>
              New step
              <input value={checklistBody} onChange={(event) => setChecklistBody(event.target.value)} maxLength={200} placeholder="e.g. Draft methodology section" />
            </label>
            <button className="primary" disabled={busy || !checklistBody.trim()}>Add</button>
          </div>
        </form>
        {checklist.length === 0 ? (
          <div className="screen-empty"><strong>No steps yet</strong><p>Add the small checks that show this task is genuinely finished.</p></div>
        ) : (
          <div className="data-list">
            {checklist.map((item) => (
              <article className="data-row" key={item.id}>
                <input type="checkbox" style={{ width: "auto" }} checked={item.done} onChange={() => toggleChecklist(item)} aria-label={`Mark ${item.body} ${item.done ? "not done" : "done"}`} />
                <div className="row-main">
                  <strong style={item.done ? { textDecoration: "line-through", color: "#8b8bab" } : undefined}>{item.body}</strong>
                </div>
                <div className="row-actions">
                  <button className="muted" onClick={() => removeChecklist(item.id)} disabled={busy}>Remove</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Discussion</h2>
        <p className="panel-sub">{comments.length} COMMENT{comments.length === 1 ? "" : "S"}</p>
        {comments.length === 0 ? (
          <div className="screen-empty"><strong>No comments yet</strong><p>Ask a question or leave context for your teammates.</p></div>
        ) : (
          <div className="data-list" style={{ marginBottom: 14 }}>
            {comments.map((comment) => (
              <article className="data-row" key={comment.id} style={{ alignItems: "flex-start" }}>
                <div className="row-main">
                  <strong>{comment.profiles?.full_name ?? "Unnamed member"}</strong>
                  {editing?.id === comment.id ? (
                    <textarea value={editing.body} onChange={(event) => setEditing({ id: comment.id, body: event.target.value })} rows={3} maxLength={4000} style={{ width: "100%", marginTop: 7 }} />
                  ) : (
                    <p style={{ whiteSpace: "pre-wrap" }}>{comment.body}</p>
                  )}
                  <p>{new Date(comment.created_at).toLocaleString()}{comment.updated_at !== comment.created_at ? " · edited" : ""}</p>
                </div>
                <div className="row-actions">
                  {editing?.id === comment.id ? (
                    <>
                      <button onClick={saveComment} disabled={busy || !editing.body.trim()}>Save</button>
                      <button className="muted" onClick={() => setEditing(null)}>Cancel</button>
                    </>
                  ) : comment.author_id === userId ? (
                    <>
                      <button onClick={() => setEditing({ id: comment.id, body: comment.body })}>Edit</button>
                      <button className="muted" onClick={() => removeComment(comment.id)} disabled={busy}>Delete</button>
                    </>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
        <form className="form-grid" onSubmit={addComment}>
          <label>
            Add a comment
            <textarea value={commentBody} onChange={(event) => setCommentBody(event.target.value)} rows={3} maxLength={4000} placeholder="Share an update, blocker or link." />
          </label>
          <div className="form-actions">
            <button className="primary" disabled={busy || !commentBody.trim()}>Post comment</button>
          </div>
        </form>
      </section>

      <section className="panel">
        <h2>Review</h2>
        <p className="panel-sub">Approvals and change requests stay in the history.</p>
        <div className="form-grid" style={{ marginBottom: 14 }}>
          <div className="form-grid two" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            {canReview ? (
              <>
                <button className="primary" onClick={() => decide("approved")} disabled={busy}>Approve</button>
                <button className="ghost" onClick={() => decide("changes_requested")} disabled={busy}>Request changes</button>
              </>
            ) : task.status !== "in_review" ? (
              <p className="panel-sub" style={{ margin: 0 }}>Move the status to <b>in review</b> above to send this task to a reviewer.</p>
            ) : (
              <p className="panel-sub" style={{ margin: 0 }}>Waiting on a reviewer decision.</p>
            )}
          </div>
          {canReview && (
            <label>
              Review note (optional)
              <input value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} maxLength={2000} placeholder="What should the team know about this decision?" />
            </label>
          )}
        </div>
        {reviews.length === 0 ? (
          <div className="screen-empty"><strong>No decisions yet</strong><p>Approvals and change requests will be listed here.</p></div>
        ) : (
          <div className="data-list">
            {reviews.map((review) => (
              <article className="data-row" key={review.id}>
                <div className="row-main">
                  <strong>{review.profiles?.full_name ?? "Unnamed reviewer"} <span className={`badge ${review.state === "approved" ? "" : review.state === "changes_requested" ? "warn" : "muted"}`}>{titleCase(review.state)}</span></strong>
                  {review.body && <p>{review.body}</p>}
                  <p>{new Date(review.created_at).toLocaleString()}</p>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Attachments</h2>
        <p className="panel-sub">Files your team submitted for this task.</p>
        {attachedFiles.length === 0 ? (
          <div className="screen-empty"><strong>Nothing linked yet</strong><p>Attach a submitted file below, or upload one from the Files library.</p></div>
        ) : (
          <div className="data-list" style={{ marginBottom: 14 }}>
            {attachedFiles.map((file) => (
              <article className="data-row" key={file.id}>
                <div className="row-main">
                  <strong>{file.file_name}</strong>
                  <p>{titleCase(file.category)} · {formatBytes(file.file_size)}</p>
                </div>
                <div className="row-meta"><span className={`badge ${file.submission_status === "approved" ? "" : file.submission_status === "changes_requested" ? "warn" : "violet"}`}>{titleCase(file.submission_status)}</span></div>
                <div className="row-actions">
                  {(file.uploaded_by === userId || canReview) && (
                    <button className="muted" onClick={() => linkFile(file, false)} disabled={busy}>Unlink</button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
        {attachableFiles.length > 0 && (
          <div className="form-grid inline-form-row two">
            <label>
              Attach a submitted file
              <select value={attachFileId} onChange={(event) => setAttachFileId(event.target.value)}>
                <option value="">Choose a file</option>
                {attachableFiles.map((file) => (
                  <option key={file.id} value={file.id}>{file.file_name} · {titleCase(file.submission_status)}</option>
                ))}
              </select>
            </label>
            <button className="primary" disabled={busy || !attachFileId} onClick={() => {
              const chosen = files.find((file) => file.id === attachFileId);
              if (!chosen) return;
              void linkFile(chosen, true);
              setAttachFileId("");
            }}>Attach</button>
          </div>
        )}
        {files.length === 0 && (
          <div className="form-actions">
            <button className="ghost" onClick={() => router.push("/files")}>Upload a file</button>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Activity</h2>
        <p className="panel-sub">Recent changes to this task.</p>
        {events.length === 0 ? (
          <div className="screen-empty"><strong>No activity yet</strong><p>Status changes and edits are logged here automatically.</p></div>
        ) : (
          <div className="data-list">
            {events.map((event) => (
              <article className="data-row" key={event.id}>
                <div className="row-main">
                  <strong>{event.profiles?.full_name ?? "Someone"} · {eventLabel(event.event_type)}</strong>
                  {event.from_value && <p>{`${titleCase(event.from_value)} → ${titleCase(event.to_value ?? "")}`}</p>}
                </div>
                <div className="row-meta">{new Date(event.created_at).toLocaleString()}</div>
              </article>
            ))}
          </div>
        )}
      </section>
    </WorkspaceShell>
  );
}
