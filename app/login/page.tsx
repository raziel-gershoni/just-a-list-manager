"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { resolveLocale, type SupportedLocale } from "@/src/lib/i18n";
import enMessages from "@/messages/en.json";
import heMessages from "@/messages/he.json";
import ruMessages from "@/messages/ru.json";

const OIDC_ORIGIN = "https://oauth.telegram.org";
const BOT_ID = process.env.NEXT_PUBLIC_BOT_ID!;

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
  const popupRef = useRef<Window | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("web_auth_token");
    if (token) {
      router.replace("/");
    }
  }, [router]);

  const handleResult = useCallback(
    async (idToken: string) => {
      try {
        const res = await fetch("/api/auth/telegram-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id_token: idToken }),
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
    },
    [router]
  );

  const handleLogin = useCallback(() => {
    setError(false);
    setLoading(true);

    const redirectUri = location.origin + location.pathname;
    const authUrl =
      OIDC_ORIGIN +
      "/auth?response_type=post_message" +
      "&client_id=" + encodeURIComponent(BOT_ID) +
      "&redirect_uri=" + encodeURIComponent(redirectUri) +
      "&origin=" + encodeURIComponent(location.origin) +
      "&scope=" + encodeURIComponent("openid profile");

    const width = 550;
    const height = 650;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = screen as any;
    const left = Math.max(0, (screen.width - width) / 2) + (s.availLeft || 0);
    const top = Math.max(0, (screen.height - height) / 2) + (s.availTop || 0);
    const features = `width=${width},height=${height},left=${left},top=${top},status=0,location=0,menubar=0,toolbar=0`;

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== OIDC_ORIGIN) return;
      if (popupRef.current && event.source !== popupRef.current) return;

      let data;
      try {
        data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }

      if (data?.event !== "auth_result") return;

      window.removeEventListener("message", onMessage);

      if (data.error || !data.result || typeof data.result !== "string") {
        setError(true);
        setLoading(false);
        return;
      }

      handleResult(data.result);
    };

    window.addEventListener("message", onMessage);

    popupRef.current = window.open(authUrl, "telegram_oidc_login", features);

    if (popupRef.current) {
      popupRef.current.focus();

      const checkClose = () => {
        if (!popupRef.current || popupRef.current.closed) {
          window.removeEventListener("message", onMessage);
          setLoading(false);
          return;
        }
        setTimeout(checkClose, 200);
      };
      checkClose();
    } else {
      window.removeEventListener("message", onMessage);
      setError(true);
      setLoading(false);
    }
  }, [handleResult]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6">
      <div className="text-center max-w-sm">
        <h1 className="text-3xl font-bold text-foreground mb-2">
          {t("login.title")}
        </h1>
        <p className="text-muted-foreground mb-8">{t("login.subtitle")}</p>

        <button
          onClick={handleLogin}
          disabled={loading}
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
