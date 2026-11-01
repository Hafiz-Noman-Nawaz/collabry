export type EmailOutcome = {
  sent: boolean;
  skipped: boolean;
  reason?: string;
  /** Why nothing was handed to the provider, so the UI never blames the recipient for a server gap. */
  cause?: "opted-out" | "not-configured" | "provider";
};

export type MeetingEmailAction = "scheduled" | "updated" | "cancelled" | "added" | "reminder";

export type MeetingDetails = {
  title: string;
  agenda?: string | null;
  startsAt: string;
  endsAt: string;
  timezone?: string | null;
  joinUrl?: string | null;
  /** Deep link back to the meeting in Collabry; empty when no canonical host is configured. */
  meetingUrl: string;
};

const ROLE_LABELS: Record<string, string> = {
  supervisor: "Supervisor",
  leader: "Team leader",
  member: "Team member",
  reviewer: "Reviewer",
};

const ACCENT = "#6d4aff";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character] ?? character));
}

/** Reverses escapeHtml so plain-text parts of the email read naturally. */
function toPlainText(markup: string) {
  return markup
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Resolves the IANA zone stored on a meeting, falling back to UTC for bad values. */
function safeTimeZone(timezone?: string | null) {
  const candidate = timezone?.trim();
  if (!candidate) return "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: candidate });
    return candidate;
  } catch {
    return "UTC";
  }
}

function formatDay(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone,
  }).format(new Date(iso));
}

function formatClock(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone }).format(new Date(iso));
}

/** "3:00 pm – 4:00 pm" or "all day" when the recorded range is unusable. */
function formatTimeRange(startsAt: string, endsAt: string, timeZone: string) {
  const start = formatClock(startsAt, timeZone);
  if (!endsAt || new Date(endsAt).getTime() <= new Date(startsAt).getTime()) return start;
  return `${start} – ${formatClock(endsAt, timeZone)}`;
}

type LayoutInput = {
  preheader: string;
  eyebrow: string;
  title: string;
  /** Paragraphs of already-escaped HTML, mirrored as plain text. */
  paragraphsHtml: string[];
  paragraphsText: string[];
  cta?: { label: string; url: string } | null;
  /** Block of already-escaped HTML shown under the copy (details table, link). */
  detailHtml?: string;
  detailText?: string[];
  footerHtml: string;
  footerText: string;
};

