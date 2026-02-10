"use client";

import { useTranslations } from "next-intl";
import { ChevronRight, Users, Pencil, Trash2 } from "lucide-react";

interface ListCardProps {
  id: string;
  name: string;
  activeCount: number;
  completedCount: number;
  isShared: boolean;
  role: "owner" | "view" | "edit";
  onClick: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

export default function ListCard({
  name,
  activeCount,
  completedCount,
  isShared,
  onClick,
  onEdit,
  onDelete,
}: ListCardProps) {
  const t = useTranslations('lists');
  const total = activeCount + completedCount;

  return (
    <button
      onClick={onClick}
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
        {onEdit && (
          <span
            role="button"
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="p-1.5 rounded-lg active:bg-tg-secondary-bg transition-colors"
          >
            <Pencil className="w-3.5 h-3.5 text-tg-hint" />
          </span>
        )}
        {onDelete && (
          <span
            role="button"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="p-1.5 rounded-lg active:bg-tg-secondary-bg transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5 text-tg-hint" />
          </span>
        )}
        {isShared && (
          <Users className="w-4 h-4 text-tg-hint" />
        )}
        <ChevronRight className="w-5 h-5 text-tg-hint" />
      </div>
    </button>
  );
}
