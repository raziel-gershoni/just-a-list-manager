"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
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

function CallbackContent() {
  const t = useTranslations();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function handleCallback() {
      const code = searchParams.get("code");
      const state = searchParams.get("state");

      if (!code || !state) {
        setError(t("login.callbackError"));
        return;
      }

      const savedState = sessionStorage.getItem("oauth_state");
      const codeVerifier = sessionStorage.getItem("oauth_code_verifier");

      if (!savedState || state !== savedState) {
        setError(t("login.callbackStateMismatch"));
        return;
      }

      if (!codeVerifier) {
        setError(t("login.callbackError"));
        return;
      }

      try {
        const response = await fetch("/api/auth/telegram-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, code_verifier: codeVerifier }),
        });

        if (!response.ok) {
          throw new Error("Exchange failed");
        }

        const { token } = await response.json();
        localStorage.setItem("web_auth_token", token);
        sessionStorage.removeItem("oauth_state");
        sessionStorage.removeItem("oauth_code_verifier");
        window.location.href = "/";
      } catch {
        setError(t("login.callbackError"));
      }
    }

    handleCallback();
  }, [searchParams, t]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-6">
        <div className="text-center max-w-sm">
          <p className="text-foreground mb-4">{error}</p>
          <Link
            href="/login"
            className="text-[#54a9eb] font-medium hover:underline"
          >
            {t("login.backToLogin")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6">
      <p className="text-muted-foreground">{t("login.callbackLoading")}</p>
    </div>
  );
}

export default function CallbackPage() {
  const [locale, setLocale] = useState<SupportedLocale>("en");

  useEffect(() => {
    let resolved: SupportedLocale | null = null;
    try {
      const cached = localStorage.getItem("app_locale");
      if (cached && (["en", "he", "ru"] as string[]).includes(cached)) {
        resolved = cached as SupportedLocale;
      } else {
        resolved = resolveLocale(navigator.language);
      }
    } catch {
      // ignore
    }
    if (resolved) setLocale(resolved);
  }, []);

  return (
    <NextIntlClientProvider locale={locale} messages={allMessages[locale]}>
      <Suspense>
        <CallbackContent />
      </Suspense>
    </NextIntlClientProvider>
  );
}
