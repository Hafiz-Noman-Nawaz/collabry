"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/browser";

const workspaceNav: Array<{ label: string; href: string; icon: string }> = [
  { label: "Overview", href: "/", icon: "dashboard" },
  { label: "Projects", href: "/projects", icon: "folder" },
  { label: "Timeline", href: "/timeline", icon: "timeline" },
  { label: "Team", href: "/team", icon: "team" },
  { label: "Reports", href: "/reports", icon: "report" },
  { label: "Settings", href: "/settings", icon: "settings" },
];

type NotificationItem = {
  id: string;
  kind: string;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
  resource_type: string | null;
  resource_id: string | null;
};

type SearchTeam = { id: string; name: string };

function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    dashboard: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
    folder: "M3 6h7l2 2h9v10H3z",
    timeline: "M5 18V8m7 10V4m7 14v-7",
    team: "M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1m8-9a4 4 0 1 0-8 0 4 4 0 0 0 8 0Zm8 9v-1a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
    report: "M5 20V10m7 10V4m7 16v-7",
    message: "M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5Z",
    settings: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z",
    files: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z M14 3v6h6",
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name] ?? paths.dashboard} />
    </svg>
  );
}

function notificationHref(item: NotificationItem) {
  // Deep-link when the notification names a screen we actually have.
  if (item.resource_type === "task" && item.resource_id) return `/tasks/${item.resource_id}`;
  if (item.resource_type === "meeting" && item.resource_id) return `/meetings/${item.resource_id}`;
  if (item.resource_type === "file") return "/files";
  if (item.kind === "message") return "/messages";
  if (item.kind === "meeting" || item.kind === "announcement") return "/timeline";
  if (item.kind === "task" || item.kind === "review") return "/projects";
  if (item.kind === "invitation") return "/team";
  return "/";
}

