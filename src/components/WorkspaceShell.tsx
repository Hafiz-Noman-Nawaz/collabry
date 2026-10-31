"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
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
  const [email, setEmail] = useState("");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [teams, setTeams] = useState<SearchTeam[]>([]);
  const seenNotifications = useRef<Set<string>>(new Set());
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const supabase = createClient();

    async function checkNotifications() {
      const response = await fetch("/api/notifications?limit=50");
      if (!response.ok || cancelled) return;
      const result = await response.json();
      const list: NotificationItem[] = result.notifications ?? [];
      if (cancelled) return;
      const unreadList = list.filter((item) => !item.read_at);
      setNotifications(list);
      setUnread(unreadList.length);
      setMessageUnread(unreadList.filter((item) => item.kind === "message").length);
      const canNotify = typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted";
      for (const item of list) {
        if (item.read_at || seenNotifications.current.has(item.id)) continue;
        seenNotifications.current.add(item.id);
        if (canNotify) {
          new Notification("Collabry", {
            body: item.body ? `${item.title} — ${item.body}` : item.title,
            icon: "/collabry-mark.svg",
          });
        }
      }
      timer = window.setTimeout(checkNotifications, 30000);
    }

    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) {
        router.replace("/login");
        return;
      }
      if (!cancelled) setEmail(data.user.email ?? "");
      checkNotifications();
    });

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
      if (timer) window.clearTimeout(timer);
    };
  }, [router]);

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

  async function openNotification(item: NotificationItem) {
    setNotifyOpen(false);
    if (!item.read_at) {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id }),
      });
      setNotifications((current) => current.map((entry) => (entry.id === item.id ? { ...entry, read_at: new Date().toISOString() } : entry)));
      setUnread((current) => Math.max(0, current - 1));
    }
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
                      <small>{unread} unread</small>
                    </div>
                    <button type="button" className="notify-mark" onClick={markAllRead} disabled={unread === 0}>
                      Mark all read
                    </button>
                  </div>
                  {notifications.length === 0 ? (
                    <p className="notification-empty">You are up to date.</p>
                  ) : (
                    notifications.slice(0, 12).map((item) => (
                      <button
                        key={item.id}
                        className={`notification-item ${item.read_at ? "read" : ""}`}
                        onClick={() => openNotification(item)}
                      >
                        <span className="notification-dot">{item.kind.slice(0, 1).toUpperCase()}</span>
                        <span>
                          <strong>{item.title}</strong>
                          {item.body && <small>{item.body}</small>}
                        </span>
                      </button>
                    ))
                  )}
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
