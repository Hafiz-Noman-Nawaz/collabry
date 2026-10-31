"use client";

import { ChangeEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { WorkspaceShell } from "@/components/WorkspaceShell";
import { createClient } from "@/lib/supabase/browser";
import { ALLOWED_UPLOAD_TYPE_SET, UPLOAD_ACCEPT, typeBadge } from "@/lib/uploads";
import { formatBytes, titleCase } from "@/lib/format";

type Team = { id: string; name: string };
type TaskOption = { id: string; title: string };
type ProjectFile = {
  id: string;
  file_name: string;
  category: string;
  content_type: string;
  file_size: number;
  created_at: string;
  uploaded_by: string;
  task_id: string | null;
  submission_status: "draft" | "submitted" | "approved" | "changes_requested";
  review_note: string;
  reviewed_by: string | null;
};
type Usage = { usedBytes: number; quotaBytes: number; percentUsed: number };

const PAGE_SIZE = 20;
const MAX_UPLOAD_SIZE = 100 * 1024 * 1024;
const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  submitted: "In review",
  approved: "Approved",
  changes_requested: "Changes requested",
};

export default function FilesPage() {
  const router = useRouter();
  const [team, setTeam] = useState<Team | null>(null);
  const [tasks, setTasks] = useState<TaskOption[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [total, setTotal] = useState(0);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [category, setCategory] = useState("general");
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [userId, setUserId] = useState("");

  const loadFiles = useCallback(async (teamId: string, pageOffset: number, query: string, cat: string, status: string) => {
    const params = new URLSearchParams({ teamId, limit: String(PAGE_SIZE), offset: String(pageOffset * PAGE_SIZE) });
    if (query) params.set("q", query);
    if (cat) params.set("category", cat);
    if (status) params.set("status", status);
    const response = await fetch(`/api/files?${params.toString()}`);
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      setMessage(result.error ?? "Unable to load files.");
      return;
    }
    const result = await response.json();
    if (pageOffset === 0) setFiles(result.files ?? []);
    else setFiles((current) => [...current, ...(result.files ?? [])]);
    setTotal(result.total ?? 0);
    setUsage(result.usage ?? null);
  }, []);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) {
        router.replace("/login");
        return;
      }
      if (cancelled) return;
      setUserId(data.user.id);
      const { data: teams } = await supabase.from("teams").select("id, name").order("created_at", { ascending: false }).limit(1);
      const firstTeam = teams?.[0] ?? null;
      setTeam(firstTeam);
      if (firstTeam) {
        await loadFiles(firstTeam.id, 0, "", "", "");
        const taskResponse = await fetch(`/api/tasks?teamId=${firstTeam.id}`);
        if (taskResponse.ok && !cancelled) {
          const taskData = await taskResponse.json();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          setTasks((taskData.tasks ?? []).map((t: any) => ({ id: t.id, title: t.title })));
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [router, loadFiles]);

  async function applyFilters(term: string, cat: string, status: string, pageOffset = 0) {
    setPage(pageOffset);
    if (team) await loadFiles(team.id, pageOffset, term, cat, status);
  }

  async function upload() {
    if (!team || !selectedFile) return;
    setBusy(true);
    setMessage("");
    const formData = new FormData();
    formData.set("teamId", team.id);
    formData.set("category", category);
    formData.set("file", selectedFile);
    if (selectedTaskId) {
      formData.set("taskId", selectedTaskId);
    }
    const response = await fetch("/api/files", { method: "POST", body: formData });
    const result = await response.json();
    if (!response.ok) setMessage(result.error ?? "Unable to upload file.");
    else {
      setFiles((current) => [result.file, ...current]);
      setTotal((current) => current + 1);
      setUsage(result.usage ?? null);
      setSelectedFile(null);
      setSelectedTaskId("");
      setMessage("File uploaded securely.");
    }
    setBusy(false);
  }

  async function download(file: ProjectFile) {
    const response = await fetch(`/api/files/${file.id}`);
    const result = await response.json();
    if (!response.ok) {
      setMessage(result.error ?? "Unable to prepare download.");
      return;
    }
    window.open(result.url, "_blank", "noopener,noreferrer");
  }

  async function removeFile(file: ProjectFile) {
    if (!window.confirm(`Delete ${file.file_name}? This cannot be undone.`)) return;
    const response = await fetch(`/api/files/${file.id}`, { method: "DELETE" });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      setMessage(result.error ?? "Unable to delete the file.");
      return;
    }
    setFiles((current) => current.filter((item) => item.id !== file.id));
    setTotal((current) => Math.max(0, current - 1));
    if (usage) {
      setUsage({
        ...usage,
        usedBytes: Math.max(0, usage.usedBytes - file.file_size),
        percentUsed: Math.max(0, Math.round(((usage.usedBytes - file.file_size) / (usage.quotaBytes || 1)) * 100)),
      });
    }
    setMessage("File deleted.");
  }

  async function setSubmission(file: ProjectFile, submissionStatus: string) {
    const response = await fetch(`/api/files/${file.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ submissionStatus }),
    });
    const result = await response.json();
    if (!response.ok) {
      setMessage(result.error ?? "Unable to update the submission.");
      return;
    }
    setFiles((current) => current.map((item) => (item.id === file.id ? { ...item, ...result.file } : item)));
    setMessage(`Submission marked as ${STATUS_LABEL[submissionStatus]?.toLowerCase() ?? submissionStatus}.`);
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const candidate = event.target.files?.[0] ?? null;
    if (!candidate) {
      setSelectedFile(null);
      return;
    }
    // Fail before the request so the user is not waiting on an upload that the
    // server is certain to reject.
    if (!ALLOWED_UPLOAD_TYPE_SET.has(candidate.type)) {
      setSelectedFile(null);
      setMessage("Pick a PDF, image, text, Markdown, DOCX or ZIP file.");
      event.target.value = "";
      return;
    }
    if (candidate.size === 0 || candidate.size > MAX_UPLOAD_SIZE) {
      setSelectedFile(null);
      setMessage("Files must be between 1 byte and 100 MB.");
      event.target.value = "";
      return;
    }
    setSelectedFile(candidate);
  }

  const categories = Array.from(new Set(files.map((file) => file.category)));

  return (
    <WorkspaceShell active="" dense>
      <section className="files-layout">
        <div className="files-heading">
          <div>
            <p className="overline">{team?.name ?? "PROJECT WORKSPACE"}</p>
            <h1>Shared files</h1>
            <p>Private project materials with controlled, expiring downloads.</p>
          </div>
          <label className="file-picker">
            Choose file
            <input type="file" accept={UPLOAD_ACCEPT} onChange={chooseFile} />
          </label>
        </div>

        {usage && (
          <div style={{ marginBottom: 14 }}>
            <div className="bar-row" style={{ gridTemplateColumns: "1fr 60px" }}>
              <span className="track">
                <span className="fill" style={{ width: `${Math.min(100, usage.percentUsed)}%` }} />
              </span>
              <b>{usage.percentUsed}%</b>
            </div>
            <p style={{ margin: "4px 0 0", color: "#777798", fontSize: 9 }}>
              {formatBytes(usage.usedBytes)} of {formatBytes(usage.quotaBytes)} used
            </p>
          </div>
        )}

        <div className="upload-row">
          <div>
            <strong>{selectedFile ? selectedFile.name : "No file selected"}</strong>
            <small>{selectedFile ? formatBytes(selectedFile.size) : "PDF, images, text, DOCX, and ZIP up to 100 MB"}</small>
          </div>
          <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Upload category">
            <option value="general">General</option>
            <option value="research">Research</option>
            <option value="deliverable">Deliverable</option>
            <option value="meeting">Meeting</option>
            <option value="reference">Reference</option>
          </select>
          <select
            value={selectedTaskId}
            onChange={(event) => setSelectedTaskId(event.target.value)}
            aria-label="Link to task"
            style={{ maxWidth: 200 }}
          >
            <option value="">No task linked</option>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
          <button className="new-project" disabled={!selectedFile || !team || busy} onClick={upload}>
            {busy ? "Uploading..." : "Upload securely"}
          </button>
        </div>

        <div className="screen-toolbar" style={{ marginTop: 14 }}>
          <input
            className="grow"
            placeholder="Search files..."
            value={search}
            aria-label="Search files"
            onChange={(event) => { setSearch(event.target.value); applyFilters(event.target.value, filterCategory, statusFilter, 0); }}
          />
          <select
            value={filterCategory}
            aria-label="Filter by category"
            onChange={(event) => { setFilterCategory(event.target.value); applyFilters(search, event.target.value, statusFilter, 0); }}
          >
            <option value="">All categories</option>
            {categories.map((item) => <option key={item} value={item}>{titleCase(item)}</option>)}
          </select>
          <select
            value={statusFilter}
            aria-label="Filter by submission status"
            onChange={(event) => { setStatusFilter(event.target.value); applyFilters(search, filterCategory, event.target.value, 0); }}
          >
            <option value="">Any status</option>
            <option value="draft">Draft</option>
            <option value="submitted">In review</option>
            <option value="approved">Approved</option>
            <option value="changes_requested">Changes requested</option>
          </select>
        </div>

        {message && <p className="file-message" role="status">{message}</p>}

        <section className="file-list">
          <div className="file-list-heading">
            <h2>Library</h2>
            <span>{total} files</span>
          </div>
          {files.length === 0 ? (
            <div className="file-empty">
              <span>↗</span>
              <strong>No shared files yet</strong>
              <p>Upload your first project material to keep the team working from one source of truth.</p>
            </div>
          ) : (
            files.map((file) => {
              const linkedTask = tasks.find((t) => t.id === file.task_id);
              return (
                <article className="file-row" key={file.id}>
                  <span className="file-type">{typeBadge(file.content_type, file.file_name)}</span>
                  <div>
                    <strong>{file.file_name}</strong>
                    <small>
                      {titleCase(file.category)} · {formatBytes(file.file_size)} · {new Date(file.created_at).toLocaleDateString()}
                      {" · "}<span className={`badge ${file.submission_status === "approved" ? "" : file.submission_status === "submitted" ? "violet" : file.submission_status === "changes_requested" ? "warn" : "muted"}`}>
                        {STATUS_LABEL[file.submission_status]}
                      </span>
                      {linkedTask && <span className="badge violet" style={{ marginLeft: 6 }}>📌 {linkedTask.title}</span>}
                    </small>
                    {file.review_note && <small style={{ color: "#ffb49f" }}>Reviewer: {file.review_note}</small>}
                  </div>
                  <div className="row-actions">
                    <button onClick={() => download(file)}>Download</button>
                    {file.uploaded_by === userId && file.submission_status !== "submitted" && file.submission_status !== "approved" && (
                      <button className="muted" onClick={() => setSubmission(file, "submitted")}>Submit</button>
                    )}
                    {file.submission_status === "submitted" && (
                      <>
                        <button className="muted" onClick={() => setSubmission(file, "approved")}>Approve</button>
                        <button className="muted" onClick={() => setSubmission(file, "changes_requested")}>Request changes</button>
                      </>
                    )}
                    {file.uploaded_by === userId && (
                      <button className="muted" onClick={() => removeFile(file)}>Delete</button>
                    )}
                  </div>
                </article>
              );
            })
          )}
          {files.length < total && (
            <div className="pagination">
              <button onClick={() => applyFilters(search, filterCategory, statusFilter, page + 1)}>Load more</button>
              <span>{files.length} of {total} shown</span>
            </div>
          )}
        </section>
      </section>
    </WorkspaceShell>
  );
}
