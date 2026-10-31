export function formatBytes(bytes: number) {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function titleCase(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ") : value;
}

/** Converts an ISO timestamp to the local `datetime-local` input value the browser expects. */
export function toDateTimeInput(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

/** Owner-facing wording after an invitation is created, including why a send failed. */
export function invitationDeliveryMessage(
  email: string,
  result: { emailSent?: boolean; emailSkipped?: boolean; emailReason?: string; inviteUrl?: string },
) {
  if (result.emailSent) return `Invitation emailed to ${email}. They can accept it straight from their inbox.`;
  const link = ` Share this link instead: ${result.inviteUrl ?? ""}`.trimEnd();
  if (result.emailSkipped) return `Invitation created for ${email}, but that account turns off invitation emails.${link}`;
  return `Invitation created for ${email}, but the email was not delivered. ${result.emailReason ?? "Check the email settings for this deployment."}${link}`;
}
