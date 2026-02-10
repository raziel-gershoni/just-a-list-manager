"use client";

import { useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import { ChevronRight, Users } from "lucide-react";

interface ListCardProps {
  id: string;
  name: string;
  activeCount: number;
  completedCount: number;
  isShared: boolean;
  role: "owner" | "view" | "edit";
  onClick: () => void;
  onLongPress?: () => void;
}

export default function ListCard({
  name,
  activeCount,
  completedCount,
  isShared,
  onClick,
  onLongPress,
}: ListCardProps) {
  const t = useTranslations('lists');
  const total = activeCount + completedCount;

  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const didLongPress = useRef(false);

  const clearTimer = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!onLongPress) return;
      didLongPress.current = false;
      const touch = e.touches[0];
      touchStart.current = { x: touch.clientX, y: touch.clientY };
      longPressTimer.current = setTimeout(() => {
        didLongPress.current = true;
        const tg = (window as any).Telegram?.WebApp;
        tg?.HapticFeedback?.impactOccurred("medium");
        onLongPress();
      }, 500);
    },
    [onLongPress]
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!touchStart.current) return;
      const touch = e.touches[0];
      const dx = touch.clientX - touchStart.current.x;
      const dy = touch.clientY - touchStart.current.y;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        clearTimer();
      }
    },
    [clearTimer]
  );

  const handleTouchEnd = useCallback(() => {
    clearTimer();
  }, [clearTimer]);

  const handleClick = useCallback(() => {
    if (didLongPress.current) {
      didLongPress.current = false;
      return;
    }
    onClick();
  }, [onClick]);

  return (
    <button
      onClick={handleClick}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onContextMenu={(e) => e.preventDefault()}
      className="w-full bg-tg-section-bg rounded-xl p-4 flex items-center gap-3 active:opacity-80 transition-opacity text-start"
    >
      <div className="flex-1 min-w-0">
        <h3 className="font-medium text-tg-text truncate">{name}</h3>
        <p className="text-sm text-tg-hint mt-0.5">
          {completedCount > 0
            ? t('activeCount', { active: activeCount, total })
            : `${activeCount}`}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {isShared && (
          <Users className="w-4 h-4 text-tg-hint" />
        )}
        <ChevronRight className="w-5 h-5 text-tg-hint" />
      </div>
    </button>
  );
}