function renderEmail(input: LayoutInput) {
  const button = input.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 26px;"><tr><td style="border-radius:10px;background:${ACCENT};">
          <a href="${escapeHtml(input.cta.url)}" style="display:inline-block;padding:14px 26px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:10px;">${escapeHtml(input.cta.label)}</a>
        </td></tr></table>`
    : "";

  const paragraphMarkup = (list: string[]) =>
    list.map((text) => `<p style="margin:0 0 14px;color:#4a4460;font-size:15px;line-height:1.7;">${text}</p>`).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:#f4f2fb;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${input.preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2fb;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e6e1f5;border-radius:16px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <tr><td style="background:${ACCENT};padding:24px 32px;">
        <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:0.02em;">Collabry</span>
      </td></tr>
      <tr><td style="padding:36px 32px 6px;">
        <p style="margin:0 0 10px;color:${ACCENT};font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">${escapeHtml(input.eyebrow)}</p>
        <h1 style="margin:0 0 18px;color:#1f1b2e;font-size:26px;line-height:1.3;">${input.title}</h1>
        ${paragraphMarkup(input.paragraphsHtml)}
        ${input.detailHtml ?? ""}
        ${button}
      </td></tr>
      <tr><td style="padding:20px 32px 28px;border-top:1px solid #eee9fa;">
        <p style="margin:0;color:#8b859d;font-size:12px;line-height:1.7;">${input.footerHtml}</p>
      </td></tr>
    </table>
    <p style="margin:18px 0 0;color:#9b95ab;font-size:11px;">Collabry · Secure collaboration for project teams</p>
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    toPlainText(input.title),
    "",
    ...input.paragraphsText.flatMap((paragraph) => [paragraph, ""]),
    ...(input.detailText ?? []),
    "",
    ...(input.cta ? [`${input.cta.label}:`, input.cta.url, ""] : []),
    input.footerText,
    "",
    "— Collabry, secure collaboration for project teams",
  ].join("\n");

  return { html, text: text.replace(/\n{3,}/g, "\n\n") };
}

/** Turns a provider status and message into wording an owner can act on. */
function providerReason(status: number, providerMessage: string) {
  if (/not verified/i.test(providerMessage)) {
    return "The sender address is not on a domain verified with Resend. Set RESEND_FROM_EMAIL to an address on your verified sending domain.";
  }
  // Resend answers 400 for a malformed key and 401/403 for a revoked one.
  if (status === 400 || status === 401 || status === 403 || /api key/i.test(providerMessage)) {
    return "Resend rejected the API key. Check RESEND_API_KEY in the deployment environment.";
  }
  if (status === 429) return "Resend rate limited this send; the message will go out on the next attempt.";
  return providerMessage;
}

export function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY?.trim() && process.env.RESEND_FROM_EMAIL?.trim());
}

/** Resend keys are issued as `re_` plus a long random suffix, so anything else never reaches the API. */
export function emailKeyLooksValid() {
  return /^re_[a-z0-9_-]{16,}$/i.test(process.env.RESEND_API_KEY?.trim() ?? "");
}

/** Returns the domain part of RESEND_FROM_EMAIL so health checks can prove it is verified. */
export function configuredSenderDomain() {
  const from = process.env.RESEND_FROM_EMAIL?.trim() ?? "";
  return from.match(/@([a-z0-9.-]+)\s*>?$/i)?.[1]?.toLowerCase() ?? null;
}

async function deliver(input: { to: string; subject: string; html: string; text: string; replyTo?: string | null }): Promise<EmailOutcome> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM_EMAIL?.trim();
  if (!apiKey || !from) {
    return {
      sent: false,
      skipped: true,
      cause: "not-configured",
      reason: "Email is not configured on this server. Set RESEND_API_KEY and RESEND_FROM_EMAIL to an address on your verified Resend domain, then redeploy.",
    };
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { message?: unknown } | null;
      const providerMessage = typeof detail?.message === "string" && detail.message.trim() ? detail.message.trim() : `The email provider responded with HTTP ${response.status}.`;
      return { sent: false, skipped: false, cause: "provider", reason: providerReason(response.status, providerMessage) };
    }
    return { sent: true, skipped: false };
  } catch (error) {
    return {
      sent: false,
      skipped: false,
      cause: "provider",
      reason: `The email provider could not be reached (${error instanceof Error ? error.message : "network error"}).`,
    };
  }
}

export async function sendInvitationEmail(input: {
  to: string;
  teamName: string;
  inviteUrl: string;
  role: string;
  inviterName?: string | null;
  inviterEmail?: string | null;
}): Promise<EmailOutcome> {
  const teamName = escapeHtml(input.teamName);
  const roleLabel = escapeHtml(ROLE_LABELS[input.role] ?? input.role);
  const inviterName = escapeHtml(input.inviterName?.trim() || "A Collabry project owner");
  const inviteUrl = encodeURI(input.inviteUrl);
  const safeUrl = escapeHtml(inviteUrl);
  const senderName = input.inviterName?.trim() || "A Collabry owner";

  const { html, text } = renderEmail({
    preheader: `${inviterName} invited you to collaborate on ${teamName} as a ${roleLabel}.`,
    eyebrow: "Project invitation",
    title: `You're invited to ${teamName}`,
    paragraphsHtml: [
      `${inviterName} has invited you to join <strong>${teamName}</strong> on Collabry as a <strong>${roleLabel}</strong>.`,
      `Collabry keeps tasks, meetings, messages and project files together in one secure workspace, so your team always shares the same plan.`,
      `This invitation expires 72 hours after it was sent. If the button doesn't work, copy this link into your browser:`,
    ],
    paragraphsText: [
      `${input.inviterName?.trim() || "A Collabry project owner"} has invited you to join "${input.teamName}" on Collabry as a ${ROLE_LABELS[input.role] ?? input.role}.`,
      "Collabry keeps tasks, meetings, messages and project files together in one secure workspace, so your team always shares the same plan.",
      "This invitation expires 72 hours after it was sent.",
    ],
    detailHtml: `<p style="margin:0 0 28px;font-size:13px;line-height:1.6;word-break:break-all;"><a href="${safeUrl}" style="color:${ACCENT};">${safeUrl}</a></p>`,
    detailText: [inviteUrl],
    cta: { label: "Accept invitation", url: inviteUrl },
    footerHtml: `You received this email because ${inviterName} invited a teammate to a Collabry project. If you weren't expecting it, you can safely ignore this message — no access is granted until you accept.`,
    footerText: "If you weren't expecting this invitation, you can safely ignore this email — no access is granted until you accept.",
  });

  const outcome = await deliver({
    to: input.to,
    subject: `${senderName} invited you to join ${input.teamName} on Collabry`,
    html,
    text,
    replyTo: input.inviterEmail,
  });
  return outcome;
}

const MEETING_COPY: Record<MeetingEmailAction, { eyebrow: string; title: (meeting: MeetingDetails) => string }> = {
  scheduled: { eyebrow: "Meeting scheduled", title: (meeting) => escapeHtml(`New meeting: ${meeting.title}`) },
  updated: { eyebrow: "Meeting rescheduled", title: (meeting) => escapeHtml(`Updated meeting: ${meeting.title}`) },
  cancelled: { eyebrow: "Meeting cancelled", title: (meeting) => escapeHtml(`Cancelled meeting: ${meeting.title}`) },
  added: { eyebrow: "You're invited", title: (meeting) => escapeHtml(`You've been added to ${meeting.title}`) },
  reminder: { eyebrow: "Reminder", title: (meeting) => escapeHtml(`${meeting.title} starts tomorrow`) },
};

