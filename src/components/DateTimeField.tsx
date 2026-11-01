"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  addDaysToField,
  addMinutesToField,
  describeFieldValue,
  durationMinutes,
  formatClockTime,
  formatDuration,
  formatFieldValue,
  isSameDay,
  parseFieldValue,
  startOfMonth,
  startOfNextSlot,
  type FieldMode,
} from "@/lib/datetime-fields";

const PANEL_WIDTH = 316;
const DIAL_RADIUS = 54;
const DIAL_SIZE = 150;
const COMPACT_VIEWPORT = 700;

const WEEKDAY_LABELS = Array.from({ length: 7 }, (_, index) =>
  // 1 January 2024 was a Monday, so this walks the week in Monday-first order.
  new Date(2024, 0, 1 + index).toLocaleDateString("en-GB", { weekday: "short" }),
);

const DAY_SHORTCUTS = [
  { label: "Today", days: 0 },
  { label: "Tomorrow", days: 1 },
  { label: "Next week", days: 7 },
];

export const MEETING_DURATIONS = [30, 60, 90, 120];

type Position = { left?: number; top?: number; width?: number; maxHeight?: number; compact: boolean };

export type DateTimeFieldProps = {
  /** Omit to let the field own its value, which is what FormData forms need. */
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  mode?: FieldMode;
  /** Adds a hidden form input so existing FormData handlers keep working. */
  name?: string;
  emptyText?: string;
  clearable?: boolean;
  disabled?: boolean;
};

/** Calendar grid plus a clock dial: no field ever expects a typed timestamp again. */
export function DateTimeField({ value, defaultValue, onChange, mode = "datetime", name, emptyText, clearable = true, disabled }: DateTimeFieldProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position>({ compact: false });
  const [internal, setInternal] = useState(defaultValue ?? "");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const isControlled = value !== undefined;
  const current = isControlled ? value : internal;

  const picked = parseFieldValue(current, mode);
  const draft = picked ?? parseFieldValue(startOfNextSlot(), "datetime") ?? new Date();

  function close(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function setValue(next: string) {
    if (!isControlled) setInternal(next);
    onChange?.(next);
  }

  function commit(next: Date) {
    setValue(formatFieldValue(next, mode));
  }

  /** A date-only field is finished the moment the day is chosen. */
  function commitDay(next: Date) {
    commit(next);
    if (mode === "date") close();
  }

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const compact = window.innerWidth <= COMPACT_VIEWPORT;
      if (compact) {
        setPosition({ compact: true });
        return;
      }
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(PANEL_WIDTH, window.innerWidth - 16);
      const spaceBelow = window.innerHeight - rect.bottom - 14;
      const spaceAbove = rect.top - 14;
      const preferBelow = spaceBelow >= 330 || spaceBelow >= spaceAbove;
      const maxHeight = Math.max(220, preferBelow ? spaceBelow : spaceAbove);
      const height = Math.min(panelRef.current?.scrollHeight ?? 380, maxHeight);
      setPosition({
        compact: false,
        width,
        maxHeight,
        left: Math.min(Math.max(8, rect.left), window.innerWidth - width - 8),
        top: preferBelow ? rect.bottom + 6 : Math.max(8, rect.top - height - 6),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);

  return (
    <>
      <div className="dtf">
        <button
          type="button"
          ref={triggerRef}
          className={`dtf-trigger${open ? " dtf-open" : ""}`}
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <DtIcon />
          <span className={picked ? "" : "dtf-placeholder"}>{describeFieldValue(current, mode, emptyText)}</span>
          <em aria-hidden>▾</em>
        </button>
        {name ? <input type="hidden" name={name} value={current} /> : null}
      </div>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              className={`dtf-panel${position.compact ? " dtf-sheet" : ""}`}
              role="dialog"
              aria-label={mode === "datetime" ? "Choose date and time" : "Choose date"}
              style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}
            >
              <CalendarPanel draft={draft} selected={picked} onPick={commitDay} />
              <DayShortcuts date={draft} onPick={commitDay} />
              {mode === "datetime" ? <ClockPanel date={draft} onPick={commit} /> : null}
              <div className="dtf-footer">
                {clearable ? (
                  <button type="button" className="dtf-link" onClick={() => { setValue(""); close(false); }}>
                    Clear
                  </button>
                ) : (
                  <span />
                )}
                <button type="button" className="dtf-primary" onClick={() => close()}>
                  Done
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function DtIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

function CalendarPanel({ draft, selected, onPick }: { draft: Date; selected: Date | null; onPick: (date: Date) => void }) {
  const [view, setView] = useState(() => startOfMonth(draft));
  const gridRef = useRef<HTMLDivElement>(null);
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);

  useEffect(() => {
    if (!pendingFocus || !gridRef.current) return;
    gridRef.current.querySelector<HTMLButtonElement>(`[data-day="${pendingFocus}"]`)?.focus();
    setPendingFocus(null);
  }, [pendingFocus]);

  const cells = useMemo(() => {
    const first = startOfMonth(view);
    const offset = (first.getDay() + 6) % 7; // Monday-first column for the 1st.
    const gridStart = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index);
      return { date, key: formatFieldValue(date, "date"), outside: date.getMonth() !== first.getMonth() };
    });
  }, [view]);

  const today = new Date();

  function pick(date: Date) {
    // Keep the time already chosen; the day is the only thing that changes.
    onPick(new Date(date.getFullYear(), date.getMonth(), date.getDate(), draft.getHours(), draft.getMinutes()));
  }

  function moveFocus(days: number) {
    const next = new Date(draft.getFullYear(), draft.getMonth(), draft.getDate() + days);
    setPendingFocus(formatFieldValue(next, "date"));
    setView(startOfMonth(next));
  }

  return (
    <div className="dtf-calendar">
      <div className="dtf-month">
        <button type="button" className="dtf-nav" aria-label="Previous month" onClick={() => setView((c) => startOfMonth(new Date(c.getFullYear(), c.getMonth() - 1, 1)))}>
          ‹
        </button>
        <strong>{view.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</strong>
        <button type="button" className="dtf-nav" aria-label="Next month" onClick={() => setView((c) => startOfMonth(new Date(c.getFullYear(), c.getMonth() + 1, 1)))}>
          ›
        </button>
      </div>
      <div className="dtf-weekdays">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      <div
        className="dtf-days"
        ref={gridRef}
        onKeyDown={(event) => {
          const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
          if (step === undefined) return;
          event.preventDefault();
          moveFocus(step);
        }}
      >
        {cells.map((cell) => (
          <button
            type="button"
            key={cell.key}
            data-day={cell.key}
            tabIndex={isSameDay(cell.date, draft) ? 0 : -1}
            className={
              `dtf-day${cell.outside ? " dtf-outside" : ""}${isSameDay(cell.date, today) ? " dtf-today" : ""}${
                selected && isSameDay(cell.date, selected) ? " dtf-selected" : ""
              }`
            }
            aria-label={cell.date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
            aria-pressed={Boolean(selected && isSameDay(cell.date, selected))}
            onClick={() => pick(cell.date)}
          >
            {cell.date.getDate()}
          </button>
        ))}
      </div>
    </div>
  );
}

function DayShortcuts({ date, onPick }: { date: Date; onPick: (date: Date) => void }) {
  return (
    <div className="dtf-shortcuts" role="group" aria-label="Quick dates">
      {DAY_SHORTCUTS.map((shortcut) => {
        const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + shortcut.days);
        return (
          <button
            type="button"
            key={shortcut.label}
            onClick={() => onPick(new Date(next.getFullYear(), next.getMonth(), next.getDate(), date.getHours(), date.getMinutes()))}
          >
            {shortcut.label}
          </button>
        );
      })}
    </div>
  );
}

