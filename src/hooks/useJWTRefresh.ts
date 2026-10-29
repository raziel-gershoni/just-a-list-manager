"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { readTokenClaims } from "@/src/lib/token-claims";

/** How a token request ended. Only "unauthorized" means the server refused the credential. */
export type TokenResult = { kind: "ok"; token: string } | { kind: "unauthorized" } | { kind: "transient" };

// The web app keeps its login across visits. The Mini App keeps its JWT for the tab session
// only: a Telegram "Reload page" reuses the launch initData, which the server refuses after
// 5 minutes, so the reload must take the bearer path.
const WEB_TOKEN_KEY = "web_auth_token";
const MINI_APP_TOKEN_KEY = "tg_auth_token";

// The server refuses initData older than this (src/lib/telegram-auth.ts).
const INIT_DATA_MAX_AGE_MS = 5 * 60 * 1000;

/** Whether initData is still young enough, by its auth_date, for the server to accept it. */
export function isInitDataFresh(initData: string, now = Date.now()): boolean {
  const authDate = Number(new URLSearchParams(initData).get("auth_date"));
  return authDate > 0 && now - authDate * 1000 < INIT_DATA_MAX_AGE_MS;
}

/** Milliseconds since the JWT was issued, or Infinity when that can't be read. */
export function tokenAgeMs(token: string, now = Date.now()): number {
  const iat = readTokenClaims(token)?.iat;
  return typeof iat === "number" ? now - iat * 1000 : Infinity;
}

const tokenStorage = (isWebApp: boolean) => (isWebApp ? localStorage : sessionStorage);
const tokenKey = (isWebApp: boolean) => (isWebApp ? WEB_TOKEN_KEY : MINI_APP_TOKEN_KEY);

/** The token stored by an earlier visit (web) or an earlier load of this tab (Mini App). */
export function readStoredToken(isWebApp: boolean): string | null {
  try {
    return tokenStorage(isWebApp).getItem(tokenKey(isWebApp));
  } catch (err) {
    console.warn("[TelegramProvider] Could not read the stored token:", { isWebApp }, err);
    return null;
  }
}

export function useJWTRefresh(isWebAppRef: React.RefObject<boolean>) {
  const [jwt, setJwt] = useState<string | null>(null);
  const jwtRef = useRef<string | null>(null);
  // Set on unmount. A token request still in flight then (a reconnect, a pending refresh)
  // must not write the token back: on the web, logout removes it and unmounts the provider.
  const disposedRef = useRef(false);
  useEffect(() => {
    disposedRef.current = false; // a Strict Mode remount runs the cleanup first
    return () => {
      disposedRef.current = true;
    };
  }, []);

  // Adopts a token: in memory for requests, in state for screens that wait on it, and in
  // storage so the next load starts from it.
  const setToken = useCallback(
    (token: string) => {
      jwtRef.current = token;
      setJwt(token);
      const isWebApp = isWebAppRef.current;
      try {
        tokenStorage(isWebApp).setItem(tokenKey(isWebApp), token);
      } catch (err) {
        console.warn("[TelegramProvider] Could not store the token:", { isWebApp }, err);
      }
    },
    [isWebAppRef]
  );

  const fetchToken = useCallback(
    async (initDataStr: string | null): Promise<TokenResult> => {
      const headers: Record<string, string> = {};
      let mode: "bearer" | "initData";
      if (jwtRef.current) {
        headers["Authorization"] = `Bearer ${jwtRef.current}`;
        mode = "bearer";
      } else if (initDataStr) {
        headers["x-telegram-init-data"] = initDataStr;
        mode = "initData";
      } else {
        return { kind: "unauthorized" }; // nothing to sign in with
      }

      let res: Response;
      try {
        res = await fetch("/api/auth/token", { headers });
      } catch (e) {
        console.error("[TelegramProvider] Token fetch error:", { mode }, e);
        return { kind: "transient" };
      }
      if (!res.ok) {
        // The mode and status only: the token and initData are credentials.
        console.warn("[TelegramProvider] Token request failed:", { mode, status: res.status });
        // Only a 401 refuses the credential. A 429, a 5xx or a proxy error may pass on retry.
        return res.status === 401 ? { kind: "unauthorized" } : { kind: "transient" };
      }
      try {
        const { token } = await res.json();
        if (typeof token !== "string" || !token) throw new Error("No token in the answer");
        if (disposedRef.current) {
          console.warn("[TelegramProvider] Token arrived after sign-out, not stored:", { mode });
          return { kind: "ok", token };
        }
        setToken(token);
        return { kind: "ok", token };
      } catch (e) {
        console.error("[TelegramProvider] Token answer unreadable:", { mode }, e);
        return { kind: "transient" };
      }
    },
    [setToken]
  );

  // Only for a token the server refused: drops it from memory and from storage.
  const clearJwt = useCallback(() => {
    jwtRef.current = null;
    setJwt(null);
    const isWebApp = isWebAppRef.current;
    try {
      tokenStorage(isWebApp).removeItem(tokenKey(isWebApp));
    } catch (err) {
      console.warn("[TelegramProvider] Could not remove the stored token:", { isWebApp }, err);
    }
  }, [isWebAppRef]);

  return { jwt, jwtRef, fetchToken, setToken, clearJwt };
}
