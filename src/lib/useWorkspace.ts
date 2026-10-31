"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";

export type WorkspaceTeam = {
  id: string;
  name: string;
  description: string;
  category: string | null;
  university: string | null;
  department: string | null;
  start_date: string | null;
  target_date: string | null;
  created_at: string;
  storage_quota_bytes: number;
  role: string | null;
  memberCount: number;
};

/**
 * Shared workspace state for the workspace screens: verifies the session,
 * loads the caller's projects from the API and tracks the active project.
 */
export function useWorkspace() {
  const router = useRouter();
  const [teams, setTeams] = useState<WorkspaceTeam[]>([]);
  const [teamId, setTeamId] = useState<string>("");
  const [userId, setUserId] = useState<string>("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const supabase = createClient();
      const { data } = await supabase.auth.getUser();
      if (!data.user) {
        router.replace("/login");
        return;
      }
      if (!cancelled) setUserId(data.user.id);
      const response = await fetch("/api/teams?limit=50");
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        if (!cancelled) setError(result.error ?? "Unable to load projects.");
      } else {
        const result = await response.json();
        if (!cancelled) {
          setTeams(result.teams ?? []);
          setTeamId((current) => current || result.teams?.[0]?.id || "");
        }
      }
      if (!cancelled) setReady(true);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/teams?limit=50");
    if (response.ok) {
      const result = await response.json();
      setTeams(result.teams ?? []);
      setTeamId((current) => current || result.teams?.[0]?.id || "");
    }
  }, []);

  const team = teams.find((candidate) => candidate.id === teamId) ?? teams[0] ?? null;
  return { ready, teams, team, teamId: team?.id ?? "", setTeamId, userId, error, setError, refresh };
}
