"use client";

import { useTranslations } from "next-intl";
import { WifiOff, RefreshCw, AlertTriangle } from "lucide-react";
import { useTelegram } from "@/components/TelegramProvider";

export default function OfflineIndicator() {
  const { connectionStatus, retryCount, reconnect } = useTelegram();
  const t = useTranslations('common');

  if (connectionStatus === "connected") return null;

  if (connectionStatus === "auth_failed") {
    return (
      <div className="flex items-center justify-center gap-2 py-2 px-4 bg-red-50 dark:bg-red-950/40">
        <AlertTriangle className="w-3.5 h-3.5 text-red-600 dark:text-red-400" />
        <span className="text-xs text-red-600 dark:text-red-400">{t('sessionExpired')}</span>
      </div>
    );
  }

  // connectionStatus === "connecting"
  if (retryCount >= 5) {
    return (
      <button
        onClick={reconnect}
        className="flex items-center justify-center gap-2 py-2 px-4 bg-tg-secondary-bg/70 w-full"
      >
        <WifiOff className="w-3.5 h-3.5 text-tg-hint" />
        <span className="text-xs text-tg-hint">{t('connectionProblems')}</span>
      </button>
    );
  }

  return (
    <div className="flex items-center justify-center gap-2 py-2 px-4 bg-tg-secondary-bg/70">
      <RefreshCw className="w-3.5 h-3.5 text-tg-hint animate-spin" />
      <span className="text-xs text-tg-hint">{t('syncing')}</span>
    </div>
  );
}
