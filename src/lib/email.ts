type InvitationEmailInput = { to: string; teamName: string; inviteUrl: string; role: string };

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
  const role = escapeHtml(input.role);
  const inviteUrl = encodeURI(input.inviteUrl);

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: `You have been invited to ${input.teamName} on Collabry`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;color:#202034"><h1>Join ${teamName}</h1><p>You have been invited to join this Collabry project as a ${role}.</p><p><a href="${inviteUrl}" style="display:inline-block;padding:12px 18px;background:#7953db;color:#fff;text-decoration:none;border-radius:6px">Review invitation</a></p><p>This invitation expires in 72 hours.</p></div>`,
    }),
  });
  if (!response.ok) throw new Error("Invitation email delivery failed.");
  return { sent: true, skipped: false };
}
