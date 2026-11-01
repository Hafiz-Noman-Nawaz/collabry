"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

/**
 * Roadmap planning and progress.
 *
 * RoadmapPlanner builds a reviewable draft (typed by the team, or suggested by
 * Gemini from their own description). Nothing reaches the database until the team
 * accepts the draft. RoadmapPanel then shows progress measured from real task rows.
 */

export type DraftPhase = { key: string; title: string; summary: string; tasksText: string; source: "manual" | "gemini" };

export type PhaseRecord = {
  id: string;
  title: string;
  summary: string;
  position: number;
  status: "planned" | "active" | "done";
  start_date: string | null;
  end_date: string | null;
  source: string;
  task_total: number;
  task_done: number;
};

type GeneratedPhase = { title: string; summary: string; tasks: Array<{ title: string }> };

const PHASE_LABELS: Record<PhaseRecord["status"], string> = {
  planned: "Planned",
  active: "In progress",
  done: "Complete",
};

let seq = 0;
function nextKey() {
  seq += 1;
  return `p${seq}`;
}

function emptyPhase(title = "", summary = "", tasksText = "", source: DraftPhase["source"] = "manual"): DraftPhase {
  return { key: nextKey(), title, summary, tasksText, source };
}

function phaseTasks(phase: DraftPhase) {
  return phase.tasksText
    .split("\n")
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

export type ReviewedPhase = { title: string; summary: string; source: "manual" | "gemini"; tasks: string[] };

export function RoadmapPlanner({
  readBrief,
  onChange,
}: {
  readBrief: () => { projectName: string; description: string };
  onChange: (phases: ReviewedPhase[]) => void;
}) {
  const [mode, setMode] = useState<"manual" | "suggest">("manual");
  const [phases, setPhases] = useState<DraftPhase[]>([emptyPhase()]);
  const [technologies, setTechnologies] = useState("");
  const [notes, setNotes] = useState("");
  const [questions, setQuestions] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [generating, setGenerating] = useState(false);

  const reviewed = useMemo(
    () =>
      phases
        .map((phase) => ({ ...phase, title: phase.title.trim(), summary: phase.summary.trim(), tasks: phaseTasks(phase) }))
        .filter((phase) => phase.title.length > 0)
        .map(({ title, summary, tasks, source }) => ({ title, summary, tasks, source })),
    [phases],
  );

  useEffect(() => {
    onChange(reviewed);
  }, [reviewed, onChange]);

  function update(key: string, patch: Partial<DraftPhase>) {
    setPhases((current) => current.map((phase) => (phase.key === key ? { ...phase, ...patch } : phase)));
  }

  async function suggest() {
    const brief = readBrief();
    if (brief.projectName.trim().length < 2) {
      setStatus("Give the project a name first — the plan is built from your description.");
      return;
    }
    if (brief.description.trim().length < 40) {
      setStatus("Describe the project in a little more detail so the plan stays grounded in what you wrote.");
      return;
    }
    setGenerating(true);
    setStatus("Planning from your description…");
    setQuestions([]);
    const response = await fetch("/api/roadmap/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectName: brief.projectName.trim(),
        description: brief.description.trim(),
        technologies: technologies.trim(),
        notes: notes.trim(),
      }),
    });
    const result = await response.json().catch(() => ({}));
    setGenerating(false);
    if (!response.ok) {
      setStatus(result.error ?? "The plan could not be produced.");
      return;
    }
    const generated = (result.draft?.phases ?? []) as GeneratedPhase[];
    setPhases(generated.map((phase) => emptyPhase(phase.title, phase.summary, phase.tasks.map((task) => task.title).join("\n"), "gemini")));
    setQuestions((result.draft?.questions ?? []) as string[]);
    setStatus(`${generated.length} phases suggested. Edit anything that does not fit before creating the project.`);
  }

  return (
    <div className="roadmap-planner">
      <div className="roadmap-tabs" role="tablist" aria-label="Roadmap input">
        <button type="button" role="tab" aria-selected={mode === "manual"} className={mode === "manual" ? "on" : ""} onClick={() => setMode("manual")}>
          Write it ourselves
        </button>
        <button type="button" role="tab" aria-selected={mode === "suggest"} className={mode === "suggest" ? "on" : ""} onClick={() => setMode("suggest")}>
          Suggest from our description
        </button>
      </div>

      {mode === "suggest" && (
        <div className="roadmap-brief">
          <label>
            Technologies you plan to use
            <input value={technologies} onChange={(event) => setTechnologies(event.target.value)} placeholder="e.g. Next.js, Supabase, React, Tailwind" maxLength={1200} />
          </label>
          <label>
            Anything else to respect (optional)
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} placeholder="e.g. four team members, a demo every two weeks, no budget for paid services" maxLength={2000} />
          </label>
          <button type="button" className="roadmap-suggest" onClick={suggest} disabled={generating}>
            {generating ? "Planning…" : "Suggest a roadmap"}
          </button>
          <p className="roadmap-hint">
            The plan is built only from what you wrote above. Nothing is saved until you create the project, and you can edit every line.
          </p>
        </div>
      )}

      {status && (
        <p className={`roadmap-status${status.startsWith("Planning") ? " waiting" : ""}`} role="status">
          {status}
        </p>
      )}

      <div className="roadmap-phases">
        {phases.map((phase, index) => (
          <div className="roadmap-phase-edit" key={phase.key}>
            <div className="roadmap-phase-head">
              <span>Phase {index + 1}</span>
              {phases.length > 1 && (
                <button type="button" className="roadmap-remove" aria-label={`Remove phase ${index + 1}`} onClick={() => setPhases((current) => current.filter((entry) => entry.key !== phase.key))}>
                  ×
                </button>
              )}
            </div>
            <input value={phase.title} onChange={(event) => update(phase.key, { title: event.target.value })} placeholder="Phase name, e.g. Requirements and setup" maxLength={140} aria-label={`Phase ${index + 1} title`} />
            <input value={phase.summary} onChange={(event) => update(phase.key, { summary: event.target.value })} placeholder="What this phase achieves (optional)" maxLength={320} aria-label={`Phase ${index + 1} summary`} />
            <textarea
              value={phase.tasksText}
              onChange={(event) => update(phase.key, { tasksText: event.target.value })}
              rows={3}
              placeholder={"One task per line, e.g.\nSet up the repository and database\nAgree the feature list with the supervisor"}
              aria-label={`Phase ${index + 1} tasks`}
            />
            <small>{phaseTasks(phase).length} task line(s) — each becomes a task you can track.</small>
          </div>
        ))}
      </div>

      {phases.length < 6 && (
        <button type="button" className="roadmap-add" onClick={() => setPhases((current) => [...current, emptyPhase()])}>
          + Add phase
        </button>
      )}

      {questions.length > 0 && (
        <div className="roadmap-questions">
          <strong>The plan could not answer these</strong>
          <ul>
            {questions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

async function fetchRoadmap(teamId: string): Promise<{ phases: PhaseRecord[]; error: string }> {
  const response = await fetch(`/api/roadmap?teamId=${teamId}`);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return { phases: [], error: result.error ?? "Unable to load the roadmap." };
  return { phases: (result.phases ?? []) as PhaseRecord[], error: "" };
}

/** Progress is read from the task rows in each phase; there is no manual percentage. */
export function RoadmapPanel({ teamId, onChanged }: { teamId: string; onChanged?: () => void }) {
  const [phases, setPhases] = useState<PhaseRecord[] | null>(null);
  const [status, setStatus] = useState("");
  const [adding, setAdding] = useState(false);
  const [newPhase, setNewPhase] = useState<DraftPhase>(emptyPhase());

  useEffect(() => {
    if (!teamId) return;
    let active = true;
    fetchRoadmap(teamId).then((result) => {
      if (!active) return;
      setPhases(result.phases);
      setStatus(result.error);
    });
    return () => {
      active = false;
    };
  }, [teamId]);

  const loading = phases === null;
  const listed = useMemo(() => phases ?? [], [phases]);

  async function reload() {
    const result = await fetchRoadmap(teamId);
    setPhases(result.phases);
    setStatus(result.error);
  }

  const totals = useMemo(() => {
    const tasks = listed.reduce((sum, phase) => sum + phase.task_total, 0);
    const done = listed.reduce((sum, phase) => sum + Math.min(phase.task_done, phase.task_total), 0);
    return { tasks, done, percent: tasks > 0 ? Math.round((done / tasks) * 100) : 0 };
  }, [listed]);

  function fail(message: string) {
    setStatus(message);
  }

  async function savePhase(event: FormEvent) {
    event.preventDefault();
    const payload = {
      teamId,
      phases: [
        {
          title: newPhase.title.trim(),
          summary: newPhase.summary.trim(),
          tasks: phaseTasks(newPhase).map((title) => ({ title, priority: "medium", description: "" })),
        },
      ],
    };
    const response = await fetch("/api/roadmap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      fail(result.error ?? "Unable to add the phase.");
      return;
    }
    setNewPhase(emptyPhase());
    setAdding(false);
    await reload();
    onChanged?.();
  }

  async function changeStatus(phase: PhaseRecord, next: PhaseRecord["status"]) {
    setPhases((current) => (current ?? []).map((entry) => (entry.id === phase.id ? { ...entry, status: next } : entry)));
    const response = await fetch(`/api/roadmap/${phase.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      fail(result.error ?? "Unable to update that phase.");
      await reload();
      return;
    }
    await reload();
    onChanged?.();
  }

  async function removePhase(phase: PhaseRecord) {
    if (!window.confirm(`Remove the phase "${phase.title}"? Its ${phase.task_total} task(s) stay in the project, unassigned.`)) return;
    const response = await fetch(`/api/roadmap/${phase.id}`, { method: "DELETE" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      fail(result.error ?? "Unable to remove that phase.");
      return;
    }
    await reload();
    onChanged?.();
  }

  return (
    <div className="roadmap-panel">
      <div className="roadmap-panel-head">
        <div>
          <strong>Roadmap</strong>
          <p>
            {listed.length === 0
              ? "No phases yet."
              : `${totals.done} of ${totals.tasks} tasks complete · ${totals.percent}%`}
          </p>
        </div>
        <button type="button" className="roadmap-add" onClick={() => setAdding((current) => !current)}>
          {adding ? "Close" : "+ Add phase"}
        </button>
      </div>

      {totals.tasks > 0 && (
        <div className="roadmap-progress" role="progressbar" aria-valuenow={totals.percent} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: `${totals.percent}%` }} />
        </div>
      )}

      {loading && <p className="roadmap-hint">Loading the roadmap…</p>}
      {status && <p className="roadmap-status">{status}</p>}

      {adding && (
        <form className="roadmap-new-phase" onSubmit={savePhase}>
          <input value={newPhase.title} onChange={(event) => setNewPhase((current) => ({ ...current, title: event.target.value }))} placeholder="Phase name" maxLength={140} required autoFocus aria-label="New phase name" />
          <input value={newPhase.summary} onChange={(event) => setNewPhase((current) => ({ ...current, summary: event.target.value }))} placeholder="What this phase achieves (optional)" maxLength={320} aria-label="New phase summary" />
          <textarea value={newPhase.tasksText} onChange={(event) => setNewPhase((current) => ({ ...current, tasksText: event.target.value }))} rows={3} placeholder={"One task per line"} aria-label="New phase tasks" />
          <button type="submit" disabled={newPhase.title.trim().length === 0}>Add phase</button>
        </form>
      )}

      {!loading && listed.length === 0 && !adding && (
        <p className="roadmap-hint">Add a phase, or plan the whole roadmap when you create the project.</p>
      )}

      <div className="roadmap-list">
        {listed.map((phase) => (
          <article className={`roadmap-row ${phase.status}`} key={phase.id}>
            <div className="roadmap-row-main">
              <strong>{phase.title}</strong>
              {phase.summary && <p>{phase.summary}</p>}
              <small>
                {phase.task_done}/{phase.task_total} tasks done
                {phase.source === "gemini" ? " · suggested from your description" : ""}
              </small>
            </div>
            <div className="roadmap-row-side">
              <div className="roadmap-mini" aria-hidden="true">
                <i style={{ width: `${phase.task_total > 0 ? Math.round((Math.min(phase.task_done, phase.task_total) / phase.task_total) * 100) : 0}%` }} />
              </div>
              <select value={phase.status} onChange={(event) => changeStatus(phase, event.target.value as PhaseRecord["status"])} aria-label={`${phase.title} status`}>
                {Object.entries(PHASE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <button type="button" className="roadmap-remove" aria-label={`Remove ${phase.title}`} onClick={() => removePhase(phase)}>
                ×
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
