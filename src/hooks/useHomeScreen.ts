"use client";

import { useState, useCallback } from "react";

export type HomeScreenStatus = "unsupported" | "unknown" | "added" | "missed" | null;

export function useHomeScreen() {
  const [homeScreenStatus, setHomeScreenStatus] = useState<HomeScreenStatus>(null);

  const addToHomeScreen = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tg = (window as unknown as Record<string, any>).Telegram?.WebApp;
    if (tg?.addToHomeScreen) {
      tg.addToHomeScreen();
    }
  }, []);

  return { homeScreenStatus, setHomeScreenStatus, addToHomeScreen };
}
