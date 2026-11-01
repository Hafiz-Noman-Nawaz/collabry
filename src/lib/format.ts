export function formatBytes(bytes: number) {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function titleCase(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ") : value;
}

/** Converts a stored ISO timestamp to the local wall-clock value the date and time fields use. */
export function toDateTimeInput(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

/** "6 Nov 2026" from a `YYYY-MM-DD` column value; the pinned locale keeps server and client renders identical. */
export function formatShortDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  return new Date(year, month - 1, day).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Owner-facing wording after an invitation is created, including why a send failed. */
export function invitationDeliveryMessage(
  email: string,
  result: {
    emailSent?: boolean;
    emailCause?: "opted-out" | "not-configured" | "provider";
    emailReason?: string;
    inviteUrl?: string;
  },
) {
  if (result.emailSent) return `Invitation emailed to ${email}. They can accept it straight from their inbox.`;
  const link = ` Share this link instead: ${result.inviteUrl ?? ""}`.trimEnd();
  if (result.emailCause === "not-configured") {
    return `Invitation created for ${email}, but this deployment has no email sender configured, so nothing was sent. ${result.emailReason ?? "Set RESEND_FROM_EMAIL to an address on your verified Resend domain and redeploy."}${link}`;
  }
  if (result.emailCause === "opted-out") {
    return `Invitation created for ${email}, but that account turns off invitation emails.${link}`;
  }
  return `Invitation created for ${email}, but the email was not delivered. ${result.emailReason ?? "Check the email settings for this deployment."}${link}`;
}
