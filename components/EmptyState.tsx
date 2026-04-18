"use client";

import { useTranslations } from "next-intl";
import { ListPlus } from "lucide-react";

interface EmptyStateProps {
  onCreateList: () => void;
}

export default function EmptyState({ onCreateList }: EmptyStateProps) {
  const t = useTranslations('lists');
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 text-center">
      <div className="w-20 h-20 rounded-3xl bg-tg-secondary-bg/70 flex items-center justify-center mb-8">
        <ListPlus className="w-10 h-10 text-tg-hint/60" />
      </div>
      <h2 className="text-xl font-bold tracking-tight text-tg-text mb-2">
        {t('emptyTitle')}
      </h2>
      <p className="text-tg-hint/80 mb-10 max-w-[260px] text-[15px] leading-relaxed">
        {t('emptyDescription')}
      </p>
      <button
        onClick={onCreateList}
        className="bg-tg-button text-tg-button-text px-8 py-3.5 rounded-2xl font-medium text-base active:scale-[0.97]"
      >
        {t('emptyButton')}
      </button>
    </div>
  );
}
