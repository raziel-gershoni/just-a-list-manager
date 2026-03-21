"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { resolveLocale, type SupportedLocale } from "@/src/lib/i18n";
import {
  generateCodeVerifier,
  computeCodeChallenge,
  generateState,
} from "@/src/lib/pkce";
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

  useEffect(() => {
    const token = localStorage.getItem("web_auth_token");
    if (token) {
      router.replace("/");
    }
  }, [router]);

  async function handleTelegramLogin() {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await computeCodeChallenge(codeVerifier);
    const state = generateState();

    sessionStorage.setItem("oauth_code_verifier", codeVerifier);
    sessionStorage.setItem("oauth_state", state);

    const botId = process.env.NEXT_PUBLIC_BOT_ID;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;

    const params = new URLSearchParams({
      client_id: botId!,
      redirect_uri: `${appUrl}/login/callback`,
      response_type: "code",
      scope: "openid profile",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    window.location.href = `https://oauth.telegram.org/auth?${params.toString()}`;
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6">
      <div className="text-center max-w-sm">
        <h1 className="text-3xl font-bold text-foreground mb-2">
          {t("login.title")}
        </h1>
        <p className="text-muted-foreground mb-8">{t("login.subtitle")}</p>

        <button
          onClick={handleTelegramLogin}
          className="inline-flex items-center gap-2 px-6 py-3 rounded-lg text-white font-medium text-base cursor-pointer"
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
          {t("login.loginWithTelegram")}
        </button>

        <p className="text-muted-foreground text-sm mt-6">
          {t("login.orOpenBot")}{" "}
          <a
            href="https://t.me/justalistmanagerbot"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#54a9eb] hover:underline"
          >
            @justalistmanagerbot
          </a>
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initializing locale from localStorage on mount
    if (resolved) setLocale(resolved);
  }, []);

  return (
    <NextIntlClientProvider locale={locale} messages={allMessages[locale]}>
      <LoginContent />
    </NextIntlClientProvider>
  );
}
