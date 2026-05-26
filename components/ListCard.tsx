"use client";

import { useTranslations } from "next-intl";
import { ChevronRight, Users, Pencil, Trash2 } from "lucide-react";
import ListIcon from "@/components/ListIcon";
import {
  listAccentVar,
  type ListColor,
  type ListIconName,
  type ListType,
} from "@/src/lib/list-icons";

interface ListCardProps {
  id: string;
  name: string;
  type: ListType;
  icon: ListIconName | null;
  color: ListColor | null;
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
  type,
  icon,
  color,
  activeCount,
  completedCount,
  isShared,
  onClick,
  onEdit,
  onDelete,
}: ListCardProps) {
  const t = useTranslations('lists');
  const total = activeCount + completedCount;
  const accent = listAccentVar(color, type);

  return (
    <button
      onClick={onClick}
      className="w-full bg-tg-section-bg rounded-2xl px-5 py-4 flex items-center gap-3 active:scale-[0.98] transition-all duration-150 text-start border border-border/50"
    >
      <span
        className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center"
        style={{
          background: `color-mix(in oklab, ${accent} 14%, transparent)`,
          color: accent,
        }}
      >
        <ListIcon iconName={icon} type={type} className="w-5 h-5" strokeWidth={2.25} />
      </span>
      <div className="flex-1 min-w-0">
        <h3 className="font-semibold text-tg-text truncate">{name}</h3>
        <p className="text-[13px] text-tg-hint mt-1 tracking-wide">
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
            className="p-2 rounded-full active:bg-tg-secondary-bg transition-colors"
          >
            <Pencil className="w-4 h-4 text-tg-hint" />
          </span>
        )}
        {onDelete && (
          <span
            role="button"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="p-2 rounded-full active:bg-tg-secondary-bg transition-colors"
          >
            <Trash2 className="w-4 h-4 text-tg-hint" />
          </span>
        )}
        {isShared && (
          <Users className="w-4 h-4 text-tg-hint" />
        )}
        <ChevronRight className="w-4 h-4 text-tg-hint opacity-40 rtl:scale-x-[-1]" />
      </div>
    </button>
  );
}
