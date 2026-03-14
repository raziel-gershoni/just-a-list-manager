"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
} from "react";
import { useRouter } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { createBrowserClient } from "@/src/lib/supabase";
import { resolveLocale, type SupportedLocale } from "@/src/lib/i18n";
import type { SupabaseClient } from "@supabase/supabase-js";
import enMessages from "@/messages/en.json";
import heMessages from "@/messages/he.json";
import ruMessages from "@/messages/ru.json";

import { useJWTRefresh } from "@/src/hooks/useJWTRefresh";
import { useLocaleSync } from "@/src/hooks/useLocaleSync";
import { useHomeScreen } from "@/src/hooks/useHomeScreen";
import { useReconnectOrchestrator } from "@/src/hooks/useReconnectOrchestrator";

// Re-export types for backward compatibility
export type { ConnectionStatus } from "@/src/hooks/useReconnectOrchestrator";
export type { HomeScreenStatus } from "@/src/hooks/useHomeScreen";

// Import types for use in this file
import type { ConnectionStatus } from "@/src/hooks/useReconnectOrchestrator";
import type { HomeScreenStatus } from "@/src/hooks/useHomeScreen";

const allMessages: Record<SupportedLocale, typeof enMessages> = {
  en: enMessages,
  he: heMessages,
  ru: ruMessages,
};

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

// --- Context ---

interface TelegramContextType {
  user: TelegramUser | null;
  userId: string | null;
  initData: string | null;
  jwt: string | null;
  jwtRef: React.RefObject<string | null>;
  locale: SupportedLocale;
  setLanguage: (lang: SupportedLocale) => Promise<void>;
  supabaseClient: SupabaseClient | null;
  supabaseClientRef: React.RefObject<SupabaseClient | null>;
  isReady: boolean;
  connectionStatus: ConnectionStatus;
  reconnect: () => void;
  retryCount: number;
  homeScreenStatus: HomeScreenStatus;
  addToHomeScreen: () => void;
  onFlushNeededRef: React.MutableRefObject<(() => Promise<void>) | null>;
  onResubscribeNeededRef: React.MutableRefObject<(() => Promise<void>) | null>;
  onRefreshNeededRef: React.MutableRefObject<(() => Promise<void>) | null>;
}

const TelegramContext = createContext<TelegramContextType>({
  user: null,
  userId: null,
  initData: null,
  jwt: null,
  jwtRef: { current: null },
  locale: "en",
  setLanguage: async () => {},
  supabaseClient: null,
  supabaseClientRef: { current: null },
  isReady: false,
  connectionStatus: "connecting",
  reconnect: () => {},
  retryCount: 0,
  homeScreenStatus: null,
  addToHomeScreen: () => {},
  onFlushNeededRef: { current: null },
  onResubscribeNeededRef: { current: null },
  onRefreshNeededRef: { current: null },
});

export function useTelegram() {
  return useContext(TelegramContext);
}

// --- Provider ---

