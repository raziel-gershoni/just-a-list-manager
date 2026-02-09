"use client";

import { useTranslations } from "next-intl";
import { WifiOff, RefreshCw } from "lucide-react";

interface OfflineIndicatorProps {
  status: "connected" | "connecting" | "offline";
}

export default function OfflineIndicator({ status }: OfflineIndicatorProps) {
  const t = useTranslations('common');

  if (status === "connected") return null;

  return (
    <div className="flex items-center justify-center gap-2 py-1.5 px-3 bg-tg-secondary-bg">
      {status === "offline" ? (
        <>
          <WifiOff className="w-3.5 h-3.5 text-tg-hint" />
          <span className="text-xs text-tg-hint">{t('offline')}</span>
        </>
      ) : (
        <>
          <RefreshCw className="w-3.5 h-3.5 text-tg-hint animate-spin" />
          <span className="text-xs text-tg-hint">{t('syncing')}</span>
        </>
      )}
    </div>
  );
}
