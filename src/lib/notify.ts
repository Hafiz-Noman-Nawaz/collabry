import { createAdminClient } from "@/lib/supabase/admin";
import { sendInvitationEmail } from "@/lib/email";

export type NotificationKind = "invitation" | "task" | "meeting" | "message" | "announcement" | "review";

type NotificationInput = {
  userIds: string[];
  teamId?: string | null;
  kind: NotificationKind;
  title: string;
  body?: string;
  resourceType?: string;
  resourceId?: string | null;
};

/** Maps notification kinds onto the stored email preference columns. */
const EMAIL_PREF: Partial<Record<NotificationKind, string>> = {
  invitation: "email_invitations",
  meeting: "email_meetings",
  task: "email_tasks",
  announcement: "email_announcements",
};

async function allowedRecipients(userIds: string[], kind: NotificationKind) {
  const prefColumn = EMAIL_PREF[kind];
  if (!prefColumn) return userIds;
  try {
    const admin = createAdminClient();
    const { data } = await admin.from("notification_preferences").select("*").in("user_id", userIds);
    const rows = (data ?? []) as Record<string, unknown>[];
    return userIds.filter((id) => {
      const row = rows.find((candidate) => candidate.user_id === id);
      if (!row) return true; // no stored preferences yet: deliver
      return row[prefColumn] !== false;
    });
  } catch {
    return userIds;
  }
}

/**
 * Fans a notification out to team members, honouring each member's stored
 * preferences. Uses the service-role client because notifications has no insert
 * policy for authenticated users.
 */
export async function notifyTeam(input: NotificationInput) {
  const recipients = input.userIds.filter((id, index, all) => all.indexOf(id) === index);
  const allowed = await allowedRecipients(recipients, input.kind);
  if (allowed.length === 0) return 0;
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("notifications").insert(
      allowed.map((userId) => ({
        user_id: userId,
        team_id: input.teamId ?? null,
        kind: input.kind,
        title: input.title,
        body: input.body ?? "",
        resource_type: input.resourceType ?? null,
        resource_id: input.resourceId ?? null,
      })),
    );
    if (error) {
      console.error("[notify]", error.message);
      return 0;
    }
    return allowed.length;
  } catch (error) {
    console.error("[notify]", error instanceof Error ? error.message : error);
    return 0;
  }
}

/** All member ids of a team. */
export async function teamMemberIds(teamId: string) {
  try {
    const admin = createAdminClient();
    const { data } = await admin.from("team_members").select("user_id").eq("team_id", teamId);
    return (data ?? []).map((row) => row.user_id as string);
  } catch {
    return [];
  }
}

/**
 * Invitation email delivery honours the recipient's email_invitations
 * preference. Returns whether the message was handed to the provider.
 */
export async function sendInvitationEmailWithPreference(input: { to: string; teamName: string; inviteUrl: string; role: string; userId?: string | null }) {
  try {
    const admin = createAdminClient();
    if (input.userId) {
      const { data } = await admin
        .from("notification_preferences")
        .select("email_invitations")
        .eq("user_id", input.userId)
        .maybeSingle();
      if (data && data.email_invitations === false) return { sent: false, skipped: true };
    }
  } catch {
    // Preference lookup failure must not block delivery.
  }
  return sendInvitationEmail({ to: input.to, teamName: input.teamName, inviteUrl: input.inviteUrl, role: input.role });
}
