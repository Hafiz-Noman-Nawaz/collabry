"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { WorkspaceShell } from "@/components/WorkspaceShell";
import { createClient } from "@/lib/supabase/browser";
import { formatBytes } from "@/lib/format";

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

type Message = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  edited_at: string | null;
  profiles: { full_name: string } | null;
  message_attachments: Array<{ id: string; file_name: string; content_type: string; file_size: number }>;
  message_reactions: Array<{ user_id: string; emoji: string }>;
};

type Member = { user_id: string; joined_at?: string; last_read_at?: string | null; profiles: { full_name: string } | null };

type Channel = ReturnType<ReturnType<typeof createClient>["channel"]>;

const PAGE_SIZE = 30;
const QUICK_REACTIONS = ["👍", "🎉", "❤️", "👀"];

export default function MessagesPage() {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [body, setBody] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [userId, setUserId] = useState("");
  const [message, setMessage] = useState("");
  const [teamId, setTeamId] = useState("");
  const [showNewConversation, setShowNewConversation] = useState(false);
  const [newConversationTitle, setNewConversationTitle] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [teamMembers, setTeamMembers] = useState<Array<{ user_id: string; profiles: { full_name: string } | null }>>([]);
  const [showMembers, setShowMembers] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState("");
  const [typing, setTyping] = useState<Record<string, number>>({});
  const [unread, setUnread] = useState<Record<string, boolean>>({});
  const typingRef = useRef<Channel | null>(null);
  const typingTimers = useRef<Record<string, number>>({});

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
        if (active) setMessage(result.error ?? "Unable to load conversations.");
        return;
      }
      const result = await response.json();
      if (!active) return;
      const loaded: Conversation[] = result.conversations ?? [];
      setConversations(loaded);
      const flags: Record<string, boolean> = {};
      for (const conversation of loaded) {
        const mine = conversation.conversation_members?.find((row) => row.user_id === data.user?.id);
        const latest = conversation.messages?.[0]?.created_at;
        flags[conversation.id] = !!latest && (!mine?.last_read_at || new Date(mine.last_read_at) < new Date(latest));
      }
      setUnread(flags);
      if (loaded[0]) setSelected(loaded[0]);
      const memberResponse = await fetch(`/api/members?teamId=${firstTeamId}`);
      if (memberResponse.ok && active) setTeamMembers((await memberResponse.json()).members ?? []);
    }
    load();
    return () => {
      active = false;
    };
  }, [router]);

  useEffect(() => {
    if (!selected) return;
    const conversationId = selected.id;
    const supabase = createClient();
    let active = true;
    let channel: ReturnType<typeof supabase.channel> | undefined;

    async function loadMessages() {
      setMessages([]);
      const response = await fetch(`/api/messages?conversationId=${conversationId}&limit=${PAGE_SIZE}&offset=0`);
      if (!response.ok || !active) return;
      const result = await response.json();
      if (!active) return;
      setMessages(result.messages ?? []);
      setTotal(result.total ?? 0);
      // Delivery marker so the unread dot clears after opening a conversation.
      await fetch("/api/messages", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId }) });
      setUnread((current) => ({ ...current, [conversationId]: false }));

      const membersResponse = await fetch(`/api/conversations/${conversationId}/members`);
      if (membersResponse.ok && active) setMembers((await membersResponse.json()).members ?? []);

      channel = supabase
        .channel(`conversation:${conversationId}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${conversationId}` }, (event) => {
          setMessages((current) => (current.some((item) => item.id === event.new.id) ? current : [...current, event.new as unknown as Message]));
          setTotal((current) => current + 1);
        })
        .subscribe();
    }

    loadMessages();
    return () => {
      active = false;
      if (channel) supabase.removeChannel(channel);
    };
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    const conversationId = selected.id;
    const supabase = createClient();
    const channel = supabase.channel(`typing:${conversationId}`);
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

  const typingNames = useMemo(() => Object.keys(typing), [typing]);

  function announceTyping() {
    const channel = typingRef.current;
    if (!channel || !userId) return;
    channel.send({ type: "broadcast", event: "typing", payload: { userId, name: "Someone" } });
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!selected || (!body.trim() && !attachment)) return;
    const formData = new FormData();
    formData.set("conversationId", selected.id);
    formData.set("body", body);
    if (attachment) formData.set("file", attachment);
    const response = await fetch("/api/messages", { method: "POST", body: formData });
    const result = await response.json();
    if (!response.ok) {
      setMessage(result.error ?? "Unable to send message.");
      return;
    }
    setMessages((current) => (current.some((item) => item.id === result.message.id) ? current : [...current, result.message]));
    setTotal((current) => current + 1);
    setBody("");
    setAttachment(null);
  }

  async function loadOlder() {
    if (!selected || loadingOlder) return;
    setLoadingOlder(true);
    const response = await fetch(`/api/messages?conversationId=${selected.id}&limit=${PAGE_SIZE}&offset=${messages.length}`);
    if (response.ok) {
      const result = await response.json();
      const older = (result.messages as Message[]).filter((item) => !messages.some((existing) => existing.id === item.id));
      setMessages((current) => [...older, ...current]);
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
      setMessage(result.error ?? "Unable to edit the message.");
      return;
    }
    setMessages((current) => current.map((item) => (item.id === messageId ? { ...item, ...result.message } : item)));
    setEditingId(null);
  }

  async function removeMessage(messageId: string) {
    if (!window.confirm("Delete this message?")) return;
    const response = await fetch(`/api/messages/${messageId}`, { method: "DELETE" });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      setMessage(result.error ?? "Unable to delete the message.");
      return;
    }
    setMessages((current) => current.filter((item) => item.id !== messageId));
    setTotal((current) => Math.max(0, current - 1));
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
      setMessage(result.error ?? "Unable to create conversation.");
      return;
    }
    setConversations((current) => [result.conversation, ...current]);
    setSelected({ ...result.conversation, conversation_members: [], messages: [] });
    setNewConversationTitle("");
    setShowNewConversation(false);
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
      setMessage(result.error ?? "Unable to add that member.");
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
      setMessage(result.error ?? "Unable to remove that member.");
      return;
    }
    setMembers((current) => current.filter((member) => member.user_id !== memberId));
  }

  async function openAttachment(attachmentId: string) {
    const response = await fetch(`/api/attachments/${attachmentId}`);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      setMessage(result.error ?? "Unable to open that attachment.");
      return;
    }
    window.open(result.url, "_blank", "noopener,noreferrer");
  }

  function chooseAttachment(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (file && file.size > 25 * 1024 * 1024) {
      setMessage("Attachments must be smaller than 25 MB.");
      event.target.value = "";
      return;
    }
    setAttachment(file);
  }

  const memberIds = new Set(members.map((member) => member.user_id));
  const addable = teamMembers.filter((member) => !memberIds.has(member.user_id));

  return (
    <WorkspaceShell active="" dense>
      <section className="chat-layout">
        <aside className="conversation-list">
          <div className="chat-list-heading">
            <h1>Conversations</h1>
            <button aria-label="New conversation" onClick={() => setShowNewConversation((current) => !current)}>+</button>
          </div>
          {showNewConversation && (
            <form className="new-conversation-form" onSubmit={createConversation}>
              <input value={newConversationTitle} onChange={(event) => setNewConversationTitle(event.target.value)} placeholder="Conversation name" autoFocus />
              <button disabled={!newConversationTitle.trim()}>Create</button>
            </form>
          )}
          {conversations.length === 0 ? (
            <div className="chat-empty-state"><span>□</span><strong>No conversations yet</strong><p>Create a conversation to get started.</p></div>
          ) : (
            conversations.map((conversation) => (
              <button
                key={conversation.id}
                className={`conversation-item ${selected?.id === conversation.id ? "selected" : ""}`}
                onClick={() => setSelected(conversation)}
              >
                <span className="conversation-mark">{(conversation.title ?? "C").slice(0, 1)}</span>
                <span>
                  {conversation.title ?? "Untitled conversation"}
                  <small>
                    {conversation.messages?.[0]
                      ? `${conversation.messages[0].body.slice(0, 34)}${conversation.messages[0].body.length > 34 ? "…" : ""}`
                      : "No messages yet"}
                  </small>
                </span>
                {unread[conversation.id] && <i style={{ width: 6, height: 6, borderRadius: "50%", background: "#31d9ed", marginLeft: "auto" }} aria-label="unread" />}
              </button>
            ))
          )}
        </aside>

        <section className="chat-window">
          {selected ? (
            <>
              <div className="chat-window-heading">
                <div>
                  <h2>{selected.title ?? "Team conversation"}</h2>
                  <p>Only members of this conversation can read or send messages.</p>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="online-dot">● Live</span>
                  <button className="chat-back" aria-label="Conversation members" onClick={() => setShowMembers((current) => !current)}>☰</button>
                </div>
              </div>

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
                        <button className="chat-back" onClick={() => removeMember(member.user_id)} aria-label="Remove member">×</button>
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
                        <option value="" disabled>Add a team member...</option>
                        {addable.map((member) => (
                          <option key={member.user_id} value={member.user_id}>{member.profiles?.full_name ?? member.user_id.slice(0, 8)}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}

              <div className="message-list">
                {messages.length < total && (
                  <button className="chat-back" onClick={loadOlder} disabled={loadingOlder} style={{ alignSelf: "center", marginBottom: 10 }}>
                    {loadingOlder ? "Loading..." : `Load older (${total - messages.length} more)`}
                  </button>
                )}
                {messages.length === 0 ? (
                  <p className="chat-empty">No messages yet. Start the conversation.</p>
                ) : (
                  messages.map((item) => {
                    const mine = item.sender_id === userId;
                    const grouped = new Map<string, string[]>();
                    for (const reaction of item.message_reactions ?? []) {
                      const bucket = grouped.get(reaction.emoji) ?? [];
                      bucket.push(reaction.user_id);
                      grouped.set(reaction.emoji, bucket);
                    }
                    return (
                      <div className={`message-bubble ${mine ? "mine" : ""}`} key={item.id}>
                        {!mine && <small style={{ color: "#a7a5c5" }}>{item.profiles?.full_name ?? "Teammate"}</small>}
                        {editingId === item.id ? (
                          <form onSubmit={(event) => { event.preventDefault(); saveEdit(item.id); }} style={{ display: "flex", gap: 6 }}>
                            <input value={editingBody} onChange={(event) => setEditingBody(event.target.value)} aria-label="Edit message" style={{ flex: 1 }} autoFocus />
                            <button type="submit">Save</button>
                            <button type="button" onClick={() => setEditingId(null)}>Cancel</button>
                          </form>
                        ) : (
                          <p>
                            {item.body}
                            {item.edited_at && <em style={{ opacity: 0.6, fontStyle: "normal", fontSize: 8 }}> (edited)</em>}
                          </p>
                        )}
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                          <small>{new Date(item.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small>
                          {Array.from(grouped.entries()).map(([emoji, users]) => (
                            <button
                              key={emoji}
                              onClick={() => toggleReaction(item.id, emoji)}
                              style={{
                                padding: "2px 6px",
                                borderRadius: 10,
                                border: users.includes(userId) ? "1px solid #9c69f5" : "1px solid #ffffff20",
                                background: users.includes(userId) ? "#9c69f522" : "#ffffff0d",
                                fontSize: 10,
                                cursor: "pointer",
                              }}
                              aria-label={`React ${emoji}`}
                            >
                              {emoji} {users.length}
                            </button>
                          ))}
                          {mine && editingId !== item.id && (
                            <>
                              <button
                                onClick={() => { setEditingId(item.id); setEditingBody(item.body); }}
                                style={{ border: 0, background: "transparent", color: "#9a98b8", fontSize: 9, cursor: "pointer" }}
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => removeMessage(item.id)}
                                style={{ border: 0, background: "transparent", color: "#ff9d8a", fontSize: 9, cursor: "pointer" }}
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                        {(item.message_attachments ?? []).length > 0 && (
                          <div style={{ display: "grid", gap: 5, marginTop: 6 }}>
                            {item.message_attachments.map((file) => (
                              <button
                                key={file.id}
                                onClick={() => openAttachment(file.id)}
                                style={{ border: 0, background: "transparent", color: "#7ce5ea", fontSize: 9, cursor: "pointer", textAlign: "left", padding: 0 }}
                              >
                                {file.file_name} · {formatBytes(file.file_size)}
                              </button>
                            ))}
                          </div>
                        )}
                        <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                          {QUICK_REACTIONS.map((emoji) => (
                            <button
                              key={emoji}
                              onClick={() => toggleReaction(item.id, emoji)}
                              style={{ border: 0, background: "transparent", fontSize: 11, cursor: "pointer", opacity: 0.7 }}
                              aria-label={`Add ${emoji} reaction`}
                            >
                              {emoji}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })
                )}
                {typingNames.length > 0 && <p className="chat-empty">{typingNames.join(", ")} is typing…</p>}
              </div>

              <form className="message-composer" onSubmit={send}>
                <label className="chat-attach" title="Attach a file" aria-label="Attach a file">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21.44 11.05 12.25 20.24a5.5 5.5 0 0 1-7.78-7.78l8.49-8.49a3.5 3.5 0 0 1 4.95 4.95l-8.49 8.49a1.5 1.5 0 0 1-2.12-2.12l7.78-7.78" />
                  </svg>
                  <input type="file" accept="application/pdf,text/plain,image/*,.zip,.docx" onChange={chooseAttachment} hidden />
                </label>
                <input value={body} onChange={(event) => { setBody(event.target.value); announceTyping(); }} placeholder="Write a message..." aria-label="Message" />
                <button disabled={!body.trim() && !attachment}>{attachment ? `Send ${attachment.name.slice(0, 12)}…` : "Send"}</button>
              </form>
              {attachment && (
                <p className="chat-error" style={{ margin: 0 }}>
                  Attached: {attachment.name} ({formatBytes(attachment.size)})
                  <button onClick={() => setAttachment(null)} style={{ marginLeft: 10, border: 0, background: "transparent", color: "#ff9d8a", cursor: "pointer" }}>remove</button>
                </p>
              )}
            </>
          ) : (
            <div className="chat-empty chat-empty-large">
              <span className="chat-hero-mark">C</span>
              <strong>Select a conversation</strong>
              <p>Choose a conversation or start a new one.</p>
            </div>
          )}
          {message && <p className="chat-error" role="status">{message}</p>}
        </section>
      </section>
    </WorkspaceShell>
  );
}
