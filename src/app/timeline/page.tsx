"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { WorkspaceShell } from "@/components/WorkspaceShell";
import { useWorkspace } from "@/lib/useWorkspace";

type TimelineItem = {
  kind: "task" | "meeting" | "announcement";
  id: string;
  title: string;
  detail: string;
  at: string;
  status?: string;
  link: string;
};

type Member = { user_id: string; role: string; profiles: { full_name: string } | null };

const ranges: Record<string, number> = { "7D": 7, "30D": 30, "90D": 90 };

export default function TimelinePage() {
  const { ready, teamId, error } = useWorkspace();
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [range, setRange] = useState("30D");
  const [message, setMessage] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [showMeetingForm, setShowMeetingForm] = useState(false);
  const [showAnnouncementForm, setShowAnnouncementForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rsvpState, setRsvpState] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    const days = ranges[range] ?? 30;
    const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    async function load() {
      const [timelineResponse, memberResponse] = await Promise.all([
        fetch(`/api/timeline?teamId=${teamId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
        fetch(`/api/members?teamId=${teamId}`),
      ]);
      if (cancelled) return;
      if (timelineResponse.ok) {
        const result = await timelineResponse.json();
        setItems(result.items ?? []);
      } else {
        const result = await timelineResponse.json().catch(() => ({}));
        setMessage(result.error ?? "Unable to load the timeline.");
      }
      if (memberResponse.ok) {
        const result = await memberResponse.json();
        setMembers(result.members ?? []);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [teamId, range]);

  const grouped = useMemo(() => {
    const days = new Map<string, TimelineItem[]>();
    for (const item of items) {
      const key = new Date(item.at).toLocaleDateString([], { weekday: "short", month: "long", day: "numeric" });
      const bucket = days.get(key) ?? [];
      bucket.push(item);
      days.set(key, bucket);
    }
    return Array.from(days.entries());
  }, [items]);

  async function rsvp(meetingId: string, value: string) {
    const response = await fetch(`/api/meetings/${meetingId}/attendees`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rsvp: value }),
    });
    if (response.ok) {
      setRsvpState((current) => ({ ...current, [meetingId]: value }));
      setMessage(`RSVP saved: ${value}`);
    } else {
      const result = await response.json().catch(() => ({}));
      setMessage(result.error ?? "Unable to save your RSVP.");
    }
  }

  async function postAnnouncement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!teamId) return;
    setBusy(true);
    setMessage("");
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const response = await fetch("/api/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamId,
          title: String(data.get("title") ?? ""),
          body: String(data.get("body") ?? ""),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Unable to post the announcement.");
      setMessage("Announcement broadcast to your team.");
      form.reset();
      setShowAnnouncementForm(false);
      const timelineResponse = await fetch(`/api/timeline?teamId=${teamId}&from=${encodeURIComponent(new Date(Date.now() - 7 * 86400000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + (ranges[range] ?? 30) * 86400000).toISOString())}`);
      if (timelineResponse.ok) setItems((await timelineResponse.json()).items ?? []);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to post the announcement.");
    } finally {
      setBusy(false);
    }
  }

  async function scheduleMeeting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!teamId) return;
    setBusy(true);
    setMessage("");
    const form = event.currentTarget;
    const data = new FormData(form);
    const attendeeIds = data.getAll("attendees").map(String);
    try {
      const response = await fetch("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamId,
          title: String(data.get("title") ?? ""),
          agenda: String(data.get("agenda") ?? ""),
          startsAt: new Date(String(data.get("startsAt"))).toISOString(),
          endsAt: new Date(String(data.get("endsAt"))).toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          meetingUrl: String(data.get("meetingUrl") ?? ""),
          attendeeIds,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Unable to schedule the meeting.");
      setMessage("Meeting scheduled. Attendees were notified.");
      form.reset();
      setShowMeetingForm(false);
      const timelineResponse = await fetch(`/api/timeline?teamId=${teamId}&from=${encodeURIComponent(new Date(Date.now() - 7 * 86400000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + (ranges[range] ?? 30) * 86400000).toISOString())}`);
      if (timelineResponse.ok) setItems((await timelineResponse.json()).items ?? []);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to schedule the meeting.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <WorkspaceShell active="Timeline">
      <div className="screen-heading">
        <div>
          <p className="overline">TIMELINE / CALENDAR</p>
          <h1>Timeline</h1>
          <p>Deadlines, meetings and announcements from your project database.</p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            className="ghost"
            onClick={() => {
              setShowAnnouncementForm((c) => !c);
              setShowMeetingForm(false);
              setMessage("");
            }}
          >
            📢 Post announcement
          </button>
          <button
            className="new-project"
            onClick={() => {
              setShowMeetingForm((c) => !c);
              setShowAnnouncementForm(false);
              setMessage("");
            }}
          >
            + Schedule meeting
          </button>
        </div>
      </div>

      {message && <p className={`screen-message${message.startsWith("Unable") ? " error" : ""}`} role="status">{message}</p>}
      {error && <p className="screen-message error" role="status">{error}</p>}

      <div className="screen-toolbar">
        <span className="badge muted">{items.length} events</span>
        {Object.keys(ranges).map((key) => (
          <button key={key} onClick={() => setRange(key)} style={range === key ? { borderColor: "#9c69f5", color: "#c19bff" } : undefined}>
            Next {key}
          </button>
        ))}
        <span className="grow" />
        <span className="badge violet">past week + next {range.replace("D", "")} days</span>
      </div>

      {showAnnouncementForm && (
        <section className="panel" style={{ marginBottom: 20 }}>
          <h2>Broadcast announcement</h2>
          <p className="panel-sub">TEAM MEMBERS RECEIVE AN INSTANT NOTIFICATION</p>
          <form className="form-grid" onSubmit={postAnnouncement}>
            <label>Headline<input name="title" required maxLength={200} placeholder="e.g. Midterm report submission deadline updated" /></label>
            <label>Details<textarea name="body" rows={4} required maxLength={10000} placeholder="Describe the announcement, expectations, and any next steps..." /></label>
            <div className="form-actions">
              <button type="button" className="ghost" onClick={() => setShowAnnouncementForm(false)}>Cancel</button>
              <button className="primary" disabled={busy}>{busy ? "Broadcasting..." : "Broadcast announcement"}</button>
            </div>
          </form>
        </section>
      )}

      {showMeetingForm && (
        <section className="panel" style={{ marginBottom: 20 }}>
          <h2>Schedule a meeting</h2>
          <p className="panel-sub">TIMES ARE STORED WITH YOUR LOCAL TIMEZONE</p>
          <form className="form-grid" onSubmit={scheduleMeeting}>
            <label>Title<input name="title" required maxLength={200} placeholder="e.g. Supervisor check-in" /></label>
            <label>Agenda<textarea name="agenda" rows={3} placeholder="What should the team prepare?" /></label>
            <div className="form-grid two">
              <label>Starts<input name="startsAt" type="datetime-local" required /></label>
              <label>Ends<input name="endsAt" type="datetime-local" required /></label>
            </div>
            <div className="form-grid two">
              <label>Meeting link (optional)<input name="meetingUrl" type="url" placeholder="https://meet.example.com/room" /></label>
              <label>
                Attendees
                <select name="attendees" multiple size={Math.min(5, Math.max(2, members.length))} style={{ padding: 8 }}>
                  {members.map((member) => (
                    <option key={member.user_id} value={member.user_id}>{member.profiles?.full_name ?? "Member"} · {member.role}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="form-actions">
              <button type="button" className="ghost" onClick={() => setShowMeetingForm(false)}>Cancel</button>
              <button className="primary" disabled={busy}>{busy ? "Scheduling..." : "Schedule meeting"}</button>
            </div>
          </form>
        </section>
      )}

      {!ready ? (
        <div className="screen-empty"><strong>Loading timeline...</strong></div>
      ) : grouped.length === 0 ? (
        <div className="screen-empty">
          <strong>Nothing scheduled</strong>
          <p>Task due dates, meetings and announcements will appear here as your project moves.</p>
        </div>
      ) : (
        grouped.map(([day, dayItems]) => (
          <section className="timeline-day" key={day}>
            <h3>{day}</h3>
            {dayItems.map((item) => (
              <article className={`timeline-item ${item.kind}`} key={`${item.kind}-${item.id}`}>
                <div>
                  <span className={`badge ${item.kind === "meeting" ? "" : item.kind === "announcement" ? "warn" : "violet"}`}>{item.kind}</span>
                  {item.kind === "announcement" ? (
                    <strong>{item.title}</strong>
                  ) : (
                    <Link className="item-link" href={item.link}>
                      <strong>{item.title}</strong>
                    </Link>
                  )}
                  <p>{item.detail}</p>
                  <time>{new Date(item.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
                </div>
                {item.kind === "meeting" && item.status === "scheduled" && (
                  <div className="row-actions" style={{ marginLeft: "auto", alignSelf: "center" }}>
                    <button onClick={() => rsvp(item.id, "accepted")} style={rsvpState[item.id] === "accepted" ? { background: "#31d9ed20", color: "#52dbe7" } : undefined}>Accept</button>
                    <button className="muted" onClick={() => rsvp(item.id, "tentative")}>Maybe</button>
                    <button className="muted" onClick={() => rsvp(item.id, "declined")}>Decline</button>
                  </div>
                )}
              </article>
            ))}
          </section>
        ))
      )}
    </WorkspaceShell>
  );
}
