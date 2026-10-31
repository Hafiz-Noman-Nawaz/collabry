/**
 * Public site origin for invitation links and auth redirects.
 * Prefers NEXT_PUBLIC_APP_URL, but never emails a localhost URL from a
 * deployed host — that would send teammates to the developer's machine.
 */
export function getPublicAppUrl(request: Request) {
  const configured = configuredAppUrl();
  const requestUrl = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const dynamicOrigin = forwardedHost
    ? `${forwardedProto || requestUrl.protocol.replace(":", "")}://${forwardedHost}`
    : requestUrl.origin;

  if (!configured) return dynamicOrigin;
  const configuredIsLocal = isLocalHost(configured);
  const requestIsLocal = isLocalHost(dynamicOrigin);
  if (configuredIsLocal && !requestIsLocal) return dynamicOrigin;
  return configured;
}

/**
 * The configured canonical origin, or null. Background jobs have no incoming
 * request to derive a host from, so their emails depend on this value.
 */
export function configuredAppUrl() {
  return process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") ?? null;
}

function isLocalHost(value: string) {
  return /localhost|127\.0\.0\.1/i.test(value);
}
