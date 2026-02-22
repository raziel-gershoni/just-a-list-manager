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
import { isRtl, resolveLocale, type SupportedLocale } from "@/src/lib/i18n";
import type { SupabaseClient } from "@supabase/supabase-js";
import enMessages from "@/messages/en.json";
import heMessages from "@/messages/he.json";
import ruMessages from "@/messages/ru.json";

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

// --- Orchestrator types ---

type OrchestratorState =
  | "initializing"
  | "idle"
  | "reconnecting"
  | "needs_retry"
  | "cooldown"
  | "auth_failed";

export type ConnectionStatus = "connecting" | "connected" | "auth_failed";

export type HomeScreenStatus = "unsupported" | "unknown" | "added" | "missed" | null;

function mapToConnectionStatus(state: OrchestratorState): ConnectionStatus {
  switch (state) {
    case "initializing":
    case "reconnecting":
    case "needs_retry":
      return "connecting";
    case "idle":
    case "cooldown":
      return "connected";
    case "auth_failed":
      return "auth_failed";
  }
}

const MAX_RETRIES = 5;
const COOLDOWN_MS = 5000;
const RETRY_DELAY_MS = 2000;
const RECONNECT_THROTTLE_MS = 5000; // Min interval between reconnect() calls from browser events
const PROACTIVE_REFRESH_MS = 45 * 60 * 1000; // 45 minutes

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
  onFlushNeeded: React.MutableRefObject<(() => Promise<void>) | null>;
  onResubscribeNeeded: React.MutableRefObject<(() => Promise<void>) | null>;
  onRefreshNeeded: React.MutableRefObject<(() => Promise<void>) | null>;
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
  onFlushNeeded: { current: null },
  onResubscribeNeeded: { current: null },
  onRefreshNeeded: { current: null },
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
  const [jwt, setJwt] = useState<string | null>(null);
  const [locale, setLocale] = useState<SupportedLocale>("en");
  const [supabaseClient, setSupabaseClient] =
    useState<SupabaseClient | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [retryCount, setRetryCount] = useState(0);
  const [homeScreenStatus, setHomeScreenStatus] =
    useState<HomeScreenStatus>(null);

  const router = useRouter();
  const jwtRef = useRef<string | null>(null);
  const supabaseClientRef = useRef<SupabaseClient | null>(null);
  const orchestratorStateRef = useRef<OrchestratorState>("initializing");
  const retryCountRef = useRef(0);
  const cooldownTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Callback refs for page registration
  const onFlushNeeded = useRef<(() => Promise<void>) | null>(null);
  const onResubscribeNeeded = useRef<(() => Promise<void>) | null>(null);
  const onRefreshNeeded = useRef<(() => Promise<void>) | null>(null);

  // Stable heartbeat callback ref (avoids stale closures on client recreation)
  const runReconnectRef = useRef<() => void>(() => {});
  // Ref for reconnect() (resets retryCount + forces idle) — used by browser event handlers
  const reconnectRef = useRef<() => void>(() => {});
  // Debounce: prevent retry storms on flapping networks
  const lastReconnectAttemptRef = useRef<number>(0);

  const setOrchestratorState = useCallback(
    (state: OrchestratorState) => {
      orchestratorStateRef.current = state;
      setConnectionStatus(mapToConnectionStatus(state));
    },
    []
  );

  const applyLocale = useCallback((lang: SupportedLocale) => {
    setLocale(lang);
    document.documentElement.dir = isRtl(lang) ? "rtl" : "ltr";
    document.documentElement.lang = lang;
    try {
      localStorage.setItem("app_locale", lang);
    } catch {}
  }, []);

  const fetchToken = useCallback(
    async (initDataStr: string | null): Promise<string | null> => {
      try {
        const headers: Record<string, string> = {};
        if (jwtRef.current) {
          headers["Authorization"] = `Bearer ${jwtRef.current}`;
        } else if (initDataStr) {
          headers["x-telegram-init-data"] = initDataStr;
        } else {
          return null;
        }

        const res = await fetch("/api/auth/token", { headers });
        if (!res.ok) return null;
        const { token } = await res.json();
        jwtRef.current = token;
        setJwt(token);
        return token;
      } catch (e) {
        console.error("[TelegramProvider] Token fetch error:", e);
        return null;
      }
    },
    []
  );

  // Stable heartbeat callback passed to createBrowserClient
  const stableHeartbeatCallback = useCallback(
    (status: string, _latency?: number) => {
      if (status === "timeout" || status === "disconnected") {
        runReconnectRef.current();
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

  // === Reconnect Orchestrator ===
  const reconnectLockRef = useRef(false);

  const runReconnect = useCallback(async () => {
    // Only proceed from idle state
    if (orchestratorStateRef.current !== "idle") return;
    // Mutex: prevent concurrent reconnect calls
    if (reconnectLockRef.current) return;
    reconnectLockRef.current = true;

    setOrchestratorState("reconnecting");

    try {
      // Step 1: Refresh JWT (try existing JWT first)
      let newToken = await fetchToken(null);
      if (!newToken) {
        // Clear expired JWT so initData path is used
        jwtRef.current = null;
        setJwt(null);
        // Fallback: re-read Telegram.WebApp.initData
        const tg = (window as any).Telegram?.WebApp;
        const freshInitData = tg?.initData;
        if (freshInitData) {
          newToken = await fetchToken(freshInitData);
        }
      }

      if (!newToken) {
        // Token failure is retriable (could be network error, not just auth failure).
        // Only go terminal after exhausting retries.
        retryCountRef.current++;
        setRetryCount(retryCountRef.current);

        if (retryCountRef.current >= MAX_RETRIES) {
          setOrchestratorState("auth_failed");
          return;
        }

        setOrchestratorState("needs_retry");
        if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = setTimeout(() => {
          orchestratorStateRef.current = "idle";
          runReconnectRef.current();
        }, RETRY_DELAY_MS);
        return;
      }

      // Recreate Supabase client with fresh token
      recreateSupabaseClient(newToken);

      // Step 2: Flush mutations (no-op if no list page mounted)
      if (onFlushNeeded.current) {
        await onFlushNeeded.current();
      }

      // Step 3: Resubscribe realtime (no-op if no list page mounted)
      if (onResubscribeNeeded.current) {
        await onResubscribeNeeded.current();
      }

      // Step 4: Refresh server state (home page or list page)
      if (onRefreshNeeded.current) {
        await onRefreshNeeded.current();
      }

      // Success — enter cooldown
      retryCountRef.current = 0;
      setRetryCount(0);
      setOrchestratorState("cooldown");
      cooldownTimeoutRef.current = setTimeout(() => {
        if (orchestratorStateRef.current === "cooldown") {
          setOrchestratorState("idle");
        }
      }, COOLDOWN_MS);
    } catch (error) {
      console.error("[Orchestrator] Partial failure:", error);
      retryCountRef.current++;
      setRetryCount(retryCountRef.current);

      if (retryCountRef.current >= MAX_RETRIES) {
        // Stop auto-retrying — UI will show manual retry banner
        setOrchestratorState("needs_retry");
        return;
      }

      setOrchestratorState("needs_retry");
      // Clear previous retry timeout to prevent orphaned timers
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
      retryTimeoutRef.current = setTimeout(() => {
        // Reset to idle so runReconnect can proceed
        orchestratorStateRef.current = "idle";
        runReconnectRef.current();
      }, RETRY_DELAY_MS);
    } finally {
      reconnectLockRef.current = false;
    }
  }, [fetchToken, recreateSupabaseClient, setOrchestratorState]);

  // Keep refs in sync for stable callbacks
  runReconnectRef.current = runReconnect;

  // Manual reconnect (works even when retryCount >= MAX_RETRIES)
  const reconnect = useCallback(() => {
    // If a reconnect is already in flight, don't interfere
    if (reconnectLockRef.current) return;
    // Clear any pending timers
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    if (cooldownTimeoutRef.current) {
      clearTimeout(cooldownTimeoutRef.current);
      cooldownTimeoutRef.current = null;
    }
    // Reset retry count
    retryCountRef.current = 0;
    setRetryCount(0);
    // Force state to idle so runReconnect proceeds
    orchestratorStateRef.current = "idle";
    runReconnect();
  }, [runReconnect]);

  // Keep reconnect ref in sync
  reconnectRef.current = reconnect;

  // Throttled reconnect for browser event handlers (online, visibilitychange).
  // Prevents retry storms when network flaps rapidly.
  const debouncedReconnect = useCallback(() => {
    const now = Date.now();
    if (now - lastReconnectAttemptRef.current < RECONNECT_THROTTLE_MS) return;
    lastReconnectAttemptRef.current = now;
    reconnectRef.current();
  }, []);

  const setLanguage = useCallback(
    async (lang: SupportedLocale) => {
      applyLocale(lang);
      const token = jwtRef.current;
      if (!token) return;
      try {
        await fetch("/api/user", {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ language: lang }),
        });
      } catch (e) {
        console.error("[TelegramProvider] Language update error:", e);
      }
    },
    [applyLocale]
  );

  const addToHomeScreen = useCallback(() => {
    const tg = (window as any).Telegram?.WebApp;
    if (tg?.addToHomeScreen) {
      tg.addToHomeScreen();
    }
  }, []);

  // === Bootstrap Effect ===
  useEffect(() => {
    const tg = (window as any).Telegram?.WebApp;
    if (!tg) {
      setIsReady(true);
      setOrchestratorState("idle");
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
          setLocale(cached as SupportedLocale);
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

  // === Entry Points Effect ===
  useEffect(() => {
    const handleOnline = () => {
      debouncedReconnect();
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        debouncedReconnect();
      }
    };

    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibility);

    // 45-minute proactive timer (ensures JWT never expires during stable use)
    const proactiveTimer = setInterval(() => {
      runReconnectRef.current();
    }, PROACTIVE_REFRESH_MS);

    return () => {
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
      clearInterval(proactiveTimer);
      if (cooldownTimeoutRef.current) clearTimeout(cooldownTimeoutRef.current);
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    };
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
        onFlushNeeded,
        onResubscribeNeeded,
        onRefreshNeeded,
      }}
    >
      <NextIntlClientProvider locale={locale} messages={allMessages[locale]}>
        {children}
      </NextIntlClientProvider>
    </TelegramContext.Provider>
  );
}
