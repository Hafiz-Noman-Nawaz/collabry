import { createAdminClient } from "@/lib/supabase/admin";

export type AuditEntry = {
  actorId?: string | null;
  teamId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Writes an append-only audit entry with the service-role client because
 * audit_logs deliberately has no insert policy. Never throws: auditing must not
 * break the mutation it records.
 */
export async function recordAudit(entry: AuditEntry) {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("audit_logs").insert({
      actor_id: entry.actorId ?? null,
      team_id: entry.teamId ?? null,
      action: entry.action,
      resource_type: entry.resourceType,
      resource_id: entry.resourceId ?? null,
      metadata: entry.metadata ?? {},
    });
    if (error) console.error("[audit]", entry.action, error.message);
  } catch (error) {
    console.error("[audit]", entry.action, error instanceof Error ? error.message : error);
  }
}
