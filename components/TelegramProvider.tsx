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
import { removeAllChannelsLogged } from "@/src/lib/realtime-cleanup";
import { resolveLocale, type SupportedLocale } from "@/src/lib/i18n";
import type { SupabaseClient } from "@supabase/supabase-js";
import enMessages from "@/messages/en.json";
import heMessages from "@/messages/he.json";
import ruMessages from "@/messages/ru.json";

import { useJWTRefresh, isInitDataFresh, readStoredToken, readTokenClaims } from "@/src/hooks/useJWTRefresh";
import { useLocaleSync } from "@/src/hooks/useLocaleSync";
import { useHomeScreen } from "@/src/hooks/useHomeScreen";
import { useReconnectOrchestrator, MAX_RETRIES } from "@/src/hooks/useReconnectOrchestrator";

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
  /** Resolves false when the language could not be saved (it stays applied on screen). */
  setLanguage: (lang: SupportedLocale) => Promise<boolean>;
  supabaseClient: SupabaseClient | null;
  supabaseClientRef: React.RefObject<SupabaseClient | null>;
  /** The session has settled: a JWT exists, or the sign-in gave up (refused, or out of retries). */
  isReady: boolean;
  connectionStatus: ConnectionStatus;
  reconnect: () => void;
  /** An API call answered 401: reconnect with a token refresh, whatever the token's age. */
  requestTokenRefresh: () => void;
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
  setLanguage: async () => false,
  supabaseClient: null,
  supabaseClientRef: { current: null },
  isReady: false,
  connectionStatus: "connecting",
  reconnect: () => {},
  requestTokenRefresh: () => {},
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
  const [bootstrapped, setBootstrapped] = useState(false);

  const router = useRouter();
  const supabaseClientRef = useRef<SupabaseClient | null>(null);
  // The token the realtime client was last given.
  const realtimeTokenRef = useRef<string | null>(null);
  // Set on unmount: an in-flight reconnect or a late heartbeat must not revive a client.
  const unmountedRef = useRef(false);
  // The user record is loaded once per session.
  const userLoadedRef = useRef(false);

  // Callback refs for page registration
  const onFlushNeededRef = useRef<(() => Promise<void>) | null>(null);
  const onResubscribeNeededRef = useRef<(() => Promise<void>) | null>(null);
  const onRefreshNeededRef = useRef<(() => Promise<void>) | null>(null);

  // Track whether we're running as a web app (no Telegram WebApp)
  const isWebAppRef = useRef(false);

  // --- Extracted hooks ---
  const { jwt, jwtRef, fetchToken, setToken, clearJwt } = useJWTRefresh(isWebAppRef);
  const { locale, applyLocale, setLanguage } = useLocaleSync(jwtRef);
  const { homeScreenStatus, setHomeScreenStatus, addToHomeScreen } =
    useHomeScreen();

  // Stable heartbeat callback ref (avoids stale closures on client recreation)
  const runReconnectRef_local = useRef<() => void>(() => {});
  const stableHeartbeatCallback = useCallback(
    (status: string) => {
      if (unmountedRef.current) return;
      if (status === "timeout" || status === "disconnected") {
        runReconnectRef_local.current();
      }
    },
    []
  );

  // The realtime client follows the session: while its socket is up it is kept and given a
  // new token; it is replaced only when the socket is down.
  const syncRealtime = useCallback(
    (token: string) => {
      if (unmountedRef.current) return;
      const client = supabaseClientRef.current;
      if (client?.realtime.isConnected()) {
        if (realtimeTokenRef.current !== token) {
          realtimeTokenRef.current = token;
          client.realtime.setAuth(token).catch((err) => {
            console.warn("[TelegramProvider] Realtime token update failed:", err);
          });
        }
        return;
      }
      if (client) {
        client.realtime.disconnect();
        removeAllChannelsLogged(client);
      }
      const newClient = createBrowserClient(token, stableHeartbeatCallback);
      realtimeTokenRef.current = token;
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
    startSession,
    requestTokenRefresh,
  } = useReconnectOrchestrator({
    fetchToken,
    clearJwt,
    jwtRef,
    syncRealtime,
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

      // Apply dark mode from device preference
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
        document.documentElement.classList.add("dark");
      } else {
        document.documentElement.classList.remove("dark");
      }

      // Web app flow: the login stored a JWT
      const storedToken = readStoredToken(true);
      if (!storedToken) {
        router.push("/login");
        return;
      }

      setToken(storedToken);

      // Apply locale from localStorage
      try {
        const cached = localStorage.getItem("app_locale");
        if (cached && ["en", "he", "ru"].includes(cached)) {
          applyLocale(cached as SupportedLocale);
        }
      } catch (err) {
        console.warn("[TelegramProvider] Could not read cached locale from localStorage:", err);
      }

      // Checks the stored JWT with the server (only a refusal goes to /login)
      (async () => {
        await startSession();
        setBootstrapped(true);
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
      } catch (err) {
        console.warn("[TelegramProvider] Locale cache unavailable, falling back to Telegram language_code:", err);
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

    // A reload of this tab (Telegram "Reload page") finds its JWT in sessionStorage, if it
    // belongs to the same Telegram user, and signs in with it instead of the launch initData.
    const storedToken = readStoredToken(false);
    if (storedToken && userData?.id && readTokenClaims(storedToken)?.telegram_user_id === userData.id) {
      setToken(storedToken);
    }

    // Sign in, then setup
    (async () => {
      await startSession();

      // Handle deep link for invites
      const startParam = tg.initDataUnsafe?.start_param;
      if (startParam?.startsWith("invite_")) {
        const inviteToken = startParam.replace("invite_", "");
        if (!window.location.pathname.startsWith("/invite/")) {
          router.push(`/invite/${inviteToken}`);
        }
      }

      setBootstrapped(true);

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

  // Settled once the bootstrap ran and a JWT exists or the sign-in gave up, so a screen
  // waits through the retries and loads (or shows its error) when they end.
  const isReady =
    bootstrapped && (jwt !== null || connectionStatus === "auth_failed" || retryCount >= MAX_RETRIES);

  // Who the user is, once per session and once a JWT exists. The Mini App registers with its
  // initData while that is fresh (a new user gets their Telegram language); otherwise, and on
  // the web, the JWT identifies the user.
  const loadUser = useCallback(
    async (token: string) => {
      const register = !isWebAppRef.current && !!initData && isInitDataFresh(initData);
      try {
        const userRes = register
          ? await fetch("/api/user", { method: "POST", headers: { "x-telegram-init-data": initData! } })
          : await fetch("/api/user", { headers: { Authorization: `Bearer ${token}` } });
        if (!userRes.ok) {
          console.error(
            register ? "[TelegramProvider] User registration failed:" : "[TelegramProvider] User load failed:",
            { status: userRes.status }
          );
          return;
        }
        const userData = await userRes.json();
        if (userData?.id) setUserId(userData.id);
        // Server-stored language is authoritative. Language is user-controlled via the
        // language sheet — never overwrite it from Telegram's language_code, since unsupported
        // codes (e.g. "en-US") would be normalized to "en" by resolveLocale and clobber the
        // user's explicit choice.
        if (userData?.language) applyLocale(resolveLocale(userData.language));
        // The Mini App has its user from initDataUnsafe; the web app only from this record.
        if (isWebAppRef.current && userData?.first_name) {
          setUser({
            id: userData.telegram_id,
            first_name: userData.first_name,
            last_name: userData.last_name,
            username: userData.username,
          });
        }
      } catch (e) {
        console.error("[TelegramProvider] User load error:", { register }, e);
      }
    },
    [initData, applyLocale]
  );

  useEffect(() => {
    if (!isReady || !jwt || userLoadedRef.current) return;
    userLoadedRef.current = true;
    void loadUser(jwt);
  }, [isReady, jwt, loadUser]);

  // Unmount (leaving the signed-in screens): close the socket, so its heartbeat can't
  // reconnect a provider that is gone.
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      const client = supabaseClientRef.current;
      supabaseClientRef.current = null;
      if (client) {
        client.realtime.disconnect();
        removeAllChannelsLogged(client);
      }
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
        requestTokenRefresh,
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
