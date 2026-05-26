"use client";

import { ArrowLeft, Send, Settings, Share2, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import ListIcon from "@/components/ListIcon";
import {
  listAccentVar,
  type ListColor,
  type ListIconName,
  type ListType,
} from "@/src/lib/list-icons";

interface ListHeaderProps {
  listName: string;
  listType: ListType;
  listIcon: ListIconName | null;
  listColor: ListColor | null;
  isShared: boolean;
  onRemind: () => void;
  onShare: () => void;
  onSettings: () => void;
}

export default function ListHeader({
  listName,
  listType,
  listIcon,
  listColor,
  isShared,
  onRemind,
  onShare,
  onSettings,
}: ListHeaderProps) {
  const router = useRouter();
  const t = useTranslations();
  const accent = listAccentVar(listColor, listType);

  return (
    <header className="flex items-center gap-3 px-5 py-4 pb-2">
      <button onClick={() => router.push("/")} className="p-2 rounded-full active:bg-tg-secondary-bg">
        <ArrowLeft className="w-5 h-5 text-tg-text rtl:scale-x-[-1]" />
      </button>
      <span
        className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center"
        style={{
          background: `color-mix(in oklab, ${accent} 14%, transparent)`,
          color: accent,
        }}
      >
        <ListIcon iconName={listIcon} type={listType} className="w-5 h-5" strokeWidth={2.25} />
      </span>
      <div className="flex-1 min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-tg-text truncate">{listName}</h1>
        {isShared && (
          <p className="text-[11px] tracking-wide text-tg-hint flex items-center gap-1.5">
            <Users className="w-3 h-3" />
            {t('lists.shared')}
          </p>
        )}
      </div>
      <button onClick={onSettings} className="p-2 rounded-full active:bg-tg-secondary-bg">
        <Settings className="w-5 h-5 text-tg-hint/80" />
      </button>
      {isShared && (
        <button onClick={onRemind} className="p-2 rounded-full active:bg-tg-secondary-bg">
          <Send className="w-5 h-5 text-tg-hint/80" />
        </button>
      )}
      <button onClick={onShare} className="p-2 rounded-full active:bg-tg-secondary-bg">
        <Share2 className="w-5 h-5 text-tg-hint/80" />
      </button>
    </header>
  );
}
