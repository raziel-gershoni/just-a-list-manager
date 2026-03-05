"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { resolveLocale, type SupportedLocale } from "@/src/lib/i18n";
import enMessages from "@/messages/en.json";
import heMessages from "@/messages/he.json";
import ruMessages from "@/messages/ru.json";

declare global {
  interface Window {
    Telegram?: {
      Login: {
        auth: (
          options: { client_id: string },
          callback: (result: false | { id_token: string }) => void
        ) => void;
      };
    };
  }
}

const allMessages: Record<SupportedLocale, typeof enMessages> = {
  en: enMessages,
  he: heMessages,
  ru: ruMessages,
};

function LoginContent() {
  const t = useTranslations();
  const router = useRouter();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sdkReady, setSdkReady] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem("web_auth_token");
    if (token) {
      router.replace("/");
      return;
    }

    // Load Telegram Login SDK
    const script = document.createElement("script");
    script.src = "https://oauth.telegram.org/js/telegram-login.js";
    script.async = true;
    script.onload = () => setSdkReady(true);
    script.onerror = () => setError(true);
    document.head.appendChild(script);

    return () => {
      document.head.removeChild(script);
    };
  }, [router]);

  const handleLogin = useCallback(() => {
    if (!window.Telegram?.Login) {
      setError(true);
      return;
    }

    setError(false);
    setLoading(true);

    window.Telegram.Login.auth(
      { client_id: process.env.NEXT_PUBLIC_BOT_ID! },
      async (result) => {
        if (!result) {
          setLoading(false);
          // User cancelled — not an error
          return;
        }

        try {
          const res = await fetch("/api/auth/telegram-login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id_token: result.id_token }),
          });

          if (!res.ok) {
            setError(true);
            setLoading(false);
            return;
          }

          const { token } = await res.json();
          localStorage.setItem("web_auth_token", token);
          router.replace("/");
        } catch {
          setError(true);
          setLoading(false);
        }
      }
    );
  }, [router]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6">
      <div className="text-center max-w-sm">
        <h1 className="text-3xl font-bold text-foreground mb-2">
          {t("login.title")}
        </h1>
        <p className="text-muted-foreground mb-8">{t("login.subtitle")}</p>

        <button
          onClick={handleLogin}
          disabled={!sdkReady || loading}
          className="inline-flex items-center gap-2 px-6 py-3 rounded-lg text-white font-medium text-base disabled:opacity-50"
          style={{ backgroundColor: "#54a9eb" }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="w-5 h-5"
          >
            <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z" />
          </svg>
          {loading ? t("login.loading") : t("login.button")}
        </button>

        {error && (
          <p className="text-sm text-destructive mt-2">{t("login.error")}</p>
        )}
      </div>
    </div>
  );
}

export default function LoginPage() {
  const [locale, setLocale] = useState<SupportedLocale>("en");

  useEffect(() => {
    try {
      const cached = localStorage.getItem("app_locale");
      if (cached && (["en", "he", "ru"] as string[]).includes(cached)) {
        setLocale(cached as SupportedLocale);
      } else {
        setLocale(resolveLocale(navigator.language));
      }
    } catch {
      // ignore
    }
  }, []);

  return (
    <NextIntlClientProvider locale={locale} messages={allMessages[locale]}>
      <LoginContent />
    </NextIntlClientProvider>
  );
}
