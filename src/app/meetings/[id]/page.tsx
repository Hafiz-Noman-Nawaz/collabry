"use client";

import { FormEvent, Suspense, useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { WorkspaceShell } from "@/components/WorkspaceShell";
import { createClient } from "@/lib/supabase/browser";
import { titleCase, toDateTimeInput } from "@/lib/format";

type ProfileLite = { id: string; full_name: string; university: string | null } | null;
type Attendee = { user_id: string; rsvp: string; attended: boolean | null; profiles: ProfileLite };
type ActionItem = { id: string; title: string; done: boolean; assignee_id: string | null; task_id: string | null; created_at: string; profiles: ProfileLite };
type Minutes = { body: string; decisions: string; updated_at: string; author_id: string };
type TaskLite = { id: string; title: string };
type Member = { user_id: string; role: string; profiles: ProfileLite };
type Meeting = {
  id: string;
  team_id: string;
  title: string;
  agenda: string | null;
  starts_at: string;
  ends_at: string | null;
  timezone: string;
  status: string;
  meeting_url: string | null;
  created_by: string;
  profiles?: ProfileLite;
  meeting_attendees: Attendee[];
  meeting_minutes: Minutes | null;
  meeting_action_items: ActionItem[];
};

const MEETING_STATUSES = ["scheduled", "cancelled", "completed"];
const MANAGER_ROLES = ["owner", "supervisor", "leader"];

function formatWhen(startsAt: string, endsAt: string | null) {
  const start = new Date(startsAt).toLocaleString([], { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  if (!endsAt) return start;
  return `${start} – ${new Date(endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function attendanceLabel(attended: boolean | null) {
  if (attended === true) return "Marked present";
  if (attended === false) return "Marked absent";
  return "Attendance not recorded";
}

export default function MeetingPage() {
  // URL-data hooks (useParams, and usePathname inside the shell) suspend until the route is known,
  // so the boundary streams them and its fallback reads no URL data.
  return (
    <Suspense
      fallback={
        <div className="screen-empty">
          <strong>Loading meeting...</strong>
          <p>Reading its agenda, attendees, action items and minutes.</p>
        </div>
      }
    >
      <MeetingScreen />
    </Suspense>
  );
}

function MeetingScreen() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const meetingId = params?.id ?? "";

  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [tasks, setTasks] = useState<TaskLite[]>([]);
  const [userId, setUserId] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const [title, setTitle] = useState("");
  const [agenda, setAgenda] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [timezone, setTimezone] = useState("");
  const [meetingUrl, setMeetingUrl] = useState("");
  const [status, setStatus] = useState("scheduled");
  const [attendeeIds, setAttendeeIds] = useState<string[]>([]);

  const [minutesBody, setMinutesBody] = useState("");
  const [minutesDecisions, setMinutesDecisions] = useState("");
  const [itemTitle, setItemTitle] = useState("");
  const [itemAssignee, setItemAssignee] = useState("");
  const [itemTask, setItemTask] = useState("");

  const load = useCallback(async () => {
    const response = await fetch(`/api/meetings/${meetingId}`);
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      setMessage(result.error ?? "Meeting not found.");
      return;
    }
    const loaded: Meeting = (await response.json()).meeting;
    setMeeting(loaded);
    setTitle(loaded.title);
    setAgenda(loaded.agenda ?? "");
    setStartsAt(toDateTimeInput(loaded.starts_at));
    setEndsAt(toDateTimeInput(loaded.ends_at));
    setTimezone(loaded.timezone);
    setMeetingUrl(loaded.meeting_url ?? "");
    setStatus(loaded.status);
    setAttendeeIds((loaded.meeting_attendees ?? []).map((row) => row.user_id));
    setMinutesBody(loaded.meeting_minutes?.body ?? "");
    setMinutesDecisions(loaded.meeting_minutes?.decisions ?? "");

    const [memberResponse, taskResponse] = await Promise.all([
      fetch(`/api/members?teamId=${loaded.team_id}`),
      fetch(`/api/tasks?teamId=${loaded.team_id}&limit=100`),
    ]);
    if (memberResponse.ok) setMembers((await memberResponse.json()).members ?? []);
    if (taskResponse.ok) setTasks(((await taskResponse.json()).tasks ?? []) as TaskLite[]);
  }, [meetingId]);

  useEffect(() => {
    if (!meetingId) return;
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
  }, [meetingId, load, router]);

  const myRole = members.find((member) => member.user_id === userId)?.role ?? null;
  const canManage = MANAGER_ROLES.includes(myRole ?? "");
  const myAttendee = meeting?.meeting_attendees.find((row) => row.user_id === userId) ?? null;
  const openItems = (meeting?.meeting_action_items ?? []).filter((item) => !item.done).length;

  async function request(path: string, init?: RequestInit) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
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

  async function saveDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await request(`/api/meetings/${meetingId}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: title.trim(),
        agenda: agenda.trim(),
        startsAt: startsAt ? new Date(startsAt).toISOString() : undefined,
        endsAt: endsAt ? new Date(endsAt).toISOString() : undefined,
        timezone: timezone.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone,
        meetingUrl: meetingUrl.trim(),
        status,
        attendeeIds,
      }),
    });
    if (result) {
      setMessage("Meeting saved.");
      await load();
    }
  }

  async function saveMinutes(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await request(`/api/meetings/${meetingId}/minutes`, {
      method: "PUT",
      body: JSON.stringify({ body: minutesBody.trim(), decisions: minutesDecisions.trim() }),
    });
    if (result) {
      setMessage("Minutes saved.");
      await load();
    }
  }

  async function addItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!itemTitle.trim()) return;
    const result = await request(`/api/meetings/${meetingId}/action-items`, {
      method: "POST",
      body: JSON.stringify({
        title: itemTitle.trim(),
        assigneeId: itemAssignee || null,
        taskId: itemTask || null,
      }),
    });
    if (result) {
      setItemTitle("");
      setItemAssignee("");
      setItemTask("");
      await load();
    }
  }

  async function toggleItem(item: ActionItem) {
    const result = await request(`/api/meetings/${meetingId}/action-items`, {
      method: "PATCH",
      body: JSON.stringify({ id: item.id, done: !item.done }),
    });
    if (result) {
      setMeeting((current) =>
        current
          ? { ...current, meeting_action_items: current.meeting_action_items.map((row) => (row.id === item.id ? { ...row, done: result.item.done } : row)) }
          : current,
      );
    }
  }

  async function removeItem(id: string) {
    const result = await request(`/api/meetings/${meetingId}/action-items?id=${id}`, { method: "DELETE" });
    if (result) await load();
  }

  async function rsvp(value: string) {
    const result = await request(`/api/meetings/${meetingId}/attendees`, {
      method: "POST",
      body: JSON.stringify({ rsvp: value }),
    });
    if (result) {
      setMessage(`RSVP saved: ${value}`);
      await load();
    }
  }

  async function recordAttendance(userIdRow: string, attended: boolean) {
    const result = await request(`/api/meetings/${meetingId}/attendees`, {
      method: "PATCH",
      body: JSON.stringify({ records: [{ userId: userIdRow, attended }] }),
    });
    if (result) await load();
  }

  async function deleteMeeting() {
    if (!meeting) return;
    if (!window.confirm(`Delete "${meeting.title}"? Its minutes and action items are removed too.`)) return;
    const result = await request(`/api/meetings/${meetingId}`, { method: "DELETE" });
    if (result) router.push("/timeline");
  }

  if (!meeting) {
    return (
      <WorkspaceShell active="">
        <div className="screen-empty">
          <strong>{message || "Loading meeting..."}</strong>
          <p>{message ? "Check the link or return to the timeline." : "Reading its agenda, attendees, action items and minutes."}</p>
          <button className="ghost" onClick={() => router.push("/timeline")}>Back to timeline</button>
        </div>
      </WorkspaceShell>
    );
  }

  return (
    <WorkspaceShell active="" dense>
      <div className="screen-heading">
        <div>
          <p className="overline">MEETING</p>
          <h1>{meeting.title}</h1>
          <p>{formatWhen(meeting.starts_at, meeting.ends_at)} · {meeting.timezone}</p>
        </div>
        <div className="row-actions">
          <span className={`badge ${meeting.status === "scheduled" ? "violet" : meeting.status === "completed" ? "" : "warn"}`}>{titleCase(meeting.status)}</span>
          <button className="muted" onClick={() => router.push("/timeline")}>← Timeline</button>
        </div>
      </div>

      {message && <p className="screen-message" role="status">{message}</p>}

      {meeting.meeting_url && (
        <p className="screen-message">
          Join link:{" "}
          <a href={meeting.meeting_url} target="_blank" rel="noreferrer" style={{ color: "#7ce5ea" }}>
            {meeting.meeting_url}
          </a>
        </p>
      )}

      <section className="panel">
        <h2>Your RSVP</h2>
        <p className="panel-sub">{canManage ? "YOU CAN ALSO RESCHEDULE BELOW" : "ONLY MANAGERS CAN CHANGE THE SCHEDULE"}</p>
        <div className="row-actions">
          <button onClick={() => rsvp("accepted")} disabled={busy || myAttendee?.rsvp === "accepted"}>Accept</button>
          <button className="muted" onClick={() => rsvp("tentative")} disabled={busy || myAttendee?.rsvp === "tentative"}>Maybe</button>
          <button className="muted" onClick={() => rsvp("declined")} disabled={busy || myAttendee?.rsvp === "declined"}>Decline</button>
        </div>
        <p className="panel-sub" style={{ marginTop: 10 }}>
          {myAttendee ? `Current response: ${titleCase(myAttendee.rsvp)}` : "You are not on the invite list yet."}
        </p>
      </section>

      <section className="panel">
        <h2>Details</h2>
        <p className="panel-sub">{canManage ? "SAVE TO RESCHEDULE AND NOTIFY ATTENDEES" : "READ ONLY"}</p>
        {canManage ? (
          <form className="form-grid" onSubmit={saveDetails}>
            <label>
              Title
              <input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} />
            </label>
            <div className="form-grid two">
              <label>
                Starts
                <input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} required />
              </label>
              <label>
                Ends
                <input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} />
              </label>
              <label>
                Time zone
                <input value={timezone} onChange={(event) => setTimezone(event.target.value)} maxLength={80} />
              </label>
              <label>
                Status
                <select value={status} onChange={(event) => setStatus(event.target.value)}>
                  {MEETING_STATUSES.map((item) => <option key={item} value={item}>{titleCase(item)}</option>)}
                </select>
              </label>
              <label>
                Meeting link
                <input type="url" value={meetingUrl} onChange={(event) => setMeetingUrl(event.target.value)} placeholder="https://meet.example.com/room" />
              </label>
            </div>
            <label>
              Agenda
              <textarea value={agenda} onChange={(event) => setAgenda(event.target.value)} rows={4} maxLength={4000} placeholder="What will you cover?" />
            </label>
            <label>
              Attendees
              <div className="data-list" style={{ maxHeight: 170, overflowY: "auto" }}>
                {members.map((member) => (
                  <span className="data-row" key={member.user_id}>
                    <input
                      type="checkbox"
                      style={{ width: "auto" }}
                      checked={attendeeIds.includes(member.user_id)}
                      onChange={(event) =>
                        setAttendeeIds((current) =>
                          event.target.checked ? [...current, member.user_id] : current.filter((id) => id !== member.user_id),
                        )
                      }
                    />
                    <div className="row-main">
                      <strong>{member.profiles?.full_name ?? "Unnamed member"}</strong>
                      <p>{titleCase(member.role)}</p>
                    </div>
                  </span>
                ))}
              </div>
            </label>
            <div className="form-actions">
              <button className="primary" disabled={busy}>{busy ? "Saving..." : "Save changes"}</button>
              <button className="ghost" disabled={busy} onClick={deleteMeeting}>Delete meeting</button>
            </div>
          </form>
        ) : (
          <>
            {meeting.agenda ? <p className="screen-message" style={{ whiteSpace: "pre-wrap" }}>{meeting.agenda}</p> : <div className="screen-empty"><strong>No agenda recorded</strong></div>}
            <div className="data-list" style={{ marginTop: 12 }}>
              {meeting.meeting_attendees.map((attendee) => (
                <article className="data-row" key={attendee.user_id}>
                  <div className="row-main">
                    <strong>{attendee.profiles?.full_name ?? "Unnamed member"}</strong>
                    <p>RSVP {titleCase(attendee.rsvp)}</p>
                  </div>
                  <div className="row-meta">{attendee.user_id === userId ? <button className="muted" onClick={() => rsvp("accepted")} disabled={busy}>Accept now</button> : null}</div>
                </article>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <h2>Action items</h2>
        <p className="panel-sub">
          {meeting.meeting_action_items.length === 0
            ? "NOT RECORDED YET"
            : openItems === 0
              ? `ALL ${meeting.meeting_action_items.length} CLOSED`
              : `${openItems} STILL OPEN`}
        </p>
        {canManage && (
          <form className="form-grid" onSubmit={addItem} style={{ marginBottom: 14 }}>
            <div className="form-grid two" style={{ gridTemplateColumns: "2fr 1fr 1fr auto", alignItems: "end" }}>
              <label>
                New action item
                <input value={itemTitle} onChange={(event) => setItemTitle(event.target.value)} maxLength={200} placeholder="e.g. Share the survey instrument" />
              </label>
              <label>
                Owner
                <select value={itemAssignee} onChange={(event) => setItemAssignee(event.target.value)}>
                  <option value="">Unassigned</option>
                  {members.map((member) => (
                    <option key={member.user_id} value={member.user_id}>{member.profiles?.full_name ?? "Unnamed member"}</option>
                  ))}
                </select>
              </label>
              <label>
                Related task
                <select value={itemTask} onChange={(event) => setItemTask(event.target.value)}>
                  <option value="">None</option>
                  {tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
                </select>
              </label>
              <button className="primary" disabled={busy || !itemTitle.trim()}>Add</button>
            </div>
          </form>
        )}
        {meeting.meeting_action_items.length === 0 ? (
          <div className="screen-empty"><strong>No action items yet</strong><p>{canManage ? "Capture who owes what after the discussion." : "Managers record these during or after the meeting."}</p></div>
        ) : (
          <div className="data-list">
            {meeting.meeting_action_items.map((item) => (
              <article className="data-row" key={item.id}>
                <input
                  type="checkbox"
                  style={{ width: "auto" }}
                  checked={item.done}
                  disabled={busy || (!canManage && item.assignee_id !== userId)}
                  onChange={() => toggleItem(item)}
                  aria-label={`Mark ${item.title} ${item.done ? "open" : "done"}`}
                />
                <div className="row-main">
                  <strong style={item.done ? { textDecoration: "line-through", color: "#8b8bab" } : undefined}>{item.title}</strong>
                  <p>{item.profiles?.full_name ?? "Unassigned"}{item.task_id ? ` · linked to ${tasks.find((task) => task.id === item.task_id)?.title ?? "a task"}` : ""}</p>
                </div>
                <div className="row-actions">
                  {canManage && <button className="muted" onClick={() => removeItem(item.id)} disabled={busy}>Remove</button>}
                  {item.task_id && (
                    <button className="muted" onClick={() => router.push(`/tasks/${item.task_id}`)}>Open task</button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Minutes</h2>
        <p className="panel-sub">
          {meeting.meeting_minutes
            ? `LAST SAVED ${new Date(meeting.meeting_minutes.updated_at).toLocaleString()} BY ${meeting.profiles?.full_name ?? "A MANAGER"}`
            : "NOT RECORDED YET"}
        </p>
        {canManage ? (
          <form className="form-grid" onSubmit={saveMinutes}>
            <label>
              Discussion notes
              <textarea value={minutesBody} onChange={(event) => setMinutesBody(event.target.value)} rows={6} maxLength={20000} placeholder="What was discussed?" />
            </label>
            <label>
              Decisions
              <textarea value={minutesDecisions} onChange={(event) => setMinutesDecisions(event.target.value)} rows={4} maxLength={20000} placeholder="What did the team agree?" />
            </label>
            <div className="form-actions">
              <button className="primary" disabled={busy}>{busy ? "Saving..." : "Save minutes"}</button>
            </div>
          </form>
        ) : meeting.meeting_minutes ? (
          <>
            <p className="screen-message" style={{ whiteSpace: "pre-wrap" }}>{meeting.meeting_minutes.body}</p>
            {meeting.meeting_minutes.decisions && <p className="screen-message" style={{ whiteSpace: "pre-wrap" }}><b>Decisions:</b> {meeting.meeting_minutes.decisions}</p>}
          </>
        ) : (
          <div className="screen-empty"><strong>No minutes yet</strong><p>A manager will record them after the meeting.</p></div>
        )}
      </section>

      {canManage && meeting.meeting_attendees.length > 0 && (
        <section className="panel">
          <h2>Attendance</h2>
          <p className="panel-sub">RECORDED AFTER THE MEETING</p>
          <div className="data-list">
            {meeting.meeting_attendees.map((attendee) => (
              <article className="data-row" key={attendee.user_id}>
                <div className="row-main">
                  <strong>{attendee.profiles?.full_name ?? "Unnamed member"}</strong>
                  <p>RSVP {titleCase(attendee.rsvp)} · {attendanceLabel(attendee.attended)}</p>
                </div>
                <div className="row-actions">
                  <button className={attendee.attended === true ? "" : "muted"} disabled={busy} onClick={() => recordAttendance(attendee.user_id, true)}>Present</button>
                  <button className={attendee.attended === false ? "" : "muted"} disabled={busy} onClick={() => recordAttendance(attendee.user_id, false)}>Absent</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </WorkspaceShell>
  );
}
