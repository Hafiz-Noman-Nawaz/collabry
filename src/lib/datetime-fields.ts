export type FieldMode = "datetime" | "date";

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * Field values are local wall-clock strings ("2026-11-06T15:30" or "2026-11-06").
 * Parsed by components because `new Date("2026-11-06")` means UTC midnight and would
 * shift every date-only value by the viewer's offset.
 */
export function parseFieldValue(value: string | null | undefined, mode: FieldMode): Date | null {
  if (!value) return null;
  const match =
    mode === "datetime"
      ? /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(value)
      : /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), hour ? Number(hour) : 0, minute ? Number(minute) : 0);
  // Rejects rollovers such as "2026-13-45", which Date would silently turn into February.
  const rollover =
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day) ||
    date.getHours() !== (hour ? Number(hour) : 0) ||
    date.getMinutes() !== (minute ? Number(minute) : 0);
  return Number.isNaN(date.getTime()) || rollover ? null : date;
}

export function formatFieldValue(date: Date, mode: FieldMode) {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return mode === "datetime" ? `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}` : day;
}

/** Locale-independent "3:00 pm" so the dial, the readout and the trigger always agree. */
export function formatClockTime(date: Date) {
  const hours24 = date.getHours();
  const period = hours24 < 12 ? "am" : "pm";
  const hour12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hour12}:${pad(date.getMinutes())} ${period}`;
}

/**
 * Locale is pinned so the server-rendered trigger and the picked-up client render
 * the same string; en-GB matches the date style used in the outbound emails.
 */
export function describeFieldValue(value: string, mode: FieldMode, emptyText?: string) {
  const date = parseFieldValue(value, mode);
  if (!date) return emptyText ?? (mode === "datetime" ? "Pick a date and time" : "Pick a date");
  const day = date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  return mode === "datetime" ? `${day} · ${formatClockTime(date)}` : day;
}

/** Local calendar day key, used to spot "today" inside the grid. */
export function dayKey(date: Date) {
  return formatFieldValue(date, "date");
}

export function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function addMonths(date: Date, months: number) {
  const day = date.getDate();
  const next = new Date(date.getFullYear(), date.getMonth() + months, 1);
  // The 31st of a 31-day month would otherwise roll into March.
  next.setDate(Math.min(day, new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()));
  return next;
}

export function addDaysToField(value: string, days: number, mode: FieldMode) {
  const date = parseFieldValue(value, mode) ?? new Date();
  date.setDate(date.getDate() + days);
  return formatFieldValue(date, mode);
}

export function addMinutesToField(value: string, minutes: number) {
  const date = parseFieldValue(value, "datetime") ?? new Date();
  date.setMinutes(date.getMinutes() + minutes);
  return formatFieldValue(date, "datetime");
}

export function durationMinutes(startValue: string, endValue: string) {
  const start = parseFieldValue(startValue, "datetime");
  const end = parseFieldValue(endValue, "datetime");
  if (!start || !end) return null;
  const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
  return minutes > 0 ? minutes : null;
}

export function formatDuration(minutes: number | null) {
  if (!minutes) return "";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** The next clean slot, so a new meeting never starts in the past or at :17. */
export function startOfNextSlot(increment = 30, now = new Date()) {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), Math.ceil(now.getMinutes() / increment) * increment);
  return formatFieldValue(date, "datetime");
}

/**
 * Moving the start keeps the length instead of stranding the end behind it, which is
 * what calendar apps do and what makes rescheduling a meeting one gesture.
 */
export function shiftEndForDuration(startValue: string, endValue: string, previousStart: string, fallbackMinutes = 60) {
  const duration = durationMinutes(previousStart, endValue) ?? Math.max(5, fallbackMinutes);
  return addMinutesToField(startValue, Math.min(duration, 24 * 60));
}

/** ISO timestamp for the API, or null when the field is empty. */
export function fieldToIso(value: string | null | undefined, mode: FieldMode = "datetime") {
  const date = parseFieldValue(value, mode);
  return date ? date.toISOString() : null;
}
