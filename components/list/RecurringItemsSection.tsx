"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Repeat, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { getTelegramWebApp } from "@/src/types/telegram";
import type { ItemData } from "@/src/types";

interface RecurringItemsSectionProps {
  recurringItems: ItemData[];
  showRecurring: boolean;
  setShowRecurring: React.Dispatch<React.SetStateAction<boolean>>;
  onRestoreRecurring: (id: string) => void;
  onToggleRecurring: (id: string, recurring: boolean) => void;
}

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

export default function RecurringItemsSection({
  recurringItems,
  showRecurring,
  setShowRecurring,
  onRestoreRecurring,
  onToggleRecurring,
}: RecurringItemsSectionProps) {
  const t = useTranslations();
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const formatReturnsIn = (anchorIso: string | null): string => {
    if (!anchorIso) return "";
    const elapsed = now - new Date(anchorIso).getTime();
    const remainingMs = FOUR_HOURS_MS - elapsed;
    if (remainingMs <= 0) return t("items.recurring.returningSoon");
    const minutes = Math.ceil(remainingMs / 60000);
    if (minutes < 60) return t("items.recurring.returnsInMinutes", { count: minutes });
    const hours = Math.ceil(minutes / 60);
    return t("items.recurring.returnsInHours", { count: hours });
  };

  if (recurringItems.length === 0) return null;

  return (
    <>
      <button
        onClick={() => setShowRecurring((p) => { localStorage.setItem("panel_recurring", String(!p)); return !p; })}
        className="flex items-center gap-2.5 w-full px-5 py-3.5 text-[13px] font-medium tracking-wide text-tg-hint bg-tg-secondary-bg/80 backdrop-blur-md border-t border-separator"
      >
        {showRecurring ? (
          <ChevronDown className="w-4 h-4" />
        ) : (
          <ChevronRight className="w-4 h-4 rtl:scale-x-[-1]" />
        )}
        <Repeat className="w-3.5 h-3.5 text-amber-500" strokeWidth={3} />
        {t("items.recurring.section", { count: recurringItems.length })}
      </button>
      {showRecurring && (
        <div className="item-enter">
          {recurringItems.map((item) => {
            const anchor = item.completed_at ?? item.deleted_at ?? null;
            return (
              <div
                key={item.id}
                className="flex items-center gap-3 py-3.5 px-5 border-b border-separator"
              >
                <div className="flex-1 min-w-0 opacity-70">
                  <div className="truncate text-tg-text">{item.text}</div>
                  <p className="text-[11px] text-tg-hint tracking-wide truncate">
                    {formatReturnsIn(anchor)}
                  </p>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const tg = getTelegramWebApp();
                    tg?.HapticFeedback?.impactOccurred("light");
                    onToggleRecurring(item.id, false);
                  }}
                  className="p-1.5 rounded-full shrink-0 transition-transform duration-150 active:scale-90"
                  aria-label={t("items.recurring.toggleOff")}
                >
                  <Repeat
                    className="w-[18px] h-[18px] text-amber-500"
                    strokeWidth={3}
                  />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const tg = getTelegramWebApp();
                    tg?.HapticFeedback?.impactOccurred("medium");
                    onRestoreRecurring(item.id);
                  }}
                  className="p-1.5 rounded-full shrink-0 transition-transform duration-150 active:scale-90"
                  aria-label={t("items.recurring.restore")}
                >
                  <RotateCcw
                    className="w-[18px] h-[18px] text-tg-link"
                    strokeWidth={2.5}
                  />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
