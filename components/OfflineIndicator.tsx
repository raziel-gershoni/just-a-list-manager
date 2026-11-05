"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { WifiOff, RefreshCw, AlertTriangle } from "lucide-react";
import { useTelegram } from "@/components/TelegramProvider";

// A reconnect runs on every return to the app, started by the focus that the user's first tap
// brings, and whatever it shows appears in that same moment. If the list moved then, the row
// under the finger changed before the tap was delivered and iOS dropped it. So:
// - "Syncing…" lasts about a second: it floats over the top of the rows and takes no room.
//   Taps pass through it. Above the rows and the sticky Completed header (z-20), below the
//   add input (z-30) and its suggestions.
// - "Connection problems" and "Session expired" stay up: they take their room in the page,
//   so they never cover a row. A reconnect started over one of them keeps that room, with
//   "Syncing…" in it, until connected, so the swap never moves the list either.
export default function OfflineIndicator() {
  const { connectionStatus, retryCount, reconnect } = useTelegram();
  const t = useTranslations('common');

  const lasting = connectionStatus === "auth_failed" || (connectionStatus === "connecting" && retryCount >= 5);
  const [keepRoom, setKeepRoom] = useState(lasting);
  if (lasting && !keepRoom) setKeepRoom(true);
  if (connectionStatus === "connected" && keepRoom) setKeepRoom(false);

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

  const syncing = (
    <>
      <RefreshCw className="w-3.5 h-3.5 text-tg-hint animate-spin" />
      <span className="text-xs text-tg-hint">{t('syncing')}</span>
    </>
  );

  if (keepRoom) {
    return (
      <div role="status" className="flex items-center justify-center gap-2 py-2 px-4 bg-tg-secondary-bg/70">
        {syncing}
      </div>
    );
  }

  return (
    <div className="relative z-[25] h-0">
      <div className="pointer-events-none absolute inset-x-0 top-1.5 flex justify-center">
        <div role="status" className="flex items-center gap-1.5 py-1.5 px-3 rounded-full bg-tg-section-bg border border-border/50 shadow-lg shadow-black/8 dark:shadow-black/25 motion-safe:animate-in motion-safe:fade-in duration-200">
          {syncing}
        </div>
      </div>
    </div>
  );
}
