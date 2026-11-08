"use client";

import type { ReactNode } from "react";

// An on/off row: the whole row is the switch (44px+ target), the knob moves the right way in RTL.
// Used by list settings (Sort into categories) and the item sheet (On the way, Recurring).
export default function SwitchRow({ label, checked, onChange, icon }: {
  label: string;
  checked: boolean;
  onChange: () => void;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className="w-full min-h-11 flex items-center justify-between gap-3 py-3 px-4 rounded-2xl bg-tg-secondary-bg text-tg-text font-medium text-start active:scale-[0.98]"
    >
      <span className="flex items-center gap-3 min-w-0">
        {icon}
        <span className="min-w-0">{label}</span>
      </span>
      <span
        aria-hidden="true"
        className={`relative inline-flex h-7 w-12 shrink-0 rounded-full motion-safe:transition-colors ${checked ? "bg-tg-button" : "bg-tg-hint/50"}`}
      >
        <span
          className={`absolute top-0.5 start-0.5 h-6 w-6 rounded-full bg-white shadow-sm motion-safe:transition-transform ${checked ? "translate-x-5 rtl:-translate-x-5" : ""}`}
        />
      </span>
    </button>
  );
}
