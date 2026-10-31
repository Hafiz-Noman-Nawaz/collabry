"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { WorkspaceShell } from "@/components/WorkspaceShell";
import { createClient } from "@/lib/supabase/browser";

type Team = { id: string; name: string };
type Member = { user_id: string; role: string; joined_at: string; profiles: { full_name: string; university: string | null } | null };
type Invitation = { id: string; invitee_email: string; role: string; status: string; expires_at: string };

const ASSIGNABLE_ROLES = ["supervisor", "leader", "member", "reviewer"];

export default function TeamPage() {
  const router = useRouter();
  const [team, setTeam] = useState<Team | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [message, setMessage] = useState("");
  const [myRole, setMyRole] = useState("");

  useEffect(() => {
    async function load() {
      const supabase = createClient();
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) {
        router.replace("/login");
        return;
      }
      const { data: teams } = await supabase.from("teams").select("id, name").order("created_at", { ascending: false }).limit(1);
      const firstTeam = teams?.[0] ?? null;
      setTeam(firstTeam);
      if (!firstTeam) return;
      const response = await fetch(`/api/members?teamId=${firstTeam.id}`);
      const result = await response.json();
      if (response.ok) {
        const loaded: Member[] = result.members ?? [];
        setMembers(loaded);
        setMyRole(loaded.find((member) => member.user_id === user.user?.id)?.role ?? "");
      } else setMessage(result.error ?? "Unable to load members.");

      const invitationResponse = await fetch(`/api/invitations?teamId=${firstTeam.id}`);
      if (invitationResponse.ok) setInvitations((await invitationResponse.json()).invitations ?? []);
    }
    load();
  }, [router]);

  const canManage = myRole === "owner" || myRole === "leader";

  async function removeMember(userId: string) {
    if (!team || !window.confirm("Remove this member from the team?")) return;
    const response = await fetch("/api/members", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ teamId: team.id, userId }) });
    const result = await response.json();
    if (!response.ok) setMessage(result.error ?? "Unable to remove member.");
    else setMembers((current) => current.filter((member) => member.user_id !== userId));
  }

  async function changeRole(userId: string, role: string) {
    if (!team) return;
    const response = await fetch("/api/members", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ teamId: team.id, userId, role }) });
    const result = await response.json();
    if (!response.ok) setMessage(result.error ?? "Unable to change that role.");
    else {
      setMembers((current) => current.map((member) => (member.user_id === userId ? { ...member, role } : member)));
      setMessage("Role updated and recorded in the audit log.");
    }
  }

  return (
    <WorkspaceShell active="Team">
      <section className="team-layout">
        <div className="files-heading">
          <div>
            <p className="overline">{team?.name ?? "PROJECT WORKSPACE"}</p>
            <h1>Team members</h1>
            <p>Roles and access for this project workspace.</p>
          </div>
          <button className="new-project" onClick={() => router.push("/projects")}>Invite member</button>
        </div>
        {message && <p className="file-message" role="status">{message}</p>}

        <section className="member-list">
          {members.length === 0 ? (
            <div className="file-empty">
              <span>♙</span>
              <strong>No members loaded</strong>
              <p>Create a project and invite collaborators to build your team.</p>
            </div>
          ) : (
            members.map((member) => (
              <article className="member-row" key={member.user_id}>
                <span className="member-avatar">{(member.profiles?.full_name || "U").slice(0, 1).toUpperCase()}</span>
                <div>
                  <strong>{member.profiles?.full_name || "Unnamed member"}</strong>
                  <small>{member.profiles?.university || "Independent workspace"}</small>
                </div>
                {canManage && member.role !== "owner" ? (
                  <select
                    className="member-role"
                    value={member.role}
                    onChange={(event) => changeRole(member.user_id, event.target.value)}
                    aria-label={`Role for ${member.profiles?.full_name ?? "member"}`}
                  >
                    {ASSIGNABLE_ROLES.map((role) => (
                      <option key={role} value={role}>{role}</option>
                    ))}
                  </select>
                ) : (
                  <span className="member-role">{member.role}</span>
                )}
                {member.role !== "owner" && canManage && <button onClick={() => removeMember(member.user_id)}>Remove</button>}
              </article>
            ))
          )}
        </section>

        {invitations.length > 0 && (
          <section className="member-list" style={{ marginTop: 22 }}>
            <div className="files-heading">
              <div>
                <p className="overline">INVITATIONS</p>
                <h1 style={{ fontSize: 22 }}>Pending invitations</h1>
                <p>Links expire 72 hours after they are created.</p>
              </div>
            </div>
            {invitations.map((invitation) => (
              <article className="member-row" key={invitation.id}>
                <span className="member-avatar">{invitation.invitee_email.slice(0, 1).toUpperCase()}</span>
                <div>
                  <strong>{invitation.invitee_email}</strong>
                  <small>expires {new Date(invitation.expires_at).toLocaleString()}</small>
                </div>
                <span className="member-role">{invitation.role}</span>
                <span className={`badge ${invitation.status === "pending" ? "violet" : invitation.status === "accepted" ? "" : "muted"}`}>{invitation.status}</span>
              </article>
            ))}
          </section>
        )}
      </section>
    </WorkspaceShell>
  );
}
