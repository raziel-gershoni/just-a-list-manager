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
      <div className="w-24 h-24 rounded-full bg-tg-secondary-bg flex items-center justify-center mb-6">
        <ListPlus className="w-12 h-12 text-tg-hint" />
      </div>
      <h2 className="text-xl font-semibold text-tg-text mb-2">
        {t('emptyTitle')}
      </h2>
      <p className="text-tg-hint mb-8 max-w-xs">
        {t('emptyDescription')}
      </p>
      <button
        onClick={onCreateList}
        className="bg-tg-button text-tg-button-text px-6 py-3 rounded-xl font-medium text-base active:opacity-80 transition-opacity"
      >
        {t('emptyButton')}
      </button>
    </div>
  );
}
