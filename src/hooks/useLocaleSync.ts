"use client";

import { useState, useCallback } from "react";
import { isRtl, type SupportedLocale } from "@/src/lib/i18n";

export function useLocaleSync(jwtRef: React.RefObject<string | null>) {
  const [locale, setLocale] = useState<SupportedLocale>("en");

  const applyLocale = useCallback((lang: SupportedLocale) => {
    setLocale(lang);
    document.documentElement.dir = isRtl(lang) ? "rtl" : "ltr";
    document.documentElement.lang = lang;
    try {
      localStorage.setItem("app_locale", lang);
    } catch {}
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
    [applyLocale, jwtRef]
  );

  return { locale, applyLocale, setLanguage };
}
