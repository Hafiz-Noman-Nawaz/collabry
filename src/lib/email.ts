type InvitationEmailInput = {
  to: string;
  teamName: string;
  inviteUrl: string;
  role: string;
  inviterName?: string | null;
  inviterEmail?: string | null;
};

const ROLE_LABELS: Record<string, string> = {
  supervisor: "Supervisor",
  leader: "Team leader",
  member: "Team member",
  reviewer: "Reviewer",
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character] ?? character));
}

export async function sendInvitationEmail(input: InvitationEmailInput) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) return { sent: false, skipped: true };

  const teamName = escapeHtml(input.teamName);
  const roleLabel = escapeHtml(ROLE_LABELS[input.role] ?? input.role);
  const inviterName = escapeHtml(input.inviterName?.trim() || "A Collabry project owner");
  const recipient = escapeHtml(input.to);
  const inviteUrl = encodeURI(input.inviteUrl);
  const safeUrl = escapeHtml(inviteUrl);

  const subject = `${input.inviterName?.trim() || "A Collabry owner"} invited you to join ${input.teamName} on Collabry`;

  const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:#f4f2fb;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${inviterName} invited you to collaborate on ${teamName} as a ${roleLabel}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2fb;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e6e1f5;border-radius:16px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <tr><td style="background:#6d4aff;padding:24px 32px;">
        <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:0.02em;">Collabry</span>
      </td></tr>
      <tr><td style="padding:36px 32px 6px;">
        <p style="margin:0 0 10px;color:#6d4aff;font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">Project invitation</p>
        <h1 style="margin:0 0 18px;color:#1f1b2e;font-size:26px;line-height:1.3;">You're invited to ${teamName}</h1>
        <p style="margin:0 0 14px;color:#4a4460;font-size:15px;line-height:1.7;">${inviterName} has invited you to join <strong>${teamName}</strong> on Collabry as a <strong>${roleLabel}</strong>.</p>
        <p style="margin:0 0 26px;color:#4a4460;font-size:15px;line-height:1.7;">Collabry keeps tasks, meetings, messages and project files together in one secure workspace, so your team always shares the same plan.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 26px;"><tr><td style="border-radius:10px;background:#6d4aff;">
          <a href="${safeUrl}" style="display:inline-block;padding:14px 26px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:10px;">Accept invitation</a>
        </td></tr></table>
        <p style="margin:0 0 8px;color:#7c7691;font-size:13px;line-height:1.6;">This invitation expires 72 hours after it was sent. If the button doesn't work, copy this link into your browser:</p>
        <p style="margin:0 0 28px;font-size:13px;line-height:1.6;word-break:break-all;"><a href="${safeUrl}" style="color:#6d4aff;">${safeUrl}</a></p>
      </td></tr>
      <tr><td style="padding:20px 32px 28px;border-top:1px solid #eee9fa;">
        <p style="margin:0;color:#8b859d;font-size:12px;line-height:1.7;">You received this email because ${inviterName} invited ${recipient} to a Collabry project. If you weren't expecting it, you can safely ignore this message — no access is granted until you accept.</p>
      </td></tr>
    </table>
    <p style="margin:18px 0 0;color:#9b95ab;font-size:11px;">Collabry · Secure collaboration for project teams</p>
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    `${input.inviterName?.trim() || "A Collabry project owner"} has invited you to join "${input.teamName}" on Collabry as a ${ROLE_LABELS[input.role] ?? input.role}.`,
    "",
    "Accept your invitation (expires in 72 hours):",
    inviteUrl,
    "",
    "If you weren't expecting this invitation, you can safely ignore this email — no access is granted until you accept.",
    "",
    "— Collabry, secure collaboration for project teams",
  ].join("\n");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject,
      html,
      text,
      ...(input.inviterEmail ? { reply_to: input.inviterEmail } : {}),
    }),
  });
  if (!response.ok) throw new Error("Invitation email delivery failed.");
  return { sent: true, skipped: false };
}
