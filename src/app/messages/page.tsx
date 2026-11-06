"use client";

import {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  FormEvent,
  TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { WorkspaceShell } from "@/components/WorkspaceShell";
import { createClient } from "@/lib/supabase/browser";
import { formatBytes } from "@/lib/format";
import { ALLOWED_UPLOAD_TYPES, UPLOAD_ACCEPT, typeBadge } from "@/lib/uploads";

/* eslint-disable @next/next/no-img-element -- previews come from blob: and short-lived signed storage URLs, which next/image cannot optimize. */

type Conversation = {
  id: string;
  title: string | null;
  is_group: boolean;
  team_id: string;
  created_by: string;
  created_at: string;
  conversation_members: Array<{ user_id: string; last_read_at: string | null }>;
  messages: Array<{ body: string; sender_id: string; created_at: string }>;
};

type Attachment = {
  id: string;
  file_name: string;
  content_type: string;
  file_size: number;
  /** Object URL for a file that has not reached storage yet. */
  blob_url?: string;
};

type Message = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  edited_at: string | null;
  deleted_at?: string | null;
  profiles: { full_name: string } | null;
  message_attachments: Attachment[];
  message_reactions: Array<{ user_id: string; emoji: string }>;
  pending?: boolean;
  failed?: boolean;
};

type Member = { user_id: string; joined_at?: string; last_read_at?: string | null; profiles: { full_name: string } | null };
type TeamMember = { user_id: string; profiles: { full_name: string } | null };
type Channel = ReturnType<ReturnType<typeof createClient>["channel"]>;
type StagedFile = { key: string; file: File; preview: string | null };
type MenuState = { messageId: string; x: number; y: number };
type CommunicationAnalysis = {
  summary?: string;
  decisions?: string[];
  actionItems?: Array<{ title: string; reason: string }>;
  questions?: string[];
};
type Viewer = { src: string; name: string } | null;

const PAGE_SIZE = 30;
const QUICK_REACTIONS = ["👍", "🎉", "❤️", "👀"];
const MAX_FILES = 5;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const SUPPORTED_TYPES = new Set<string>(ALLOWED_UPLOAD_TYPES);
const MENU_WIDTH = 218;
const MENU_HEIGHT = 228;
const NEAR_BOTTOM_PX = 180;

function isImageType(contentType: string) {
  return contentType.startsWith("image/");
}

/** Kept outside the component: React's compiler flags clock reads during render. */
function stamp() {
  return new Date().toISOString();
}

function localMessageId(sequence: number) {
  return `local-${Date.now()}-${sequence}`;
}

function attachmentSrc(attachment: Attachment) {
  return attachment.blob_url ?? `/api/attachments/${attachment.id}?inline=1`;
}

function computeUnread(conversations: Conversation[], userId: string) {
  const flags: Record<string, boolean> = {};
  for (const conversation of conversations) {
    const mine = conversation.conversation_members?.find((row) => row.user_id === userId);
    const latest = conversation.messages?.[0]?.created_at;
    flags[conversation.id] = !!latest && (!mine?.last_read_at || new Date(mine.last_read_at) < new Date(latest));
  }
  return flags;
}

function formatClock(value: string) {
  return new Date(value).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit" });
}