/** Module scope: the clock read must stay out of the render path. */
function timeAgo(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function WorkspaceShell({
  active,
  dense,
  children,
}: {
  active: string;
  dense?: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [unread, setUnread] = useState(0);
  const [messageUnread, setMessageUnread] = useState(0);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [notifyFilter, setNotifyFilter] = useState<"all" | "unread">("all");
  const [email, setEmail] = useState("");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiAnswer, setAiAnswer] = useState("");
  const [aiSources, setAiSources] = useState<Array<{ citation: string; title: string; type: string }>>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
  const [query, setQuery] = useState("");
  const [teams, setTeams] = useState<SearchTeam[]>([]);
  const seenNotifications = useRef<Set<string>>(new Set());
  const booted = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);

  const loadNotifications = useCallback(async () => {
    const response = await fetch("/api/notifications?limit=80");
    if (!response.ok) return;
    const result = await response.json();
    const list: NotificationItem[] = result.notifications ?? [];
    const unreadList = list.filter((item) => !item.read_at);
    setNotifications(list);
    setUnread(unreadList.length);
    setMessageUnread(unreadList.filter((item) => item.kind === "message").length);
    const canNotify = "Notification" in window && Notification.permission === "granted";
    for (const item of list) {
      if (item.read_at || seenNotifications.current.has(item.id)) continue;
      seenNotifications.current.add(item.id);
      // The first load only records what is already waiting; a desktop alert is
      // reserved for things that arrive while the workspace is open.
      if (booted.current && canNotify) {
        new Notification("Collabry", {
          body: item.body ? `${item.title} — ${item.body}` : item.title,
          icon: "/collabry-mark.svg",
        });
      }
    }
    booted.current = true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let debounce: number | undefined;
    const supabase = createClient();

    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) {
        router.replace("/login");
        return;
      }
      if (cancelled) return;
      setEmail(data.user.email ?? "");
      loadNotifications();
    });

    // Realtime is the fast path; the interval only covers a dropped socket.
    const poll = window.setInterval(() => {
      if (!document.hidden) loadNotifications();
    }, 60000);
    const channel = supabase
      .channel("workspace-notifications")
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, () => {
        window.clearTimeout(debounce);
        debounce = window.setTimeout(loadNotifications, 200);
      })
      .subscribe();

    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.clearTimeout(debounce);
      supabase.removeChannel(channel);
    };
  }, [loadNotifications, router]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/teams?limit=50")
      .then((response) => (response.ok ? response.json() : null))
      .then((result) => {
        if (!cancelled && result?.teams) {
          setTeams(result.teams.map((team: SearchTeam) => ({ id: team.id, name: team.name })));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === "Escape") {
        setMobileMenuOpen(false);
        setSearchOpen(false);
        setNotifyOpen(false);
        setAiOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    document.body.style.overflow = mobileMenuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileMenuOpen]);

  useEffect(() => {
    // Close overlays when the history changes via browser back/forward.
    function closeOverlays() {
      setMobileMenuOpen(false);
      setSearchOpen(false);
      setNotifyOpen(false);
    }
    window.addEventListener("popstate", closeOverlays);
    return () => window.removeEventListener("popstate", closeOverlays);
  }, []);

  async function signOut() {
    await createClient().auth.signOut();
    router.push("/login");
  }

  async function askAi(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const teamId = teams[0]?.id;
    if (!teamId || !aiQuestion.trim()) return;
    setAiBusy(true);
    setAiError("");
    setAiAnswer("");
    setAiSources([]);
    try {
      const response = await fetch("/api/ai/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId, question: aiQuestion.trim() }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setAiError(result.error ?? "The AI assistant could not answer.");
        return;
      }
      setAiAnswer(result.answer ?? "");
      setAiSources(result.sources ?? []);
    } catch {
      setAiError("The AI assistant could not be reached. Try again.");
    } finally {
      setAiBusy(false);
    }
  }

  /** Marks one notification read where it stands, without leaving the current screen. */
  async function markOne(item: NotificationItem) {
    if (item.read_at) return;
    const stamp = new Date().toISOString();
    setNotifications((current) => current.map((entry) => (entry.id === item.id ? { ...entry, read_at: stamp } : entry)));
    setUnread((current) => Math.max(0, current - 1));
    if (item.kind === "message") setMessageUnread((current) => Math.max(0, current - 1));
    await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id }),
    }).catch(() => undefined);
  }

  async function openNotification(item: NotificationItem) {
    setNotifyOpen(false);
    await markOne(item);
    router.push(notificationHref(item));
  }

  async function markAllRead() {
    await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    setNotifications((current) => current.map((entry) => ({ ...entry, read_at: entry.read_at ?? new Date().toISOString() })));
    setUnread(0);
    setMessageUnread(0);
  }

  const initials = (email || "U").slice(0, 2).toUpperCase();
  const visibleNotifications = notifyFilter === "unread" ? notifications.filter((item) => !item.read_at) : notifications;
  const messagesActive = pathname.startsWith("/messages");
  const filesActive = pathname.startsWith("/files");
  const searchHits = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const destinations = [
      { label: "Messages", href: "/messages", hint: "Team chat" },
      { label: "Files", href: "/files", hint: "Private library" },
      ...workspaceNav.map((item) => ({ label: item.label, href: item.href, hint: "Workspace" })),
    ];
    const pageHits = destinations.filter((item) => !needle || item.label.toLowerCase().includes(needle));
    const teamHits = teams
      .filter((team) => !needle || team.name.toLowerCase().includes(needle))
      .slice(0, 6)
      .map((team) => ({ label: team.name, href: "/projects", hint: "Project" }));
    return [...pageHits, ...teamHits];
  }, [query, teams]);

  function go(href: string) {
    setMobileMenuOpen(false);
    setSearchOpen(false);
    router.push(href);
  }

  const navButtons = (
    <>
      <p>Workspace</p>
      {workspaceNav.map((item) => (
        <button
          key={item.label}
          className={active === item.label ? "nav-selected" : ""}
          onClick={() => go(item.href)}
        >
          <Icon name={item.icon} />
          {item.label}
        </button>
      ))}
      <p className="nav-group-spacer">Communication</p>
      <button className={messagesActive ? "nav-selected" : ""} onClick={() => go("/messages")}>
        <Icon name="message" />
        Messages
        {messageUnread > 0 && <em>{messageUnread}</em>}
      </button>
      <button className={filesActive ? "nav-selected" : ""} onClick={() => go("/files")}>
        <Icon name="files" />
        Files
      </button>
    </>
  );

  return (
    <main className="collabry-shell">
      <aside className="collabry-sidebar">
        <div className="collabry-brand">
          <Image src="/collabry-mark.svg" alt="Collabry" width={34} height={34} priority />
          <span>
            Collabry<small>PROJECT WORKSPACE</small>
          </span>
        </div>
        <button className="sidebar-search" type="button" onClick={() => setSearchOpen(true)}>
          <span>⌕</span> Search workspace
        </button>
        <nav className="collabry-nav" aria-label="Workspace navigation">
          {navButtons}
        </nav>
        <div className="sidebar-footer">
          <button className="new-project" onClick={() => go("/projects?new=1")}>
            <span>+</span> New project
          </button>
          <button className="help-link" onClick={signOut}>
            ↪ <span>Log out</span>
          </button>
        </div>
      </aside>

      {mobileMenuOpen && (
        <div className="mobile-drawer-backdrop" onClick={() => setMobileMenuOpen(false)}>
          <div className="mobile-drawer" role="dialog" aria-modal="true" aria-label="Navigation menu" onClick={(event) => event.stopPropagation()}>
            <div className="mobile-drawer-header">
              <div className="collabry-brand" style={{ padding: 0 }}>
                <Image src="/collabry-mark.svg" alt="Collabry" width={30} height={30} priority />
                <span>
                  Collabry<small>PROJECT WORKSPACE</small>
                </span>
              </div>
              <button className="mobile-drawer-close" onClick={() => setMobileMenuOpen(false)} aria-label="Close menu">
                ✕
              </button>
            </div>

            <div className="mobile-user-card">
              <span className="user-avatar">{initials}</span>
              <div className="mobile-user-info">
                <strong>{email || "Workspace user"}</strong>
                <small>Signed in</small>
              </div>
            </div>

            <button className="new-project" style={{ width: "100%", marginBottom: 16 }} onClick={() => go("/projects?new=1")}>
              <span>+</span> New project
            </button>

            <nav className="collabry-nav" style={{ flex: 1 }}>
              {navButtons}
            </nav>

            <div className="mobile-drawer-footer">
              <button className="help-link" onClick={signOut}>
                ↪ <span>Log out</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {searchOpen && (
        <div className="search-backdrop" onClick={() => setSearchOpen(false)}>
          <div className="search-panel" role="dialog" aria-label="Search workspace" onClick={(event) => event.stopPropagation()}>
            <input
              ref={searchInput}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search pages and projects..."
              aria-label="Search workspace"
            />
            <div className="search-results">
              {searchHits.length === 0 ? (
                <p>No matches.</p>
              ) : (
                searchHits.map((hit) => (
                  <button key={`${hit.href}-${hit.label}`} type="button" onClick={() => go(hit.href)}>
                    <strong>{hit.label}</strong>
                    <small>{hit.hint}</small>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {aiOpen && (
        <div className="ai-backdrop" onClick={() => setAiOpen(false)}>
          <div className="ai-panel" role="dialog" aria-modal="true" aria-label="Ask AI" onClick={(event) => event.stopPropagation()}>
            <div className="ai-panel-heading">
              <div>
                <strong>Ask AI</strong>
                <small>Answers are grounded in indexed project knowledge.</small>
              </div>
              <button type="button" onClick={() => setAiOpen(false)} aria-label="Close Ask AI">×</button>
            </div>
            <form onSubmit={askAi}>
              <textarea
                value={aiQuestion}
                onChange={(event) => setAiQuestion(event.target.value)}
                placeholder="Ask about progress, blockers, tasks, roadmap, or decisions…"
                rows={3}
                autoFocus
              />
              <button type="submit" disabled={aiBusy || !aiQuestion.trim() || teams.length === 0}>
                {aiBusy ? "Thinking…" : "Ask"}
              </button>
            </form>
            {aiError && <p className="ai-error">{aiError}</p>}
            {aiAnswer && <div className="ai-answer"><p>{aiAnswer}</p></div>}
            {aiSources.length > 0 && (
              <div className="ai-sources">
                <strong>Sources</strong>
                {aiSources.map((source) => <span key={source.citation}>[{source.citation}] {source.title || source.type}</span>)}
              </div>
            )}
          </div>
        </div>
      )}

      <section className="collabry-content">
        <header className="collabry-topbar">
          <div className="topbar-left">
            <button
              className="hamburger-btn"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation menu"
              aria-expanded={mobileMenuOpen}
            >
              <span className="hamburger-line" />
              <span className="hamburger-line" />
              <span className="hamburger-line" />
            </button>
            <button className="global-search" type="button" onClick={() => setSearchOpen(true)}>
              ⌕ <span>Search workspace...</span>
              <kbd>⌘ K</kbd>
            </button>
            <button className="ask-ai-trigger" type="button" onClick={() => setAiOpen(true)}>
              ✦ Ask AI
            </button>
          </div>

          <div className="top-nav">
            <div className="notify-wrap">
              <button
                className="tool-btn"
                aria-label="Notifications"
                onClick={() => setNotifyOpen((open) => !open)}
                title={`${unread} unread notification${unread === 1 ? "" : "s"}`}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9m4 13a2 2 0 0 0 4 0" />
                </svg>
                {unread > 0 && <i />}
              </button>
              {notifyOpen && (
                <div className="notification-panel">
                  <div className="notification-heading">
                    <div>
                      <strong>Notifications</strong>
                      <small>{unread} unread · {notifications.length} kept</small>
                    </div>
                    <button type="button" className="notify-mark" onClick={markAllRead} disabled={unread === 0}>
                      Mark all read
                    </button>
                  </div>
                  <div className="notification-tabs" role="tablist" aria-label="Notification filter">
                    <button type="button" role="tab" aria-selected={notifyFilter === "unread"} className={notifyFilter === "unread" ? "on" : ""} onClick={() => setNotifyFilter("unread")}>
                      Unread{unread > 0 ? ` (${unread})` : ""}
                    </button>
                    <button type="button" role="tab" aria-selected={notifyFilter === "all"} className={notifyFilter === "all" ? "on" : ""} onClick={() => setNotifyFilter("all")}>
                      All ({notifications.length})
                    </button>
                  </div>
                  <div className="notification-scroll">
                    {visibleNotifications.length === 0 ? (
                      <p className="notification-empty">
                        {notifyFilter === "unread" ? "Nothing unread right now." : "You have no notifications yet."}
                      </p>
                    ) : (
                      visibleNotifications.map((item) => (
                        <div key={item.id} className={`notification-row ${item.read_at ? "read" : ""}`}>
                          <button className="notification-item" onClick={() => openNotification(item)}>
                            <span className="notification-dot">{item.kind.slice(0, 1).toUpperCase()}</span>
                            <span className="notification-text">
                              <strong>{item.title}</strong>
                              {item.body && <small>{item.body}</small>}
                              <em>{timeAgo(item.created_at)}</em>
                            </span>
                          </button>
                          <button
                            type="button"
                            className="notification-check"
                            title={item.read_at ? "Already read" : "Mark as read"}
                            aria-label={item.read_at ? "Already read" : `Mark "${item.title}" as read`}
                            disabled={!!item.read_at}
                            onClick={() => markOne(item)}
                          >
                            ✓
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                  {notifications.length > 0 && <p className="notification-foot">Read items stay here — nothing is deleted.</p>}
                </div>
              )}
            </div>

            <Link href="/settings" className="user-avatar" title={email || "Account"}>
              {initials}
            </Link>
          </div>
        </header>

        <div className={`collabry-page${dense ? " collabry-page-dense" : ""}`}>{children}</div>
      </section>
    </main>
  );
}
