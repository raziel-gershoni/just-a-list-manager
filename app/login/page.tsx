"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { resolveLocale, type SupportedLocale } from "@/src/lib/i18n";
import enMessages from "@/messages/en.json";
import heMessages from "@/messages/he.json";
import ruMessages from "@/messages/ru.json";

const allMessages: Record<SupportedLocale, typeof enMessages> = {
  en: enMessages,
  he: heMessages,
  ru: ruMessages,
};

function LoginContent() {
  const t = useTranslations();
  const router = useRouter();
  const widgetRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  // If user already has a valid token, redirect to home
  useEffect(() => {
    const token = localStorage.getItem("web_auth_token");
    if (token) {
      router.replace("/");
    }
  }, [router]);

  const handleTelegramAuth = useCallback(
    async (authData: Record<string, unknown>) => {
      setError(false);
      setLoading(true);
      try {
        const res = await fetch("/api/auth/telegram-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(authData),
        });
        if (res.ok) {
          const { token } = await res.json();
          localStorage.setItem("web_auth_token", token);
          router.replace("/");
        } else {
          setError(true);
        }
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    },
    [router]
  );

  // Mount Telegram Login Widget
  useEffect(() => {
    const botUsername = process.env.NEXT_PUBLIC_BOT_USERNAME;
    if (!botUsername || !widgetRef.current) return;

    // Expose callback globally for the widget
    (window as any).__onTelegramAuth = handleTelegramAuth;

    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.async = true;
    script.setAttribute("data-telegram-login", botUsername);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-radius", "8");
    script.setAttribute("data-onauth", "__onTelegramAuth(user)");

    widgetRef.current.innerHTML = "";
    widgetRef.current.appendChild(script);

    return () => {
      delete (window as any).__onTelegramAuth;
    };
  }, [handleTelegramAuth]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6">
      <div className="text-center max-w-sm">
        <h1 className="text-3xl font-bold text-foreground mb-2">
          {t("login.title")}
        </h1>
        <p className="text-muted-foreground mb-8">{t("login.subtitle")}</p>

        <div ref={widgetRef} className="flex justify-center mb-4" />

        {loading && (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        )}
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
