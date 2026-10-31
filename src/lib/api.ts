import { NextResponse } from "next/server";
import { z } from "zod";

export const unauthorized = () => NextResponse.json({ error: "Authentication required." }, { status: 401 });
export const forbidden = (message = "You do not have permission to do that.") => NextResponse.json({ error: message }, { status: 403 });
export const badRequest = (message: string) => NextResponse.json({ error: message }, { status: 400 });
export const notFound = (message = "Not found.") => NextResponse.json({ error: message }, { status: 404 });
export const serverError = (message = "Something went wrong.") => NextResponse.json({ error: message }, { status: 500 });

const uuidSchema = z.string().uuid();

export function parseUuid(value: string | null | undefined): string | null {
  return uuidSchema.safeParse(value).success ? (value as string) : null;
}

/** Reads a bounded positive integer query parameter. */
export function queryInt(url: URL, key: string, fallback: number, max: number) {
  const raw = Number.parseInt(url.searchParams.get(key) ?? "", 10);
  if (!Number.isFinite(raw) || raw < 0) return fallback;
  return Math.min(raw, max);
}
