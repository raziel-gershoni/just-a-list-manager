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

interface TelegramContextType {
  user: TelegramUser | null;
  userId: string | null;
  initData: string | null;
  locale: SupportedLocale;
  supabaseClient: SupabaseClient | null;
  isReady: boolean;
  jwt: string | null;
}

const TelegramContext = createContext<TelegramContextType>({
  user: null,
  userId: null,
  initData: null,
  locale: "en",
  supabaseClient: null,
  isReady: false,
  jwt: null,
});

export function useTelegram() {
  return useContext(TelegramContext);
}

export default function TelegramProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [user, setUser] = useState<TelegramUser | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [initData, setInitData] = useState<string | null>(null);
  const [locale, setLocale] = useState<SupportedLocale>("en");
  const [supabaseClient, setSupabaseClient] = useState<SupabaseClient | null>(
    null
  );
  const [isReady, setIsReady] = useState(false);
  const [jwt, setJwt] = useState<string | null>(null);
  const router = useRouter();
  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const jwtRef = useRef<string | null>(null);

  const fetchToken = useCallback(
    async (initDataStr: string | null) => {
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

  useEffect(() => {
    const tg = (window as any).Telegram?.WebApp;
    if (!tg) {
      setIsReady(true);
      return;
    }

    tg.ready();
    tg.expand();

    const rawInitData = tg.initData;
    const userData = tg.initDataUnsafe?.user;

    if (rawInitData) setInitData(rawInitData);
    if (userData) {
      setUser(userData);
      const resolved = resolveLocale(userData.language_code);
      setLocale(resolved);

      // Set RTL direction
      document.documentElement.dir = isRtl(resolved) ? "rtl" : "ltr";
      document.documentElement.lang = resolved;
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

      // Apply dark class if needed
      if (tg.colorScheme === "dark") {
        root.classList.add("dark");
      }
    }

    // Fetch JWT and setup Supabase client
    (async () => {
      const token = await fetchToken(rawInitData);
      if (token) {
        const client = createBrowserClient(token);
        setSupabaseClient(client);
      }

      // Register user
      if (rawInitData) {
        try {
          const userRes = await fetch("/api/user", {
            method: "POST",
            headers: { "x-telegram-init-data": rawInitData },
          });
          if (userRes.ok) {
            const userData2 = await userRes.json();
            if (userData2?.id) setUserId(userData2.id);
          }
        } catch (e) {
          console.error("[TelegramProvider] User registration error:", e);
        }
      }

      // Handle deep link for invites (before setIsReady to prevent unnecessary API calls)
      const startParam = tg.initDataUnsafe?.start_param;
      if (startParam?.startsWith("invite_")) {
        const inviteToken = startParam.replace("invite_", "");
        if (!window.location.pathname.startsWith("/invite/")) {
          router.push(`/invite/${inviteToken}`);
        }
      }

      setIsReady(true);
    })();

    // JWT refresh every 50 minutes
    refreshIntervalRef.current = setInterval(
      async () => {
        const newToken = await fetchToken(null);
        if (newToken) {
          // Remove old Realtime channels before creating new client
          setSupabaseClient((prev) => {
            if (prev) {
              prev.removeAllChannels();
            }
            return createBrowserClient(newToken);
          });
        }
      },
      50 * 60 * 1000
    );

    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
      }
    };
  }, [fetchToken]);

  return (
    <TelegramContext.Provider
      value={{ user, userId, initData, locale, supabaseClient, isReady, jwt }}
    >
      <NextIntlClientProvider locale={locale} messages={allMessages[locale]}>
        {children}
      </NextIntlClientProvider>
    </TelegramContext.Provider>
  );
}