export default function TelegramProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [user, setUser] = useState<TelegramUser | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [initData, setInitData] = useState<string | null>(null);
  const [supabaseClient, setSupabaseClient] =
    useState<SupabaseClient | null>(null);
  const [isReady, setIsReady] = useState(false);

  const router = useRouter();
  const supabaseClientRef = useRef<SupabaseClient | null>(null);

  // Callback refs for page registration
  const onFlushNeededRef = useRef<(() => Promise<void>) | null>(null);
  const onResubscribeNeededRef = useRef<(() => Promise<void>) | null>(null);
  const onRefreshNeededRef = useRef<(() => Promise<void>) | null>(null);

  // Track whether we're running as a web app (no Telegram WebApp)
  const isWebAppRef = useRef(false);

  // --- Extracted hooks ---
  const { jwt, jwtRef, fetchToken, clearJwt } = useJWTRefresh();
  const { locale, applyLocale, setLanguage } = useLocaleSync(jwtRef);
  const { homeScreenStatus, setHomeScreenStatus, addToHomeScreen } =
    useHomeScreen();

  // Stable heartbeat callback ref (avoids stale closures on client recreation)
  const runReconnectRef_local = useRef<() => void>(() => {});
  const stableHeartbeatCallback = useCallback(
    (status: string) => {
      if (status === "timeout" || status === "disconnected") {
        runReconnectRef_local.current();
      }
    },
    []
  );

  const recreateSupabaseClient = useCallback(
    (token: string) => {
      const oldClient = supabaseClientRef.current;
      if (oldClient) {
        oldClient.realtime.disconnect();
        oldClient.removeAllChannels();
      }
      const newClient = createBrowserClient(token, stableHeartbeatCallback);
      supabaseClientRef.current = newClient;
      setSupabaseClient(newClient);
    },
    [stableHeartbeatCallback]
  );

  const {
    connectionStatus,
    retryCount,
    reconnect,
    runReconnectRef,
    setOrchestratorState,
  } = useReconnectOrchestrator({
    fetchToken,
    clearJwt,
    jwtRef,
    recreateSupabaseClient,
    isWebAppRef,
    onFlushNeededRef,
    onResubscribeNeededRef,
    onRefreshNeededRef,
    router,
  });

  // Keep heartbeat ref in sync with orchestrator's runReconnectRef
  runReconnectRef_local.current = runReconnectRef.current;
  // Also keep them pointing to the same function going forward
  useEffect(() => {
    runReconnectRef_local.current = runReconnectRef.current;
  });

  // === Bootstrap Effect ===
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tg = (window as unknown as Record<string, any>).Telegram?.WebApp;
    // In a regular browser, Telegram.WebApp exists (script loaded) but initData is empty
    const isTelegramMiniApp = tg && tg.initData;
    if (!isTelegramMiniApp) {
      isWebAppRef.current = true;

      // Web app flow: check for stored JWT
      const storedToken = localStorage.getItem("web_auth_token");
      if (!storedToken) {
        router.push("/login");
        return;
      }

      // Try to refresh the stored JWT
      jwtRef.current = storedToken;
      (async () => {
        const token = await fetchToken(null); // Bearer refresh path
        if (!token) {
          // Stored token invalid/expired — redirect to login
          localStorage.removeItem("web_auth_token");
          jwtRef.current = null;
          router.push("/login");
          return;
        }

        // Persist refreshed token
        localStorage.setItem("web_auth_token", token);
        recreateSupabaseClient(token);

        // Fetch user info via JWT (user was already upserted during login)
        try {
          const userRes = await fetch("/api/user", {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (userRes.ok) {
            const userData = await userRes.json();
            if (userData?.id) setUserId(userData.id);
            if (userData?.language) {
              const serverLocale = resolveLocale(userData.language);
              applyLocale(serverLocale);
            }
            if (userData?.first_name) {
              setUser({
                id: userData.telegram_id,
                first_name: userData.first_name,
                last_name: userData.last_name,
                username: userData.username,
              });
            }
          }
        } catch (e) {
          console.error("[TelegramProvider] Web user registration error:", e);
        }

        // Apply locale from localStorage
        try {
          const cached = localStorage.getItem("app_locale");
          if (cached && ["en", "he", "ru"].includes(cached)) {
            applyLocale(cached as SupportedLocale);
          }
        } catch {}

        setIsReady(true);
        setOrchestratorState("idle");
      })();
      return;
    }

    tg.ready();
    tg.expand();

    const rawInitData = tg.initData;
    const userData = tg.initDataUnsafe?.user;

    if (rawInitData) setInitData(rawInitData);
    if (userData) {
      setUser(userData);
      try {
        const cached = localStorage.getItem("app_locale");
        if (cached && ["en", "he", "ru"].includes(cached)) {
          applyLocale(cached as SupportedLocale);
        } else {
          const resolved = resolveLocale(userData.language_code);
          applyLocale(resolved);
        }
      } catch {
        const resolved = resolveLocale(userData.language_code);
        applyLocale(resolved);
      }
    }

    // Apply Telegram theme colors as CSS custom properties
    if (tg.themeParams) {
      const root = document.documentElement;
      const themeMap: Record<string, string> = {
        bg_color: "--tg-theme-bg-color",
        text_color: "--tg-theme-text-color",
        hint_color: "--tg-theme-hint-color",
        link_color: "--tg-theme-link-color",
        button_color: "--tg-theme-button-color",
        button_text_color: "--tg-theme-button-text-color",
        secondary_bg_color: "--tg-theme-secondary-bg-color",
        header_bg_color: "--tg-theme-header-bg-color",
        section_bg_color: "--tg-theme-section-bg-color",
        section_header_text_color: "--tg-theme-section-header-text-color",
        subtitle_text_color: "--tg-theme-subtitle-text-color",
        destructive_text_color: "--tg-theme-destructive-text-color",
      };

      for (const [key, cssVar] of Object.entries(themeMap)) {
        if (tg.themeParams[key]) {
          root.style.setProperty(cssVar, tg.themeParams[key]);
        }
      }

      if (tg.colorScheme === "dark") {
        root.classList.add("dark");
      }
    }

    // Fetch JWT and setup
    (async () => {
      const token = await fetchToken(rawInitData);
      if (token) {
        recreateSupabaseClient(token);
      }

      // Register user (uses initData for TelegramUser fields)
      if (rawInitData) {
        try {
          const userRes = await fetch("/api/user", {
            method: "POST",
            headers: { "x-telegram-init-data": rawInitData },
          });
          if (userRes.ok) {
            const userData2 = await userRes.json();
            if (userData2?.id) setUserId(userData2.id);
            // Server-stored language is authoritative
            if (userData2?.language) {
              const serverLocale = resolveLocale(userData2.language);
              applyLocale(serverLocale);
            }
          }
        } catch (e) {
          console.error("[TelegramProvider] User registration error:", e);
        }
      }

      // Handle deep link for invites
      const startParam = tg.initDataUnsafe?.start_param;
      if (startParam?.startsWith("invite_")) {
        const inviteToken = startParam.replace("invite_", "");
        if (!window.location.pathname.startsWith("/invite/")) {
          router.push(`/invite/${inviteToken}`);
        }
      }

      setIsReady(true);
      setOrchestratorState("idle");

      // Check home screen status (Telegram Bot API 8.0+)
      if (tg.checkHomeScreenStatus) {
        const validStatuses = new Set(["unsupported", "unknown", "added", "missed"]);
        tg.checkHomeScreenStatus((status: string) => {
          if (validStatuses.has(status)) {
            setHomeScreenStatus(status as HomeScreenStatus);
          }
        });
      }
    })();

    // Listen for home screen added event
    const handleHomeScreenAdded = () => {
      setHomeScreenStatus("added");
    };
    tg.onEvent?.("homeScreenAdded", handleHomeScreenAdded);

    return () => {
      tg.offEvent?.("homeScreenAdded", handleHomeScreenAdded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <TelegramContext.Provider
      value={{
        user,
        userId,
        initData,
        jwt,
        jwtRef,
        locale,
        setLanguage,
        supabaseClient,
        supabaseClientRef,
        isReady,
        connectionStatus,
        reconnect,
        retryCount,
        homeScreenStatus,
        addToHomeScreen,
        onFlushNeededRef,
        onResubscribeNeededRef,
        onRefreshNeededRef,
      }}
    >
      <NextIntlClientProvider locale={locale} messages={allMessages[locale]}>
        {children}
      </NextIntlClientProvider>
    </TelegramContext.Provider>
  );
}
