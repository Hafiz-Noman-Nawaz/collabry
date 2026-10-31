import { createAdminClient } from "@/lib/supabase/admin";
import { sendInvitationEmail, sendMeetingEmail, type EmailOutcome, type MeetingDetails, type MeetingEmailAction } from "@/lib/email";

export type NotificationKind = "invitation" | "task" | "meeting" | "message" | "announcement" | "review";

type NotificationInput = {
  userIds: string[];
  teamId?: string | null;
  kind: NotificationKind;
  title: string;
  body?: string;
  resourceType?: string;
  resourceId?: string | null;
  /** Person who caused the notification; named in meeting emails. */
  organizerId?: string | null;
  /** Meeting attendees are emailed as well as notified in-app. */
  meeting?: { action: MeetingEmailAction; details: MeetingDetails };
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
    if (input.kind === "meeting" && input.meeting) {
      await sendMeetingEmails({
        userIds: allowed,
        teamId: input.teamId ?? null,
        action: input.meeting.action,
        meeting: input.meeting.details,
        organizerId: input.organizerId ?? null,
      }).catch((emailError) => console.error("[email] meeting delivery error:", emailError));
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
 * preference. Returns whether the message was handed to the provider, plus the
 * provider's own wording when it refused.
 */
export async function sendInvitationEmailWithPreference(input: {
  to: string;
  teamName: string;
  inviteUrl: string;
  role: string;
  userId?: string | null;
  inviterName?: string | null;
  inviterEmail?: string | null;
}): Promise<EmailOutcome> {
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
  return sendInvitationEmail({
    to: input.to,
    teamName: input.teamName,
    inviteUrl: input.inviteUrl,
    role: input.role,
    inviterName: input.inviterName,
    inviterEmail: input.inviterEmail,
  });
}

/** Addresses are read from Auth because profiles has no email column. */
async function recipientAddresses(userIds: string[]) {
  if (userIds.length === 0) return [];
  const admin = createAdminClient();
  const results = await Promise.all(
    userIds.slice(0, 60).map(async (userId) => {
      try {
        const { data, error } = await admin.auth.admin.getUserById(userId);
        const email = data?.user?.email;
        if (error || !email) return null;
        return {
          userId,
          email,
          fullName: typeof data.user.user_metadata?.full_name === "string" ? data.user.user_metadata.full_name : null,
        };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((row): row is { userId: string; email: string; fullName: string | null } => row !== null);
}

async function teamNameFor(teamId: string | null) {
  if (!teamId) return "your project";
  try {
    const { data } = await createAdminClient().from("teams").select("name").eq("id", teamId).maybeSingle();
    return data?.name ?? "your project";
  } catch {
    return "your project";
  }
}

/** Display name for an email greeting, preferring the profile the user edits. */
async function displayNameFor(userId: string | null) {
  if (!userId) return null;
  try {
    const admin = createAdminClient();
    const { data: profile } = await admin.from("profiles").select("full_name").eq("id", userId).maybeSingle();
    if (profile?.full_name?.trim()) return profile.full_name.trim();
    const { data } = await admin.auth.admin.getUserById(userId);
    const fromMetadata = data?.user?.user_metadata?.full_name;
    return typeof fromMetadata === "string" && fromMetadata.trim() ? fromMetadata.trim() : null;
  } catch {
    return null;
  }
}

export type EmailDeliverySummary = { sent: number; failed: number; skipped: number; reason?: string };

/**
 * Emails meeting changes to every attendee who still wants meeting email, using
 * the same branded layout as invitations. Delivery is best-effort: an
 * unreachable provider never fails the request that triggered it.
 */
export async function sendMeetingEmails(input: {
  userIds: string[];
  teamId?: string | null;
  action: MeetingEmailAction;
  meeting: MeetingDetails;
  organizerId?: string | null;
}): Promise<EmailDeliverySummary> {
  const summary: EmailDeliverySummary = { sent: 0, failed: 0, skipped: 0 };
  if (!input.meeting.meetingUrl) {
    summary.skipped = input.userIds.length;
    summary.reason = "Set NEXT_PUBLIC_APP_URL so meeting emails can link back to Collabry.";
    console.error("[email] meeting delivery skipped:", summary.reason);
    return summary;
  }
  const recipients = input.userIds.filter((id, index, all) => all.indexOf(id) === index);
  const allowed = await allowedRecipients(recipients, "meeting");
  summary.skipped = recipients.length - allowed.length;
  if (allowed.length === 0) return summary;

  const [teamName, organizerName, addresses] = await Promise.all([
    teamNameFor(input.teamId ?? null),
    displayNameFor(input.organizerId ?? null),
    recipientAddresses(allowed),
  ]);
  summary.skipped += allowed.length - addresses.length;
  const outcomes = await Promise.all(
    addresses.map((recipient) =>
      sendMeetingEmail({
        to: recipient.email,
        recipientName: recipient.fullName,
        teamName,
        organizerName,
        action: input.action,
        meeting: input.meeting,
      }),
    ),
  );
  for (const outcome of outcomes) {
    if (outcome.sent) summary.sent += 1;
    else if (outcome.skipped) summary.skipped += 1;
    else {
      summary.failed += 1;
      summary.reason = outcome.reason ?? summary.reason;
    }
  }
  if (summary.failed > 0) console.error("[email] meeting delivery failed:", summary.reason);
  return summary;
}