export async function sendMeetingEmail(input: {
  to: string;
  recipientName?: string | null;
  teamName: string;
  organizerName?: string | null;
  action: MeetingEmailAction;
  meeting: MeetingDetails;
}): Promise<EmailOutcome> {
  const timeZone = safeTimeZone(input.meeting.timezone);
  const day = formatDay(input.meeting.startsAt, timeZone);
  const timeRange = formatTimeRange(input.meeting.startsAt, input.meeting.endsAt, timeZone);
  const zoneLabel = escapeHtml(timeZone.replace(/_/g, " "));
  const meetingTitle = escapeHtml(input.meeting.title);
  const teamName = escapeHtml(input.teamName);
  const greeting = input.recipientName?.trim() ? escapeHtml(input.recipientName.trim()) : "there";
  const organizer = input.organizerName?.trim() ? escapeHtml(input.organizerName.trim()) : "A teammate";
  const agenda = input.meeting.agenda?.trim() ? escapeHtml(input.meeting.agenda.trim()) : "";
  const detailsHref = encodeURI(input.meeting.meetingUrl);

  const introHtml: Record<MeetingEmailAction, string> = {
    scheduled: `${organizer} has scheduled <strong>${meetingTitle}</strong> for <strong>${teamName}</strong>. Please review the time and add the session to your calendar.`,
    updated: `${organizer} has moved <strong>${meetingTitle}</strong> for <strong>${teamName}</strong>. The session now runs at the time shown below.`,
    cancelled: `<strong>${meetingTitle}</strong> for <strong>${teamName}</strong> has been cancelled. No action is needed — the session has been removed from your timeline.`,
    added: `${organizer} has added you to <strong>${meetingTitle}</strong> for <strong>${teamName}</strong>. Please confirm whether you can attend.`,
    reminder: `This is a reminder that <strong>${meetingTitle}</strong> for <strong>${teamName}</strong> is starting tomorrow.`,
  };

  const introText = toPlainText(introHtml[input.action]);

  const detailRows =
    input.action === "cancelled"
      ? []
      : [
          { label: "Date", value: escapeHtml(day) },
          { label: "Time", value: `${escapeHtml(timeRange)} (${zoneLabel})` },
          ...(agenda ? [{ label: "Agenda", value: agenda }] : []),
        ];

  const detailHtml = detailRows.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border:1px solid #eee9fa;border-radius:12px;border-collapse:separate;">
        ${detailRows
          .map(
            (row) =>
              `<tr><td style="padding:12px 16px;color:#8b859d;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;width:88px;vertical-align:top;">${row.label}</td><td style="padding:12px 16px 12px 0;color:#1f1b2e;font-size:14px;line-height:1.6;">${row.value}</td></tr>`,
          )
          .join("")}
      </table>`
    : "";

  const joinHtml = input.meeting.joinUrl
    ? `<p style="margin:0 0 14px;color:#4a4460;font-size:15px;line-height:1.7;">Join link: <a href="${escapeHtml(encodeURI(input.meeting.joinUrl))}" style="color:${ACCENT};word-break:break-all;">${escapeHtml(input.meeting.joinUrl)}</a></p>`
    : "";

  const { html, text } = renderEmail({
    preheader: `${meetingTitle.replace(/&quot;/g, '"')} · ${day} at ${timeRange}`,
    eyebrow: MEETING_COPY[input.action].eyebrow,
    title: MEETING_COPY[input.action].title(input.meeting),
    paragraphsHtml: [`Hi ${greeting},`, introHtml[input.action]],
    paragraphsText: [`Hi ${input.recipientName?.trim() || "there"},`, introText],
    detailHtml: detailHtml + joinHtml,
    detailText: [
      ...detailRows.map((row) => `${row.label}: ${toPlainText(row.value)}`),
      ...(input.meeting.joinUrl ? [`Join link: ${input.meeting.joinUrl}`] : []),
    ],
    cta:
      input.action === "cancelled"
        ? null
        : {
            label: input.action === "reminder" ? "View meeting details" : "Open in Collabry",
            url: detailsHref,
          },
    footerHtml: `You receive meeting emails for <strong>${teamName}</strong> because you are a member of the project. Meeting preferences can be changed at any time in Collabry settings.`,
    footerText: `You receive meeting emails for ${input.teamName} because you are a member of the project. Meeting preferences can be changed at any time in Collabry settings.`,
  });

  const subjects: Record<MeetingEmailAction, string> = {
    scheduled: `Meeting scheduled: ${input.meeting.title} — ${day}`,
    updated: `Meeting rescheduled: ${input.meeting.title} — ${day}`,
    cancelled: `Meeting cancelled: ${input.meeting.title}`,
    added: `You've been added to ${input.meeting.title} — ${day}`,
    reminder: `Reminder: ${input.meeting.title} starts tomorrow at ${timeRange}`,
  };

  return deliver({ to: input.to, subject: subjects[input.action], html, text });
}
