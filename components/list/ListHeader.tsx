"use client";

import { ArrowLeft, Send, Settings, Share2, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

interface ListHeaderProps {
  listName: string;
  isShared: boolean;
  onRemind: () => void;
  onShare: () => void;
  onSettings: () => void;
}

export default function ListHeader({ listName, isShared, onRemind, onShare, onSettings }: ListHeaderProps) {
  const router = useRouter();
  const t = useTranslations();

  return (
    <header className="flex items-center gap-3 px-5 py-4 pb-2">
      <button onClick={() => router.push("/")} className="p-2 rounded-full active:bg-tg-secondary-bg">
        <ArrowLeft className="w-5 h-5 text-tg-text rtl:scale-x-[-1]" />
      </button>
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
