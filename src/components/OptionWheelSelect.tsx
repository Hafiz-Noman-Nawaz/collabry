"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type OptionWheelItem = { value: string; label: string };

type Props = {
  value?: string;
  defaultValue?: string;
  options: OptionWheelItem[];
  onChange?: (value: string) => void;
  name?: string;
  ariaLabel: string;
  disabled?: boolean;
  placeholder?: string;
};

export function OptionWheelSelect({
  value,
  defaultValue = "",
  options,
  onChange,
  name,
  ariaLabel,
  disabled,
  placeholder = "Choose an option",
}: Props) {
  const [internal, setInternal] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = value ?? internal;
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === current));
  const selected = options[selectedIndex];
  const visible = useMemo(() => {
    if (options.length === 0) return [];
    return Array.from({ length: Math.min(5, options.length) }, (_, offset) => {
      const distance = offset - Math.floor(Math.min(5, options.length) / 2);
      const index = selectedIndex + distance;
      return { option: options[(index + options.length) % options.length], distance };
    });
  }, [options, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  function choose(next: string) {
    if (value === undefined) setInternal(next);
    onChange?.(next);
  }

  function move(direction: number) {
    if (!options.length) return;
    choose(options[(selectedIndex + direction + options.length) % options.length].value);
  }

  return (
    <div className={`option-wheel-select${open ? " is-open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="option-wheel-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((currentOpen) => !currentOpen)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); move(1); setOpen(true); }
          if (event.key === "ArrowUp") { event.preventDefault(); move(-1); setOpen(true); }
          if (event.key === "Escape") setOpen(false);
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen((currentOpen) => !currentOpen); }
        }}
        onWheel={(event) => { event.preventDefault(); move(event.deltaY > 0 ? 1 : -1); }}
      >
        <span className={selected ? "" : "option-wheel-placeholder"}>{selected?.label ?? placeholder}</span>
        <span className="option-wheel-chevron" aria-hidden>⌄</span>
      </button>
      {name && <input type="hidden" name={name} value={current} />}
      {open && (
        <div className="option-wheel-menu" role="listbox" aria-label={ariaLabel}>
          <div className="option-wheel-rail" />
          {visible.map(({ option, distance }) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === current}
              className={`option-wheel-option${option.value === current ? " selected" : ""}`}
              style={{ opacity: distance === 0 ? 1 : Math.max(.28, 1 - Math.abs(distance) * .22), transform: `scale(${distance === 0 ? 1 : .94})` }}
              key={option.value}
              onClick={() => { choose(option.value); setOpen(false); }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