function dayLabel(value: string) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default function MessagesPage() {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [body, setBody] = useState("");
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [userId, setUserId] = useState("");
  const [notice, setNotice] = useState("");
  const [teamId, setTeamId] = useState("");
  const [showNewConversation, setShowNewConversation] = useState(false);
  const [newConversationTitle, setNewConversationTitle] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [showMembers, setShowMembers] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState("");
  const [typing, setTyping] = useState<Record<string, number>>({});
  const [unread, setUnread] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [viewer, setViewer] = useState<Viewer>(null);
  const [dragging, setDragging] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [brokenImages, setBrokenImages] = useState<Record<string, boolean>>({});
  const [aiBusy, setAiBusy] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState<CommunicationAnalysis | null>(null);

  const typingRef = useRef<Channel | null>(null);
  const typingTimers = useRef<Record<string, number>>({});
  const selectedIdRef = useRef<string>("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const dragDepth = useRef(0);
  const hydrateTimer = useRef<number | undefined>(undefined);
  const sidebarTimer = useRef<number | undefined>(undefined);
  const longPressTimer = useRef<number | undefined>(undefined);
  const drafts = useRef<Map<string, string>>(new Map());
  const failedSends = useRef<Map<string, { body: string; files: File[] }>>(new Map());
  const blobUrls = useRef<Set<string>>(new Set());
  const localSeq = useRef(0);

  useEffect(
    () => () => {
      blobUrls.current.forEach((url) => URL.revokeObjectURL(url));
      window.clearTimeout(hydrateTimer.current);
      window.clearTimeout(sidebarTimer.current);
    },
    [],
  );

  const myName = useMemo(() => {
    const found = teamMembers.find((member) => member.user_id === userId)?.profiles?.full_name?.trim();
    return found || "Someone";
  }, [teamMembers, userId]);

  function announce(partial: string) {
    setNotice(partial);
  }

  async function analyzeConversation() {
    if (!selected || !teamId) return;
    setAiBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/ai/communication", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId, conversationId: selected.id, type: "conversation_summary" }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        announce(result.error ?? "Unable to analyze this conversation.");
        return;
      }
      setAiAnalysis(result.result ?? null);
    } finally {
      setAiBusy(false);
    }
  }

  /** Newest page from the server, merged by id so optimistic rows and older pages survive. */
  const hydrate = useCallback(async (conversationId: string) => {
    const response = await fetch(`/api/messages?conversationId=${conversationId}&limit=${PAGE_SIZE}&offset=0`);
    if (!response.ok) return;
    const result = await response.json();
    const fresh = (result.messages ?? []) as Message[];
    setTotal(result.total ?? 0);
    setMessages((current) => {
      const freshIds = new Set(fresh.map((item) => item.id));
      const kept = current.filter((item) => item.pending || item.failed || !freshIds.has(item.id));
      return [...kept, ...fresh].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    });
  }, []);

  const refreshSidebar = useCallback(async () => {
    if (!teamId) return;
    const response = await fetch(`/api/conversations?teamId=${teamId}`);
    if (!response.ok) return;
    const result = await response.json();
    const loaded = (result.conversations ?? []) as Conversation[];
    setConversations(loaded);
    setUnread(computeUnread(loaded, userId));
  }, [teamId, userId]);

  async function markRead(conversationId: string) {
    const response = await fetch("/api/messages", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId }),
    });
    if (response.ok) setUnread((current) => ({ ...current, [conversationId]: false }));
  }

  useEffect(() => {
    const supabase = createClient();
    let active = true;
    async function load() {
      const { data } = await supabase.auth.getUser();
      if (!data.user) {
        router.replace("/login");
        return;
      }
      if (!active) return;
      setUserId(data.user.id);
      const { data: teams } = await supabase.from("teams").select("id").order("created_at", { ascending: false }).limit(1);
      const firstTeamId = teams?.[0]?.id;
      if (!firstTeamId) return;
      setTeamId(firstTeamId);
      const response = await fetch(`/api/conversations?teamId=${firstTeamId}`);
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        if (active) announce(result.error ?? "Unable to load conversations.");
        return;
      }
      const result = await response.json();
      if (!active) return;
      const loaded = (result.conversations ?? []) as Conversation[];
      setConversations(loaded);
      setUnread(computeUnread(loaded, data.user.id));
      if (loaded[0]) setSelected(loaded[0]);
      const memberResponse = await fetch(`/api/members?teamId=${firstTeamId}`);
      if (memberResponse.ok && active) setTeamMembers((await memberResponse.json()).members ?? []);
    }
    load();
    return () => {
      active = false;
    };
  }, [router]);

  // One page-level stream: every message, attachment and reaction the caller can
  // read arrives here, so a message from a teammate never needs a page refresh.
  useEffect(() => {
    if (!userId) return;
    const supabase = createClient();
    const channel = supabase.channel("chat-stream");

    function rowOf(event: { new: unknown; old: unknown; eventType?: string }) {
      return (event.eventType === "DELETE" ? event.old : event.new) as Record<string, unknown> | undefined;
    }

    function scheduleHydrate(conversationId: string) {
      window.clearTimeout(hydrateTimer.current);
      hydrateTimer.current = window.setTimeout(() => {
        hydrate(conversationId);
      }, 220);
    }

    function scheduleSidebar() {
      window.clearTimeout(sidebarTimer.current);
      sidebarTimer.current = window.setTimeout(refreshSidebar, 700);
    }

    channel
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages" },
        (event) => {
          const row = rowOf(event);
          const conversationId = row?.conversation_id as string | undefined;
          if (!conversationId) return;
          if (conversationId !== selectedIdRef.current) {
            scheduleSidebar();
            return;
          }
          if (event.eventType === "DELETE" || row?.deleted_at) {
            setMessages((current) => current.filter((item) => item.id !== row?.id));
            scheduleSidebar();
            return;
          }
          if (!stickToBottom.current) setShowJump(true);
          scheduleHydrate(conversationId);
          scheduleSidebar();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "message_attachments" },
        () => {
          if (selectedIdRef.current) scheduleHydrate(selectedIdRef.current);
          scheduleSidebar();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "message_reactions" },
        (event) => {
          const row = (event.eventType === "DELETE" ? event.old : event.new) as
            | { message_id: string; user_id: string; emoji: string }
            | undefined;
          if (!row?.message_id) return;
          setMessages((current) =>
            current.map((item) => {
              if (item.id !== row.message_id) return item;
              const without = (item.message_reactions ?? []).filter(
                (reaction) => !(reaction.user_id === row.user_id && reaction.emoji === row.emoji),
              );
              return {
                ...item,
                message_reactions: event.eventType === "DELETE" ? without : [...without, { user_id: row.user_id, emoji: row.emoji }],
              };
            }),
          );
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [hydrate, refreshSidebar, userId]);

  useEffect(() => {
    if (!selected) return;
    const conversationId = selected.id;
    selectedIdRef.current = conversationId;
    stickToBottom.current = true;
    let active = true;

    async function loadMessages() {
      setMessages([]);
      setTotal(0);
      const response = await fetch(`/api/messages?conversationId=${conversationId}&limit=${PAGE_SIZE}&offset=0`);
      if (!response.ok || !active) return;
      const result = await response.json();
      if (!active) return;
      setMessages(result.messages ?? []);
      setTotal(result.total ?? 0);
      // Delivery marker so the unread dot clears once the thread is opened.
      await markRead(conversationId);
      const membersResponse = await fetch(`/api/conversations/${conversationId}/members`);
      if (membersResponse.ok && active) setMembers((await membersResponse.json()).members ?? []);
    }

    loadMessages();
    return () => {
      active = false;
    };
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    const supabase = createClient();
    const channel = supabase.channel(`typing:${selected.id}`);
    typingRef.current = channel;
    channel.on("broadcast", { event: "typing" }, ({ payload }) => {
      const sender = payload as { userId: string; name: string };
      if (!sender?.userId || sender.userId === userId) return;
      setTyping((current) => ({ ...current, [sender.name]: Date.now() }));
      window.clearTimeout(typingTimers.current[sender.name]);
      typingTimers.current[sender.name] = window.setTimeout(() => {
        setTyping((current) => {
          const next = { ...current };
          delete next[sender.name];
          return next;
        });
      }, 4000);
    });
    channel.subscribe();
    return () => {
      channel.unsubscribe();
      typingRef.current = null;
    };
  }, [selected, userId]);

  // Keep the view pinned to the newest message unless the reader scrolled away.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const last = messages[messages.length - 1];
    if (stickToBottom.current || (last && last.sender_id === userId)) {
      list.scrollTop = list.scrollHeight;
    }
    if (messages.length > 0 && document.visibilityState === "visible" && selectedIdRef.current) {
      markRead(selectedIdRef.current);
    }
  }, [messages, userId]);

  useEffect(() => {
    if (!menu && !viewer) return;
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setMenu(null);
        setViewer(null);
      }
    }
    function onPointer(event: globalThis.PointerEvent) {
      if ((event.target as HTMLElement).closest(".message-menu") || (event.target as HTMLElement).closest(".message-bubble")) return;
      setMenu(null);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [menu, viewer]);

  const typingNames = useMemo(() => Object.keys(typing), [typing]);

  function announceTyping() {
    const channel = typingRef.current;
    if (!channel || !userId) return;
    channel.send({ type: "broadcast", event: "typing", payload: { userId, name: myName } });
  }

  function openConversation(conversation: Conversation) {
    if (selected) drafts.current.set(selected.id, body);
    if (conversation.id === selected?.id) return;
    setBody(drafts.current.get(conversation.id) ?? "");
    clearStaged();
    setMenu(null);
    setSelected(conversation);
    setAiAnalysis(null);
  }

  async function deliver(conversationId: string, text: string, files: File[], localId: string) {
    const formData = new FormData();
    formData.set("conversationId", conversationId);
    formData.set("body", text);
    for (const file of files) formData.append("files", file);
    try {
      const response = await fetch("/api/messages", { method: "POST", body: formData });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Unable to send message.");
      const confirmed = result.message as Message;
      setMessages((current) => {
        // Realtime may have already delivered the server row; drop that copy so
        // the placeholder is replaced exactly once.
        const withoutDuplicate = current.filter((item) => item.id === localId || item.id !== confirmed.id);
        return withoutDuplicate.map((item) => (item.id === localId ? { ...confirmed, pending: false, failed: false } : item));
      });
      failedSends.current.delete(localId);
    } catch (error) {
      failedSends.current.set(localId, { body: text, files });
      setMessages((current) => current.map((item) => (item.id === localId ? { ...item, pending: false, failed: true } : item)));
      announce(error instanceof Error ? error.message : "Unable to send message.");
    }
  }

  function buildPlaceholder(conversationId: string, text: string, files: StagedFile[]): { localId: string; placeholder: Message } {
    localSeq.current += 1;
    const localId = localMessageId(localSeq.current);
    return {
      localId,
      placeholder: {
        id: localId,
        conversation_id: conversationId,
        sender_id: userId,
        body: text,
        created_at: stamp(),
        edited_at: null,
        profiles: { full_name: myName },
        message_attachments: files.map((entry) => ({
          id: `${localId}-${entry.key}`,
          file_name: entry.file.name,
          content_type: entry.file.type,
          file_size: entry.file.size,
          blob_url: entry.preview ?? undefined,
        })),
        message_reactions: [],
        pending: true,
      },
    };
  }

  function enqueue(message: Message) {
    stickToBottom.current = true;
    setShowJump(false);
    setMessages((current) => [...current, message]);
  }

  function send(event: FormEvent) {
    event.preventDefault();
    submit();
  }

  /** Appends the message locally first, so the sender never waits on storage or notifications. */
  function submit() {
    if (!selected) return;
    const text = body.trim();
    if (!text && staged.length === 0) return;
    const files = staged.map((entry) => entry.file);
    const { localId, placeholder } = buildPlaceholder(selected.id, text, staged);
    setBody("");
    drafts.current.delete(selected.id);
    setStaged([]);
    enqueue(placeholder);
    deliver(selected.id, text, files, localId);
  }

  function retry(localId: string) {
    const original = failedSends.current.get(localId);
    if (!original || !selected) return;
    failedSends.current.delete(localId);
    const files = original.files;
    setMessages((current) =>
      current.map((item) =>
        item.id === localId
          ? {
              ...item,
              failed: false,
              pending: true,
              message_attachments: files.map((file, index) => ({
                id: `${localId}-${index}`,
                file_name: file.name,
                content_type: file.type,
                file_size: file.size,
                blob_url: isImageType(file.type) ? URL.createObjectURL(file) : undefined,
              })),
            }
          : item,
      ),
    );
    deliver(selected.id, original.body, files, localId);
  }

  async function loadOlder() {
    if (!selected || loadingOlder) return;
    setLoadingOlder(true);
    const list = listRef.current;
    const heightBefore = list?.scrollHeight ?? 0;
    const topBefore = list?.scrollTop ?? 0;
    const response = await fetch(`/api/messages?conversationId=${selected.id}&limit=${PAGE_SIZE}&offset=${messages.filter((item) => !item.pending).length}`);
    if (response.ok) {
      const result = await response.json();
      const older = ((result.messages ?? []) as Message[]).filter((item) => !messages.some((existing) => existing.id === item.id));
      setMessages((current) => [...older, ...current.filter((item) => !older.some((row) => row.id === item.id))]);
      requestAnimationFrame(() => {
        const node = listRef.current;
        if (node) {
          node.scrollTop = node.scrollHeight - heightBefore + topBefore;
        }
      });
    }
    setLoadingOlder(false);
  }

  async function saveEdit(messageId: string) {
    if (!editingBody.trim()) return;
    const response = await fetch(`/api/messages/${messageId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: editingBody }),
    });
    const result = await response.json();
    if (!response.ok) {
      announce(result.error ?? "Unable to edit the message.");
      return;
    }
    setMessages((current) => current.map((item) => (item.id === messageId ? { ...item, ...result.message } : item)));
    setEditingId(null);
  }

  async function toggleReaction(messageId: string, emoji: string) {
    const existing = messages.find((item) => item.id === messageId)?.message_reactions ?? [];
    const mine = existing.some((reaction) => reaction.emoji === emoji && reaction.user_id === userId);
    const response = await fetch(`/api/messages/${messageId}/reactions`, {
      method: mine ? "DELETE" : "POST",
      headers: { "Content-Type": "application/json" },
      body: mine ? undefined : JSON.stringify({ emoji }),
    });
    if (!response.ok && !mine) return;
    setMessages((current) =>
      current.map((item) => {
        if (item.id !== messageId) return item;
        const kept = item.message_reactions.filter((reaction) => !(reaction.emoji === emoji && reaction.user_id === userId));
        return { ...item, message_reactions: mine ? kept : [...kept, { user_id: userId, emoji }] };
      }),
    );
  }

  function openMenuAt(x: number, y: number, message: Message) {
    if (message.pending || message.failed) return;
    const padded = 12;
    setMenu({
      messageId: message.id,
      x: Math.max(padded, Math.min(x, window.innerWidth - MENU_WIDTH - padded)),
      y: Math.max(padded, Math.min(y, window.innerHeight - MENU_HEIGHT - padded)),
    });
  }

  function startLongPress(event: ReactTouchEvent<HTMLDivElement>, message: Message) {
    const touch = event.touches[0];
    if (!touch) return;
    window.clearTimeout(longPressTimer.current);
    longPressTimer.current = window.setTimeout(() => openMenuAt(touch.clientX - 20, touch.clientY - 20, message), 450);
  }

  function cancelLongPress() {
    window.clearTimeout(longPressTimer.current);
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMenu(null);
    } catch {
      announce("Your browser blocked copying to the clipboard.");
    }
  }

  async function openAttachment(attachmentId: string) {
    const response = await fetch(`/api/attachments/${attachmentId}`);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      announce(result.error ?? "Unable to open that attachment.");
      return;
    }
    window.open(result.url, "_blank", "noopener,noreferrer");
  }

  function clearStaged() {
    setStaged((current) => {
      for (const entry of current) {
        if (entry.preview) {
          URL.revokeObjectURL(entry.preview);
          blobUrls.current.delete(entry.preview);
        }
      }
      return [];
    });
  }

  function acceptFiles(incoming: File[]) {
    if (incoming.length === 0) return;
    const rejected: string[] = [];
    const usable = incoming.filter((file) => {
      if (file.size > MAX_FILE_BYTES) {
        rejected.push(`${file.name} is over 25 MB.`);
        return false;
      }
      if (!SUPPORTED_TYPES.has(file.type)) {
        rejected.push(`${file.name || "That file"} is not a supported file type.`);
        return false;
      }
      return true;
    });
    if (rejected.length > 0) announce(rejected.join(" "));
    if (usable.length === 0) return;
    setStaged((current) => {
      const next = [...current];
      for (const file of usable) {
        if (next.length >= MAX_FILES) {
          announce(`Attach at most ${MAX_FILES} files per message.`);
          break;
        }
        if (next.some((entry) => entry.file.name === file.name && entry.file.size === file.size)) continue;
        const preview = isImageType(file.type) ? URL.createObjectURL(file) : null;
        if (preview) blobUrls.current.add(preview);
        localSeq.current += 1;
        next.push({ key: `s${localSeq.current}`, file, preview });
      }
      return next;
    });
  }

  function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    acceptFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  function pasteFiles(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length > 0) {
      event.preventDefault();
      acceptFiles(files);
    }
  }

  function removeStaged(key: string) {
    setStaged((current) => {
      const target = current.find((entry) => entry.key === key);
      if (target?.preview) {
        URL.revokeObjectURL(target.preview);
        blobUrls.current.delete(target.preview);
      }
      return current.filter((entry) => entry.key !== key);
    });
  }

  function handleDragEnter(event: DragEvent) {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    dragDepth.current += 1;
    setDragging(true);
  }

  function handleDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    acceptFiles(Array.from(event.dataTransfer?.files ?? []));
  }

  async function createConversation(event: FormEvent) {
    event.preventDefault();
    if (!teamId || !newConversationTitle.trim()) return;
    const response = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamId, title: newConversationTitle, isGroup: true }),
    });
    const result = await response.json();
    if (!response.ok) {
      announce(result.error ?? "Unable to create conversation.");
      return;
    }
    setConversations((current) => [result.conversation, ...current]);
    setNewConversationTitle("");
    setShowNewConversation(false);
    setSelected({ ...result.conversation, conversation_members: [{ user_id: userId, last_read_at: null }], messages: [] });
  }

  async function markConversationRead(conversationId: string) {
    await markRead(conversationId);
  }

  async function markAllRead() {
    const unreadIds = conversations.filter((conversation) => unread[conversation.id]).map((conversation) => conversation.id);
    if (unreadIds.length === 0) return;
    await Promise.all(unreadIds.map((id) => markRead(id)));
  }

  async function addMember(memberId: string) {
    if (!selected) return;
    const response = await fetch(`/api/conversations/${selected.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: memberId }),
    });
    const result = await response.json();
    if (!response.ok) {
      announce(result.error ?? "Unable to add that member.");
      return;
    }
    const refreshed = await fetch(`/api/conversations/${selected.id}/members`);
    if (refreshed.ok) setMembers((await refreshed.json()).members ?? []);
  }

  async function removeMember(memberId: string) {
    if (!selected) return;
    const response = await fetch(`/api/conversations/${selected.id}/members?userId=${memberId}`, { method: "DELETE" });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      announce(result.error ?? "Unable to remove that member.");
      return;
    }
    setMembers((current) => current.filter((member) => member.user_id !== memberId));
  }

  const memberIds = new Set(members.map((member) => member.user_id));
  const addable = teamMembers.filter((member) => !memberIds.has(member.user_id));
  const menuMessage = menu ? messages.find((item) => item.id === menu.messageId) ?? null : null;
  const unreadCount = conversations.filter((conversation) => unread[conversation.id]).length;
  const canSend = !!selected && (body.trim().length > 0 || staged.length > 0);

  return (
    <WorkspaceShell active="" dense>
      <section className="chat-layout">
        <aside className="conversation-list">
          <div className="chat-list-heading">
            <h1>Conversations</h1>
            <div className="chat-list-actions">
              {unreadCount > 0 && (
                <button className="chat-mark-all" onClick={markAllRead} title="Mark every conversation as read">
                  Mark all read
                </button>
              )}
              <button aria-label="New conversation" onClick={() => setShowNewConversation((current) => !current)}>
                +
              </button>
            </div>
          </div>
          {showNewConversation && (
            <form className="new-conversation-form" onSubmit={createConversation}>
              <input
                value={newConversationTitle}
                onChange={(event) => setNewConversationTitle(event.target.value)}
                placeholder="Conversation name"
                autoFocus
              />
              <button disabled={!newConversationTitle.trim()}>Create</button>
            </form>
          )}
          {conversations.length === 0 ? (
            <div className="chat-empty-state">
              <span>□</span>
              <strong>No conversations yet</strong>
              <p>Create a conversation to get started.</p>
            </div>
          ) : (
            conversations.map((conversation) => (
              <div key={conversation.id} className={`conversation-item ${selected?.id === conversation.id ? "selected" : ""}`}>
                <button className="conversation-open" onClick={() => openConversation(conversation)}>
                  <span className="conversation-mark">{(conversation.title ?? "C").slice(0, 1)}</span>
                  <span className="conversation-text">
                    <strong>{conversation.title ?? "Untitled conversation"}</strong>
                    <small>
                      {conversation.messages?.[0]
                        ? `${conversation.messages[0].body.slice(0, 34)}${conversation.messages[0].body.length > 34 ? "…" : ""}`
                        : "No messages yet"}
                    </small>
                  </span>
                </button>
                {unread[conversation.id] ? (
                  <button
                    className="conversation-unread"
                    title="Mark as read"
                    aria-label={`Mark ${conversation.title ?? "conversation"} as read`}
                    onClick={() => markConversationRead(conversation.id)}
                  >
                    <i />
                  </button>
                ) : (
                  <span className="conversation-read" aria-hidden="true" />
                )}
              </div>
            ))
          )}
        </aside>

        <section
          className="chat-window"
          onDragOver={(event) => event.preventDefault()}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {dragging && <div className="drop-hint">Drop files to attach them</div>}
          {selected ? (
            <>
              <div className="chat-window-heading">
                <div>
                  <h2>{selected.title ?? "Team conversation"}</h2>
                  <p>Only members of this conversation can read or send messages.</p>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="online-dot">● Live</span>
                  <button className="chat-back" onClick={analyzeConversation} disabled={aiBusy} title="Summarize this conversation with AI">
                    {aiBusy ? "Analyzing..." : "AI summary"}
                  </button>
                  <button className="chat-back" aria-label="Conversation members" onClick={() => setShowMembers((current) => !current)}>
                    ☰
                  </button>
                </div>
              </div>

              {aiAnalysis && (
                <div className="ai-project-insight" style={{ margin: "12px 16px 0" }}>
                  <div className="ai-project-insight-head">
                    <div>
                      <strong>Conversation summary</strong>
                      <p>Review-only analysis based on the messages currently available.</p>
                    </div>
                    <button className="chat-back" onClick={() => setAiAnalysis(null)}>Hide</button>
                  </div>
                  <div className="ai-project-insight-body">
                    {aiAnalysis.summary && <p>{aiAnalysis.summary}</p>}
                    {aiAnalysis.decisions && aiAnalysis.decisions.length > 0 && <div><strong>Decisions</strong><ul>{aiAnalysis.decisions.map((item) => <li key={item}>{item}</li>)}</ul></div>}
                    {aiAnalysis.actionItems && aiAnalysis.actionItems.length > 0 && <div><strong>Suggested action items</strong><ul>{aiAnalysis.actionItems.map((item) => <li key={item.title}><b>{item.title}</b> — {item.reason}</li>)}</ul></div>}
                    {aiAnalysis.questions && aiAnalysis.questions.length > 0 && <div><strong>Needs clarification</strong><ul>{aiAnalysis.questions.map((item) => <li key={item}>{item}</li>)}</ul></div>}
                  </div>
                </div>
              )}

              {showMembers && (
                <div style={{ padding: "10px 16px", borderBottom: "1px solid #ffffff12", background: "#0a0b20" }}>
                  <p className="overline">MEMBERS ({members.length})</p>
                  {members.map((member) => (
                    <div className="toggle-row" key={member.user_id}>
                      <div>
                        <strong>{member.profiles?.full_name ?? "Member"}</strong>
                        <p>{member.user_id === userId ? "You" : "Conversation member"}</p>
                      </div>
                      {selected.created_by === userId && member.user_id !== userId && (
                        <button className="chat-back" onClick={() => removeMember(member.user_id)} aria-label="Remove member">
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                  {selected.created_by === userId && addable.length > 0 && (
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <select
                        aria-label="Add member"
                        onChange={(event) => event.target.value && addMember(event.target.value)}
                        defaultValue=""
                        style={{ flex: 1, padding: 8, background: "#0c0d23", color: "#fff", border: "1px solid #ffffff18", borderRadius: 6 }}
                      >
                        <option value="" disabled>
                          Add a team member...
                        </option>
                        {addable.map((member) => (
                          <option key={member.user_id} value={member.user_id}>
                            {member.profiles?.full_name ?? member.user_id.slice(0, 8)}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}

              <div className="message-list" ref={listRef} onScroll={() => {
                const list = listRef.current;
                if (!list) return;
                stickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_BOTTOM_PX;
                if (stickToBottom.current) setShowJump(false);
              }}>
                {messages.length < total && (
                  <button className="chat-back" onClick={loadOlder} disabled={loadingOlder} style={{ alignSelf: "center", marginBottom: 10 }}>
                    {loadingOlder ? "Loading..." : `Load older (${Math.max(0, total - messages.length)} more)`}
                  </button>
                )}
                {messages.length === 0 ? (
                  <p className="chat-empty">No messages yet. Start the conversation.</p>
                ) : (
                  messages.map((item, index) => {
                    const mine = item.sender_id === userId;
                    const previous = index === 0 ? undefined : messages[index - 1];
                    const showDay = !previous || new Date(previous.created_at).toDateString() !== new Date(item.created_at).toDateString();
                    const images = (item.message_attachments ?? []).filter((file) => isImageType(file.content_type) && !brokenImages[file.id]);
                    const docs = (item.message_attachments ?? []).filter((file) => !images.includes(file));
                    return (
                      <div className="message-row" key={item.id}>
                        {showDay && <div className="day-divider">{dayLabel(item.created_at)}</div>}
                        <div
                          className={`message-bubble ${mine ? "mine" : ""} ${item.pending ? "pending" : ""} ${item.failed ? "failed" : ""}`}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            cancelLongPress();
                            openMenuAt(event.clientX, event.clientY, item);
                          }}
                          onTouchStart={(event) => startLongPress(event, item)}
                          onTouchEnd={cancelLongPress}
                          onTouchMove={cancelLongPress}
                          onTouchCancel={cancelLongPress}
                        >
                          {!mine && <small className="message-sender">{item.profiles?.full_name ?? "Teammate"}</small>}
                          {editingId === item.id ? (
                            <form
                              onSubmit={(event) => {
                                event.preventDefault();
                                saveEdit(item.id);
                              }}
                              style={{ display: "flex", gap: 6 }}
                            >
                              <input
                                value={editingBody}
                                onChange={(event) => setEditingBody(event.target.value)}
                                aria-label="Edit message"
                                style={{ flex: 1 }}
                                autoFocus
                              />
                              <button type="submit">Save</button>
                              <button type="button" onClick={() => setEditingId(null)}>
                                Cancel
                              </button>
                            </form>
                          ) : (
                            <p>
                              {item.body}
                              {item.edited_at && <em className="message-edited"> (edited)</em>}
                            </p>
                          )}
                          {(images.length > 0 || docs.length > 0) && (
                            <div className="chat-media">
                              {images.map((file) => (
                                <button
                                  key={file.id}
                                  className="chat-image"
                                  title={file.file_name}
                                  onClick={() => setViewer({ src: attachmentSrc(file), name: file.file_name })}
                                >
                                  <img
                                    src={attachmentSrc(file)}
                                    alt={file.file_name}
                                    loading="lazy"
                                    onError={() => setBrokenImages((current) => ({ ...current, [file.id]: true }))}
                                  />
                                </button>
                              ))}
                              {docs.map((file) => (
                                <button
                                  key={file.id}
                                  className="chat-file-card"
                                  onClick={() =>
                                    file.blob_url ? window.open(file.blob_url, "_blank", "noopener,noreferrer") : openAttachment(file.id)
                                  }
                                >
                                  <span className="chat-file-ext">{typeBadge(file.content_type, file.file_name)}</span>
                                  <span className="chat-file-meta">
                                    <strong>{file.file_name}</strong>
                                    <small>{formatBytes(file.file_size)}</small>
                                  </span>
                                </button>
                              ))}
                            </div>
                          )}
                          <div className="message-foot">
                            <small>
                              {item.pending ? "Sending…" : item.failed ? "Not sent" : formatClock(item.created_at)}
                            </small>
                            {item.failed && (
                              <button className="message-retry" onClick={() => retry(item.id)}>
                                Retry
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
                {typingNames.length > 0 && <p className="chat-empty">{typingNames.join(", ")} is typing…</p>}
              </div>

              {showJump && (
                <button className="jump-to-latest" onClick={() => {
                  const list = listRef.current;
                  if (list) list.scrollTop = list.scrollHeight;
                  stickToBottom.current = true;
                  setShowJump(false);
                }}>
                  Newest messages ↓
                </button>
              )}

              {staged.length > 0 && (
                <div className="composer-files">
                  {staged.map((entry) => (
                    <span className="composer-file" key={entry.key}>
                      {entry.preview ? (
                        <img src={entry.preview} alt="" />
                      ) : (
                        <span className="chat-file-ext">{typeBadge(entry.file.type, entry.file.name)}</span>
                      )}
                      <small>{entry.file.name}</small>
                      <button onClick={() => removeStaged(entry.key)} aria-label={`Remove ${entry.file.name}`}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <form className="message-composer" onSubmit={send}>
                <label className="chat-attach" title="Attach files" aria-label="Attach files">
                  <svg
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M21.44 11.05 12.25 20.24a5.5 5.5 0 0 1-7.78-7.78l8.49-8.49a3.5 3.5 0 0 1 4.95 4.95l-8.49 8.49a1.5 1.5 0 0 1-2.12-2.12l7.78-7.78" />
                  </svg>
                  <input type="file" multiple accept={UPLOAD_ACCEPT} onChange={chooseFiles} hidden />
                </label>
                <textarea
                  rows={1}
                  value={body}
                  onChange={(event) => {
                    setBody(event.target.value);
                    announceTyping();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                  onPaste={pasteFiles}
                  placeholder="Write a message…  Enter to send, Shift+Enter for a new line"
                  aria-label="Message"
                />
                <button disabled={!canSend}>Send</button>
              </form>
            </>
          ) : (
            <div className="chat-empty chat-empty-large">
              <span className="chat-hero-mark">C</span>
              <strong>Select a conversation</strong>
              <p>Choose a conversation or start a new one.</p>
            </div>
          )}
          {notice && <p className="chat-error" role="status">{notice}</p>}
        </section>
      </section>

      {menuMessage && menu &&
        createPortal(
          <div className="message-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
            <button role="menuitem" onClick={() => copyText(menuMessage.body)}>
              Copy text
            </button>
            <div className="message-menu-reactions" aria-label="Add a reaction">
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => {
                    toggleReaction(menuMessage.id, emoji);
                    setMenu(null);
                  }}
                  aria-label={`Add ${emoji} reaction`}
                >
                  {emoji}
                </button>
              ))}
            </div>
            {menuMessage.sender_id === userId && (
              <>
                <button
                  role="menuitem"
                  onClick={() => {
                    setEditingId(menuMessage.id);
                    setEditingBody(menuMessage.body);
                    setMenu(null);
                  }}
                >
                  Edit message
                </button>
              </>
            )}
          </div>,
          document.body,
        )}

      {viewer &&
        createPortal(
          <div className="image-viewer" role="dialog" aria-label={viewer.name} onClick={() => setViewer(null)}>
            <img src={viewer.src} alt={viewer.name} onClick={(event) => event.stopPropagation()} />
            <div className="image-viewer-bar" onClick={(event) => event.stopPropagation()}>
              <span>{viewer.name}</span>
              <button onClick={() => setViewer(null)}>Close</button>
            </div>
          </div>,
          document.body,
        )}
    </WorkspaceShell>
  );
}