function ClockPanel({ date, onPick }: { date: Date; onPick: (date: Date) => void }) {
  const [step, setStep] = useState<"hour" | "minute">("hour");
  const [dragging, setDragging] = useState(false);
  const hours24 = date.getHours();
  const isPm = hours24 >= 12;
  const hour12 = hours24 % 12 === 0 ? 12 : hours24 % 12;

  function set(next: { hours?: number; minutes?: number }) {
    onPick(new Date(date.getFullYear(), date.getMonth(), date.getDate(), next.hours ?? hours24, next.minutes ?? date.getMinutes()));
  }

  function slotToTime(slot: number) {
    if (step === "hour") {
      const hour = slot === 0 ? 12 : slot;
      set({ hours: (hour % 12) + (isPm ? 12 : 0) });
      setStep("minute");
      return;
    }
    set({ minutes: (slot * 5) % 60 });
  }

  function slotFromEvent(event: React.PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const dx = event.clientX - (bounds.left + bounds.width / 2);
    const dy = event.clientY - (bounds.top + bounds.height / 2);
    const angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
    return Math.round((((angle % 360) + 360) % 360) / 30) % 12;
  }

  const activeSlot = step === "hour" ? hour12 % 12 : Math.round(date.getMinutes() / 5) % 12;
  const activeAngle = (activeSlot * 30 * Math.PI) / 180;
  const labels = Array.from({ length: 12 }, (_, index) => {
    const slot = index === 0 ? 0 : index;
    return step === "hour" ? (slot === 0 ? 12 : slot) : (index * 5) % 60;
  });

  return (
    <div className="dtf-clock">
      <div className="dtf-clock-tabs" role="group" aria-label="Which part to set">
        <button type="button" className={step === "hour" ? "dtf-tab-active" : ""} onClick={() => setStep("hour")}>
          Hour
        </button>
        <button type="button" className={step === "minute" ? "dtf-tab-active" : ""} onClick={() => setStep("minute")}>
          Minute
        </button>
      </div>
      <div className="dtf-clock-body">
        <div
          className="dtf-dial"
          style={{ width: DIAL_SIZE, height: DIAL_SIZE }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(true);
            slotToTime(slotFromEvent(event));
          }}
          onPointerMove={(event) => dragging && slotToTime(slotFromEvent(event))}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
        >
          <svg viewBox={`0 0 ${DIAL_SIZE} ${DIAL_SIZE}`} aria-hidden>
            <circle className="dtf-dial-ring" cx={DIAL_SIZE / 2} cy={DIAL_SIZE / 2} r={DIAL_RADIUS} />
            <line
              className="dtf-dial-hand"
              x1={DIAL_SIZE / 2}
              y1={DIAL_SIZE / 2}
              x2={DIAL_SIZE / 2 + DIAL_RADIUS * Math.sin(activeAngle)}
              y2={DIAL_SIZE / 2 - DIAL_RADIUS * Math.cos(activeAngle)}
            />
            <circle className="dtf-dial-knob" cx={DIAL_SIZE / 2 + DIAL_RADIUS * Math.sin(activeAngle)} cy={DIAL_SIZE / 2 - DIAL_RADIUS * Math.cos(activeAngle)} r={9} />
          </svg>
          {labels.map((label, index) => {
            const angle = (index * 30 * Math.PI) / 180;
            return (
              <button
                type="button"
                key={`${step}-${label}`}
                className={`dtf-dial-label${index === activeSlot ? " dtf-dial-active" : ""}`}
                style={{
                  left: DIAL_SIZE / 2 + DIAL_RADIUS * Math.sin(angle) - 13,
                  top: DIAL_SIZE / 2 - DIAL_RADIUS * Math.cos(angle) - 13,
                }}
                aria-label={`${label} ${step === "hour" ? "o'clock" : "minutes"}`}
                onClick={() => slotToTime(index)}
              >
                {String(label).padStart(2, "0")}
              </button>
            );
          })}
        </div>
        <div className="dtf-readout">
          <div className="dtf-unit">
            <button type="button" aria-label="Earlier hour" onClick={() => set({ hours: (hours24 + 23) % 24 })}>
              ▲
            </button>
            <strong>{hour12}</strong>
            <button type="button" aria-label="Later hour" onClick={() => set({ hours: (hours24 + 1) % 24 })}>
              ▼
            </button>
          </div>
          <span className="dtf-colon" aria-hidden>
            :
          </span>
          <div className="dtf-unit">
            <button type="button" aria-label="Earlier minute" onClick={() => set({ minutes: (date.getMinutes() + 55) % 60 })}>
              ▲
            </button>
            <strong>{String(date.getMinutes()).padStart(2, "0")}</strong>
            <button type="button" aria-label="Later minute" onClick={() => set({ minutes: (date.getMinutes() + 5) % 60 })}>
              ▼
            </button>
          </div>
          <div className="dtf-period" role="group" aria-label="Morning or afternoon">
            <button
              type="button"
              className={!isPm ? "dtf-tab-active" : ""}
              aria-pressed={!isPm}
              onClick={() => set({ hours: hours24 < 12 ? hours24 : hours24 - 12 })}
            >
              am
            </button>
            <button
              type="button"
              className={isPm ? "dtf-tab-active" : ""}
              aria-pressed={isPm}
              onClick={() => set({ hours: hours24 >= 12 ? hours24 : hours24 + 12 })}
            >
              pm
            </button>
          </div>
          <button type="button" className="dtf-link" onClick={() => onPick(new Date())}>
            Now · {formatClockTime(new Date())}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One-tap date shortcuts that live beside a field, so a due date is often a single
 * click and the calendar never has to open.
 */
export function DatePresets({ value, onChange, mode = "datetime", label = "Quick picks" }: { value: string; onChange: (value: string) => void; mode?: FieldMode; label?: string }) {
  return (
    <div className="dtf-shortcuts dtf-inline" role="group" aria-label={label}>
      {DAY_SHORTCUTS.map((shortcut) => (
        <button
          type="button"
          key={shortcut.label}
          onClick={() =>
            onChange(
              mode === "datetime"
                ? addDaysToField(value || startOfNextSlot(), shortcut.days, "datetime")
                : addDaysToField(value || formatFieldValue(new Date(), "date"), shortcut.days, "date"),
            )
          }
        >
          {shortcut.label}
        </button>
      ))}
    </div>
  );
}

/** Calendar only — for project start and target dates. */
export function DateField(props: Omit<DateTimeFieldProps, "mode">) {
  return <DateTimeField {...props} mode="date" />;
}

/** Length chips for a meeting: picking 30/60/90/120 minutes beats picking an end time. */
export function DurationChips({ start, end, onEnd }: { start: string; end: string; onEnd: (value: string) => void }) {
  const minutes = durationMinutes(start, end);
  return (
    <div className="dtf-duration" role="group" aria-label="Meeting length">
      <span className="dtf-duration-label">{minutes ? formatDuration(minutes) : "Set a length"}</span>
      <div className="dtf-duration-chips">
        {MEETING_DURATIONS.map((option) => (
          <button type="button" key={option} className={minutes === option ? "dtf-tab-active" : ""} disabled={!start} onClick={() => onEnd(addMinutesToField(start, option))}>
            {formatDuration(option)}
          </button>
        ))}
      </div>
    </div>
  );
}
