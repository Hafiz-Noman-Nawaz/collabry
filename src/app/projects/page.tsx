"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { WorkspaceShell } from "@/components/WorkspaceShell";
import { DateField } from "@/components/DateTimeField";
import { RoadmapPanel, RoadmapPlanner, type ReviewedPhase } from "@/components/Roadmap";
import { useWorkspace, WorkspaceTeam } from "@/lib/useWorkspace";
import { invitationDeliveryMessage, formatShortDate } from "@/lib/format";

type Invitation = { id: string; invitee_email: string; role: string; status: string; expires_at: string };

function ProjectsScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { ready, teams, setTeamId, error, refresh } = useWorkspace();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(0);
  const [showCreate, setShowCreate] = useState(() => searchParams.get("new") === "1");
  const [settingsFor, setSettingsFor] = useState<WorkspaceTeam | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [inviteFor, setInviteFor] = useState<WorkspaceTeam | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [showRoadmap, setShowRoadmap] = useState(false);
  const [roadmapDraft, setRoadmapDraft] = useState<ReviewedPhase[]>([]);
  const createFormRef = useRef<HTMLFormElement>(null);
  const pageSize = 6;

  const acceptDraft = useCallback((phases: ReviewedPhase[]) => setRoadmapDraft(phases), []);

  const readBrief = useCallback(() => {
    const value = (name: string) => (createFormRef.current?.elements.namedItem(name) as HTMLInputElement | null)?.value ?? "";
    return { projectName: value("name"), description: value("description") };
  }, []);

  const filtered = useMemo(() => {
    return teams.filter((candidate) => {
      const matchesSearch = !search || candidate.name.toLowerCase().includes(search.toLowerCase()) || (candidate.description ?? "").toLowerCase().includes(search.toLowerCase());
      const matchesCategory = !category || candidate.category === category;
      const matchesStatus =
        !status ||
        (status === "active" && (!candidate.target_date || candidate.target_date >= new Date().toISOString().slice(0, 10))) ||
        (status === "overdue" && !!candidate.target_date && candidate.target_date < new Date().toISOString().slice(0, 10));
      return matchesSearch && matchesCategory && matchesStatus;
    });
  }, [teams, search, category, status]);

  useEffect(() => {
    async function loadInvitations() {
      if (!inviteFor) return;
      const response = await fetch(`/api/invitations?teamId=${inviteFor.id}`);
      if (response.ok) {
        const result = await response.json();
        setInvitations(result.invitations ?? []);
      }
    }
    loadInvitations();
  }, [inviteFor]);

  const pageItems = filtered.slice(page * pageSize, page * pageSize + pageSize);
  const categories = Array.from(new Set(teams.map((candidate) => candidate.category).filter(Boolean))) as string[];

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    try {
      const supabase = (await import("@/lib/supabase/browser")).createClient();
      const { data, error: rpcError } = await supabase.rpc("create_team", {
        team_name: String(form.get("name") ?? ""),
        team_description: String(form.get("description") ?? ""),
        team_category: String(form.get("category") ?? "") || null,
        team_target_date: String(form.get("targetDate") ?? "") || null,
      });
      if (rpcError) throw rpcError;
      const created = data as { id?: string } | null;
      if (created?.id) {
        let saved = "Project created. Your owner membership is active.";
        if (showRoadmap && roadmapDraft.length > 0) {
          const roadmap = await fetch("/api/roadmap", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              teamId: created.id,
              phases: roadmapDraft.map((phase) => ({
                title: phase.title,
                summary: phase.summary,
                source: phase.source,
                tasks: phase.tasks.map((title) => ({ title })),
              })),
            }),
          });
          const result = await roadmap.json().catch(() => ({}));
          saved = roadmap.ok
            ? `Project created with its ${roadmapDraft.length}-phase roadmap and ${roadmapDraft.reduce((sum, phase) => sum + phase.tasks.length, 0)} tasks.`
            : `Project created, but the roadmap was not saved: ${result.error ?? "try adding it in project settings."}`;
        }
        setMessage(saved);
        setShowCreate(false);
        setShowRoadmap(false);
        setRoadmapDraft([]);
        await refresh();
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to create the project.");
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settingsFor) return;
    setBusy(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/teams", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        teamId: settingsFor.id,
        name: String(form.get("name") ?? ""),
        description: String(form.get("description") ?? ""),
        category: String(form.get("category") ?? "") || null,
        university: String(form.get("university") ?? "") || null,
        department: String(form.get("department") ?? "") || null,
        startDate: String(form.get("startDate") ?? "") || null,
        targetDate: String(form.get("targetDate") ?? "") || null,
      }),
    });
    const result = await response.json();
    if (!response.ok) setMessage(result.error ?? "Unable to save settings.");
    else {
      setMessage("Project settings saved.");
      setSettingsFor(null);
      await refresh();
    }
    setBusy(false);
  }

  async function deleteProject() {
    if (!settingsFor) return;
    setBusy(true);
    setMessage("");
    const projectName = settingsFor.name;
    const response = await fetch(`/api/teams/${settingsFor.id}`, { method: "DELETE" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      setMessage(result.error ?? "Unable to delete the project.");
      setBusy(false);
      return;
    }
    setDeleteOpen(false);
    setSettingsFor(null);
    setPage(0);
    setMessage(`${projectName} was deleted.`);
    await refresh();
    setBusy(false);
  }

  async function sendInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!inviteFor) return;
    setBusy(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const response = await fetch("/api/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        teamId: inviteFor.id,
        email,
        role: String(form.get("role") ?? "member"),
      }),
    });
    const result = await response.json();
    if (!response.ok) setMessage(result.error ?? "Unable to create the invitation.");
    else {
      setMessage(invitationDeliveryMessage(email, result));
      const list = await fetch(`/api/invitations?teamId=${inviteFor.id}`);
      if (list.ok) setInvitations((await list.json()).invitations ?? []);
      (event.target as HTMLFormElement).reset();
    }
    setBusy(false);
  }

  return (
    <WorkspaceShell active="Projects">
      <div className="screen-heading">
        <div>
          <p className="overline">PROJECTS</p>
          <h1>Projects</h1>
          <p>Every project you belong to, with search, filtering and owner settings.</p>
        </div>
        <button className="new-project" onClick={() => { setShowCreate(true); setMessage(""); }}>+ New project</button>
      </div>

      {message && <p className={`screen-message${message.startsWith("Unable") || message.startsWith("Invalid") ? " error" : ""}`} role="status">{message}</p>}
      {error && <p className="screen-message error" role="status">{error}</p>}

      <div className="screen-toolbar">
        <input className="grow" placeholder="Search projects..." value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} aria-label="Search projects" />
        <select value={category} onChange={(event) => { setCategory(event.target.value); setPage(0); }} aria-label="Filter by category">
          <option value="">All categories</option>
          {categories.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <select value={status} onChange={(event) => { setStatus(event.target.value); setPage(0); }} aria-label="Filter by status">
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="overdue">Past target date</option>
        </select>
        <button onClick={() => { setSearch(""); setCategory(""); setStatus(""); setPage(0); }}>Reset</button>
      </div>

      {!ready ? (
        <div className="screen-empty"><strong>Loading projects...</strong></div>
      ) : pageItems.length === 0 ? (
        <div className="screen-empty">
          <strong>No projects found</strong>
          <p>{teams.length === 0 ? "Create your first project to start inviting collaborators and tracking work." : "No project matches those filters. Adjust the search or category."}</p>
        </div>
      ) : (
        <section className="data-list">
          {pageItems.map((item) => (
            <article className="data-row" key={item.id}>
              <span className="team-mark">{item.name.slice(0, 1).toUpperCase()}</span>
              <div className="row-main">
                <strong>{item.name}</strong>
                <p>{item.description || "No project description yet."}</p>
              </div>
              <span className={`badge ${item.role === "owner" ? "violet" : "muted"}`}>{item.role ?? "member"}</span>
              <span className="badge muted">{item.category || "uncategorised"}</span>
              <div className="row-meta">
                {item.memberCount} member{item.memberCount === 1 ? "" : "s"}
                <br />
                {item.target_date ? `Target ${formatShortDate(item.target_date)}` : "No target date"}
              </div>
              <div className="row-actions">
                <button onClick={() => { setTeamId(item.id); router.push(`/timeline?teamId=${item.id}`); }}>Timeline</button>
                {item.role === "owner" ? (
                  <>
                    <button className="muted" onClick={() => { setSettingsFor(item); setMessage(""); }}>Settings</button>
                    <button onClick={() => { setInviteFor(item); setMessage(""); }}>Invite</button>
                  </>
                ) : (
                  <button className="muted" onClick={() => setInviteFor(item)}>Invite</button>
                )}
              </div>
            </article>
          ))}
        </section>
      )}

      {filtered.length > pageSize && (
        <div className="pagination">
          <button disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>← Previous</button>
          <span>Page {page + 1} of {Math.ceil(filtered.length / pageSize)} · {filtered.length} projects</span>
          <button disabled={(page + 1) * pageSize >= filtered.length} onClick={() => setPage((current) => current + 1)}>Next →</button>
        </div>
      )}

      {showCreate && (
        <div className="modal-backdrop" role="presentation">
          <section className="project-modal" role="dialog" aria-modal="true" aria-labelledby="create-project-title">
            <button className="modal-close" aria-label="Close" onClick={() => setShowCreate(false)}>×</button>
            <p className="overline">NEW PROJECT</p>
            <h2 id="create-project-title">Create a project</h2>
            <p className="modal-copy">Start a private project space, then invite your supervisor and teammates.</p>
            <form onSubmit={createProject} ref={createFormRef}>
              <label>Project name<input name="name" required minLength={2} maxLength={120} placeholder="e.g. Nova thesis" autoFocus /></label>
              <label>Description<textarea name="description" rows={3} placeholder="What is the team building?" /></label>
              <label>Category<input name="category" placeholder="e.g. engineering" /></label>
              <label>Target date<DateField name="targetDate" emptyText="Optional" /></label>
              <label className="roadmap-toggle">
                <input type="checkbox" checked={showRoadmap} onChange={(event) => setShowRoadmap(event.target.checked)} />
                <span>Add a roadmap now</span>
              </label>
              {showRoadmap && <RoadmapPlanner readBrief={readBrief} onChange={acceptDraft} />}
              <div className="modal-actions">
                <button type="button" className="cancel-button" onClick={() => setShowCreate(false)}>Cancel</button>
                <button className="new-project" disabled={busy}>{busy ? "Creating..." : "Create project"}</button>
              </div>
            </form>
          </section>
        </div>
      )}

      {settingsFor && (
        <div className="modal-backdrop" role="presentation">
          <section className="project-modal" role="dialog" aria-modal="true" aria-labelledby="project-settings-title">
            <button className="modal-close" aria-label="Close" onClick={() => setSettingsFor(null)}>×</button>
            <p className="overline">PROJECT SETTINGS</p>
            <h2 id="project-settings-title">{settingsFor.name}</h2>
            <p className="modal-copy">Only the project owner can change these details. Every change is recorded in the audit log.</p>
            <form onSubmit={saveSettings}>
              <label>Name<input name="name" required minLength={2} defaultValue={settingsFor.name} /></label>
              <label>Description<textarea name="description" rows={3} defaultValue={settingsFor.description} /></label>
              <label>Category<input name="category" defaultValue={settingsFor.category ?? ""} /></label>
              <label>University<input name="university" defaultValue={settingsFor.university ?? ""} /></label>
              <label>Department<input name="department" defaultValue={settingsFor.department ?? ""} /></label>
              <label>Start date<DateField key={`start-${settingsFor.id}`} name="startDate" defaultValue={settingsFor.start_date ?? ""} emptyText="Not set" /></label>
              <label>Target date<DateField key={`target-${settingsFor.id}`} name="targetDate" defaultValue={settingsFor.target_date ?? ""} emptyText="Not set" /></label>
              <div className="modal-actions">
                <button type="button" className="cancel-button" onClick={() => setSettingsFor(null)}>Close</button>
                <button className="new-project" disabled={busy}>{busy ? "Saving..." : "Save settings"}</button>
              </div>
            </form>
            <RoadmapPanel teamId={settingsFor.id} onChanged={refresh} />
            <div className="danger-zone">
              <div>
                <strong>Delete this project</strong>
                <p>Permanently removes the project, its tasks, meetings, chat and files for every member.</p>
              </div>
              <button type="button" className="danger-button" onClick={() => setDeleteOpen(true)}>Delete project</button>
            </div>
          </section>
        </div>
      )}

      {settingsFor && deleteOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="project-modal project-modal-compact" role="alertdialog" aria-modal="true" aria-labelledby="delete-project-title">
            <p className="overline">PERMANENT ACTION</p>
            <h2 id="delete-project-title">Delete “{settingsFor.name}”?</h2>
            <p className="modal-copy">
              This cannot be undone. All tasks, meetings, conversations, files and member access will be removed, and invited
              collaborators will lose access immediately.
            </p>
            {message && <p className="screen-message error" role="status">{message}</p>}
            <div className="modal-actions">
              <button type="button" className="cancel-button" onClick={() => setDeleteOpen(false)} disabled={busy}>Cancel</button>
              <button type="button" className="danger-button solid" onClick={deleteProject} disabled={busy}>
                {busy ? "Deleting..." : "Delete permanently"}
              </button>
            </div>
          </section>
        </div>
      )}

      {inviteFor && (
        <div className="modal-backdrop" role="presentation">
          <section className="project-modal" role="dialog" aria-modal="true" aria-labelledby="invite-project-title">
            <button className="modal-close" aria-label="Close" onClick={() => setInviteFor(null)}>×</button>
            <p className="overline">{inviteFor.name.toUpperCase()}</p>
            <h2 id="invite-project-title">Invite a collaborator</h2>
            <p className="modal-copy">We&apos;ll email them a secure Collabry invitation right away. It expires after 72 hours and never grants access before acceptance.</p>
            <form onSubmit={sendInvitation}>
              <label>Email address<input name="email" type="email" required placeholder="person@university.edu" /></label>
              <label>Role
                <select name="role" defaultValue="member">
                  <option value="member">Team member</option>
                  <option value="supervisor">Supervisor</option>
                  <option value="leader">Team leader</option>
                  <option value="reviewer">Reviewer</option>
                </select>
              </label>
              <div className="modal-actions">
                <button type="button" className="cancel-button" onClick={() => setInviteFor(null)}>Close</button>
                <button className="new-project" disabled={busy}>{busy ? "Sending..." : "Send invitation"}</button>
              </div>
            </form>
            {invitations.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <p className="overline">PENDING INVITATIONS</p>
                {invitations.slice(0, 6).map((invitation) => (
                  <div className="toggle-row" key={invitation.id}>
                    <div>
                      <strong>{invitation.invitee_email}</strong>
                      <p>{invitation.role} · expires {new Date(invitation.expires_at).toLocaleDateString()}</p>
                    </div>
                    <span className={`badge ${invitation.status === "pending" ? "violet" : "muted"}`}>{invitation.status}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </WorkspaceShell>
  );
}

export default function ProjectsPage() {
  return (
    <Suspense fallback={<main className="auth-loading">Loading projects...</main>}>
      <ProjectsScreen />
    </Suspense>
  );
}
