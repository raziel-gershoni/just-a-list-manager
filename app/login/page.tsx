"use client";

import { useEffect, useState } from "react";
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

  useEffect(() => {
    const token = localStorage.getItem("web_auth_token");
    if (token) {
      router.replace("/");
    }
  }, [router]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6">
      <div className="text-center max-w-sm">
        <h1 className="text-3xl font-bold text-foreground mb-2">
          {t("login.title")}
        </h1>
        <p className="text-muted-foreground mb-8">{t("login.subtitle")}</p>

        <a
          href="https://t.me/justalistmanagerbot"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-6 py-3 rounded-lg text-white font-medium text-base"
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
          {t("login.button")}
        </a>
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
