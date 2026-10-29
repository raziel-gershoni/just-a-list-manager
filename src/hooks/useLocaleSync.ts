"use client";

import { useState, useCallback } from "react";
import { isRtl, type SupportedLocale } from "@/src/lib/i18n";
import { throwIfNotOk } from "@/src/utils/http";

export function useLocaleSync(jwtRef: React.RefObject<string | null>) {
  const [locale, setLocale] = useState<SupportedLocale>("en");

  const applyLocale = useCallback((lang: SupportedLocale) => {
    setLocale(lang);
    document.documentElement.dir = isRtl(lang) ? "rtl" : "ltr";
    document.documentElement.lang = lang;
    try {
      localStorage.setItem("app_locale", lang);
    } catch (err) {
      console.warn("[LocaleSync] Could not cache locale in localStorage:", err);
    }
  }, []);

  // Applies the language at once, then saves it. Resolves false when it was not saved.
  const setLanguage = useCallback(
    async (lang: SupportedLocale): Promise<boolean> => {
      applyLocale(lang);
      const token = jwtRef.current;
      if (!token) {
        console.warn("[LocaleSync] No session token, language not saved:", { lang });
        return false;
      }
      try {
        const res = await fetch("/api/user", {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ language: lang }),
        });
        throwIfNotOk(res, "Language save");
        return true;
      } catch (e) {
        console.error("[LocaleSync] Language save failed:", { lang }, e);
        return false;
      }
    },
    [applyLocale, jwtRef]
  );

  return { locale, applyLocale, setLanguage };
}
