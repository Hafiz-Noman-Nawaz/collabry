"use client";

import { FormEvent, useEffect, useState } from "react";
import { WorkspaceShell } from "@/components/WorkspaceShell";

type Profile = { id: string; full_name: string; university: string | null; department: string | null };
type Preferences = {
  emailInvitations: boolean;
  emailMeetings: boolean;
  emailTasks: boolean;
  emailDeadlines: boolean;
  emailAnnouncements: boolean;
};

const toggleRows: Array<{ key: keyof Preferences; title: string; copy: string }> = [
  { key: "emailInvitations", title: "Invitation emails", copy: "Team invitations and acceptance notices." },
  { key: "emailMeetings", title: "Meeting emails", copy: "Schedules, changes and reminders." },
  { key: "emailTasks", title: "Task emails", copy: "Assignments and status changes." },
  { key: "emailDeadlines", title: "Deadline emails", copy: "Upcoming due dates across projects." },
  { key: "emailAnnouncements", title: "Announcement emails", copy: "Posts made by team managers." },
];

export default function SettingsPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState<string>("unsupported");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [profileResponse, prefsResponse] = await Promise.all([fetch("/api/profile"), fetch("/api/notifications/preferences")]);
      if (cancelled) return;
      if (profileResponse.ok) setProfile((await profileResponse.json()).profile);
      else {
        const result = await profileResponse.json().catch(() => ({}));
        setError(result.error ?? "Unable to load your profile.");
      }
      if (prefsResponse.ok) setPrefs((await prefsResponse.json()).preferences);
      if (typeof window !== "undefined" && "Notification" in window) setPermission(Notification.permission);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: String(form.get("fullName") ?? ""),
        university: String(form.get("university") ?? "") || null,
        department: String(form.get("department") ?? "") || null,
      }),
    });
    const result = await response.json();
    if (!response.ok) setError(result.error ?? "Unable to save your profile.");
    else {
      setProfile(result.profile);
      setMessage("Profile saved.");
    }
    setBusy(false);
  }

  async function updatePreference(key: keyof Preferences, value: boolean) {
    if (!prefs) return;
    const previous = prefs;
    setPrefs({ ...prefs, [key]: value });
    const response = await fetch("/api/notifications/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        emailInvitations: key === "emailInvitations" ? value : prefs.emailInvitations,
        emailMeetings: key === "emailMeetings" ? value : prefs.emailMeetings,
        emailTasks: key === "emailTasks" ? value : prefs.emailTasks,
        emailDeadlines: key === "emailDeadlines" ? value : prefs.emailDeadlines,
        emailAnnouncements: key === "emailAnnouncements" ? value : prefs.emailAnnouncements,
      }),
    });
    if (!response.ok) {
      setPrefs(previous);
      setError("Unable to save that preference.");
      return;
    }
    setPrefs((await response.json()).preferences);
    setMessage("Preferences saved.");
  }

  async function enableNotifications() {
    if (!("Notification" in window)) return;
    const result = await Notification.requestPermission();
    setPermission(result);
    if (result === "granted") setMessage("Browser notifications enabled for this device.");
  }

  return (
    <WorkspaceShell active="Settings">
      <div className="screen-heading">
        <div>
          <p className="overline">SETTINGS / ACCOUNT</p>
          <h1>Settings</h1>
          <p>Your profile and how Collabry is allowed to reach you.</p>
        </div>
      </div>

      {message && <p className="screen-message" role="status">{message}</p>}
      {error && <p className="screen-message error" role="status">{error}</p>}

      <section className="panel">
        <h2>Profile</h2>
        <p className="panel-sub">Visible to teammates in member lists.</p>
        {!profile ? (
          <p className="panel-sub">Loading profile...</p>
        ) : (
          <form className="form-grid" onSubmit={saveProfile}>
            <div className="form-grid two">
              <label>Full name<input name="fullName" required maxLength={120} defaultValue={profile.full_name} autoComplete="name" /></label>
              <label>University<input name="university" maxLength={160} defaultValue={profile.university ?? ""} /></label>
            </div>
            <div className="form-grid two">
              <label>Department<input name="department" maxLength={160} defaultValue={profile.department ?? ""} /></label>
            </div>
            <div className="form-actions">
              <button className="primary" disabled={busy}>{busy ? "Saving..." : "Save profile"}</button>
            </div>
          </form>
        )}
      </section>

      <section className="panel">
        <h2>Notification preferences</h2>
        <p className="panel-sub">Choose which updates reach your inbox.</p>
        {!prefs ? (
          <p className="panel-sub">Loading preferences...</p>
        ) : (
          toggleRows.map((row) => (
            <div className="toggle-row" key={row.key}>
              <div>
                <strong>{row.title}</strong>
                <p>{row.copy}</p>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={prefs[row.key] !== false}
                  onChange={(event) => updatePreference(row.key, event.target.checked)}
                  aria-label={row.title}
                />
                <span />
              </label>
            </div>
          ))
        )}
      </section>

      <section className="panel">
        <h2>Browser notifications</h2>
        <p className="panel-sub">
          {permission === "granted" ? "Enabled on this device." : permission === "denied" ? "Blocked by this browser." : "Not enabled on this device."}
        </p>
        <p style={{ color: "#8b8bab", fontSize: 10, lineHeight: 1.6, marginTop: 0 }}>
          Turn this on to receive workspace updates in this browser. You can change it again in your browser&apos;s site settings.
        </p>
        <div className="form-actions">
          <button className="primary" disabled={permission === "granted" || permission === "unsupported"} onClick={enableNotifications}>
            {permission === "granted" ? "Notifications enabled" : "Enable notifications"}
          </button>
        </div>
      </section>
    </WorkspaceShell>
  );
}
