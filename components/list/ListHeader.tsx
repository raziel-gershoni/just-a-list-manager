"use client";

import { ArrowLeft, Send, Share2, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

interface ListHeaderProps {
  listName: string;
  isShared: boolean;
  onRemind: () => void;
  onShare: () => void;
}

export default function ListHeader({ listName, isShared, onRemind, onShare }: ListHeaderProps) {
  const router = useRouter();
  const t = useTranslations();

  return (
    <header className="flex items-center gap-3 p-4 pb-0">
      <button onClick={() => router.push("/")} className="p-1">
        <ArrowLeft className="w-5 h-5 text-tg-text rtl:scale-x-[-1]" />
      </button>
      <div className="flex-1 min-w-0">
        <h1 className="text-lg font-bold text-tg-text truncate">{listName}</h1>
        {isShared && (
          <p className="text-xs text-tg-hint flex items-center gap-1">
            <Users className="w-3 h-3" />
            {t('lists.shared')}
          </p>
        )}
      </div>
      {isShared && (
        <button onClick={onRemind} className="p-1">
          <Send className="w-5 h-5 text-tg-hint" />
        </button>
      )}
      <button onClick={onShare} className="p-1">
        <Share2 className="w-5 h-5 text-tg-hint" />
      </button>
    </header>
  );
}
