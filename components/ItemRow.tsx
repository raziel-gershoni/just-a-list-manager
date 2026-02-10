"use client";

import { useState, useRef } from "react";
import { Check, Clock, Trash2 } from "lucide-react";

interface ItemRowProps {
  id: string;
  text: string;
  completed: boolean;
  isPending?: boolean;
  onToggle: (id: string, completed: boolean) => void;
  onDelete: (id: string) => void;
}

export default function ItemRow({
  id,
  text,
  completed,
  isPending,
  onToggle,
  onDelete,
}: ItemRowProps) {
  const [swiped, setSwiped] = useState(false);
  const touchStartX = useRef(0);

  const handleToggle = () => {
    const tg = (window as any).Telegram?.WebApp;
    tg?.HapticFeedback?.impactOccurred("light");
    onToggle(id, !completed);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const deltaX = e.changedTouches[0].clientX - touchStartX.current;
    const isRtl = document.documentElement.dir === "rtl";
    const revealDelta = isRtl ? 60 : -60;
    const dismissDelta = isRtl ? -30 : 30;

    // Swipe toward the end edge to reveal delete
    if (isRtl ? deltaX > revealDelta : deltaX < revealDelta) {
      setSwiped(true);
    } else if (isRtl ? deltaX < dismissDelta : deltaX > dismissDelta) {
      setSwiped(false);
    }
  };

  return (
    <div className="relative overflow-hidden">
      {/* Delete button behind — only rendered when swiped */}
      {swiped && (
        <div className="absolute inset-y-0 end-0 flex items-center">
          <button
            onClick={() => onDelete(id)}
            className="bg-tg-destructive text-white h-full px-5 flex items-center"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Main row */}
      <div
        className={`flex items-center gap-3 py-3 px-4 bg-tg-bg transition-all ${
          swiped ? "pe-14" : ""
        }`}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onClick={() => swiped && setSwiped(false)}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleToggle();
          }}
          className={`w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
            completed
              ? "bg-tg-button border-tg-button"
              : "border-tg-hint"
          }`}
        >
          {completed && <Check className="w-4 h-4 text-tg-button-text" />}
        </button>

        <span
          className={`flex-1 min-w-0 truncate ${
            completed ? "line-through text-tg-hint" : "text-tg-text"
          } ${isPending ? "opacity-60" : ""}`}
        >
          {text}
        </span>

        {isPending && (
          <Clock className="w-4 h-4 text-tg-hint shrink-0" />
        )}
      </div>
    </div>
  );
}
