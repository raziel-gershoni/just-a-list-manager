"use client";

import { useTranslations } from "next-intl";
import { Check } from "lucide-react";
import { createElement, type CSSProperties } from "react";
import {
  LIST_ICON_NAMES,
  LIST_COLORS,
  LIST_ICONS,
  resolveColor,
  defaultIconFor,
  type ListIconName,
  type ListColor,
  type ListType,
} from "@/src/lib/list-icons";

interface IconColorPickerProps {
  icon: ListIconName | null;
  color: ListColor | null;
  type: ListType;
  onChange: (icon: ListIconName, color: ListColor) => void;
}

export default function IconColorPicker({ icon, color, type, onChange }: IconColorPickerProps) {
  const t = useTranslations("lists");
  const selectedIconName: ListIconName = icon ?? defaultIconFor(type);
  const selectedColor: ListColor = resolveColor(color, type);
  const accent = `var(--list-${selectedColor})`;

  return (
    <div className="mb-4">
      <p className="text-[12px] font-medium tracking-wide text-tg-hint mb-2 uppercase">
        {t("icon")}
      </p>
      <div className="grid grid-cols-4 gap-2 mb-4">
        {LIST_ICON_NAMES.map((name) => {
          const active = name === selectedIconName;
          const style: CSSProperties = active
            ? {
                background: `color-mix(in oklab, ${accent} 14%, transparent)`,
                boxShadow: `inset 0 0 0 2px ${accent}`,
                color: accent,
              }
            : { color: "var(--foreground)" };
          return (
            <button
              key={name}
              type="button"
              onClick={() => onChange(name, selectedColor)}
              className={`aspect-square rounded-xl flex items-center justify-center transition-all active:scale-95 ${
                active ? "" : "bg-tg-secondary-bg"
              }`}
              style={style}
              aria-label={name}
              aria-pressed={active}
            >
              {createElement(LIST_ICONS[name], { className: "w-5 h-5", strokeWidth: active ? 2.5 : 2 })}
            </button>
          );
        })}
      </div>

      <p className="text-[12px] font-medium tracking-wide text-tg-hint mb-2 uppercase">
        {t("color")}
      </p>
      <div className="flex items-center justify-between gap-2">
        {LIST_COLORS.map((c) => {
          const isActive = c === selectedColor;
          const dotAccent = `var(--list-${c})`;
          return (
            <button
              key={c}
              type="button"
              onClick={() => onChange(selectedIconName, c)}
              className="relative w-9 h-9 rounded-full flex items-center justify-center transition-transform active:scale-90"
              style={{
                background: dotAccent,
                boxShadow: isActive
                  ? `0 0 0 2px var(--background), 0 0 0 4px ${dotAccent}`
                  : undefined,
              }}
              aria-label={c}
              aria-pressed={isActive}
            >
              {isActive && <Check className="w-4 h-4 text-white" strokeWidth={3} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
