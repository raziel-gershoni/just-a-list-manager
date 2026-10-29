"use client";

import { useState, useCallback, useRef } from "react";

export function useJWTRefresh() {
  const [jwt, setJwt] = useState<string | null>(null);
  const jwtRef = useRef<string | null>(null);

  const fetchToken = useCallback(
    async (initDataStr: string | null): Promise<string | null> => {
      try {
        const headers: Record<string, string> = {};
        let mode: "bearer" | "initData";
        if (jwtRef.current) {
          headers["Authorization"] = `Bearer ${jwtRef.current}`;
          mode = "bearer";
        } else if (initDataStr) {
          headers["x-telegram-init-data"] = initDataStr;
          mode = "initData";
        } else {
          return null;
        }

        const res = await fetch("/api/auth/token", { headers });
        if (!res.ok) {
          // The mode and status only: the token and initData are credentials.
          console.warn("[TelegramProvider] Token request failed:", { mode, status: res.status });
          return null;
        }
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

  const clearJwt = useCallback(() => {
    jwtRef.current = null;
    setJwt(null);
  }, []);

  return { jwt, jwtRef, fetchToken, clearJwt };
}
