"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { isInitDataFresh, tokenAgeMs, type TokenResult } from "@/src/hooks/useJWTRefresh";

// --- Orchestrator types ---

type OrchestratorState =
  | "initializing"
  | "idle"
  | "reconnecting"
  | "needs_retry"
  | "cooldown"
  | "auth_failed";

export type ConnectionStatus = "connecting" | "connected" | "auth_failed";

export const MAX_RETRIES = 5;
const COOLDOWN_MS = 5000;
const RETRY_DELAY_MS = 2000;
const RECONNECT_THROTTLE_MS = 5000; // Min interval between reconnect() calls from browser events
const PROACTIVE_REFRESH_MS = 45 * 60 * 1000; // 45 minutes
// JWTs live 7 days (src/lib/jwt.ts), so a reconnect refreshes only a token older than a day.
const TOKEN_REFRESH_AGE_MS = 24 * 60 * 60 * 1000;

function mapToConnectionStatus(state: OrchestratorState): ConnectionStatus {
  switch (state) {
    case "initializing":
    case "reconnecting":
    case "needs_retry":
      return "connecting";
    case "idle":
    case "cooldown":
      return "connected";
    case "auth_failed":
      return "auth_failed";
  }
}

export function useReconnectOrchestrator(params: {
  fetchToken: (initData: string | null) => Promise<TokenResult>;
  clearJwt: () => void;
  jwtRef: React.RefObject<string | null>;
  syncRealtime: (token: string) => void;
  isWebAppRef: React.RefObject<boolean>;
  onFlushNeededRef: React.MutableRefObject<(() => Promise<void>) | null>;
  onResubscribeNeededRef: React.MutableRefObject<(() => Promise<void>) | null>;
  onRefreshNeededRef: React.MutableRefObject<(() => Promise<void>) | null>;
  router: ReturnType<typeof import("next/navigation").useRouter>;
}) {
  const {
    fetchToken,
    clearJwt,
    jwtRef,
    syncRealtime,
    isWebAppRef,
    onFlushNeededRef,
    onResubscribeNeededRef,
    onRefreshNeededRef,
    router,
  } = params;

  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [retryCount, setRetryCount] = useState(0);

  const orchestratorStateRef = useRef<OrchestratorState>("initializing");
  const retryCountRef = useRef(0);
  const cooldownTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const tokenRefreshTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectLockRef = useRef(false);
  const runReconnectRef = useRef<() => void>(() => {});
  const reconnectRef = useRef<() => void>(() => {});
  const lastReconnectAttemptRef = useRef<number>(0);
  // Set at launch and when an API call was refused: the next token step asks the server
  // whatever the token's age. Cleared once the server answered yes or no.
  const forceTokenRefreshRef = useRef(false);
  // Set when an API call was refused while a reconnect or the launch sign-in was running: it
  // may have asked for its token before the refusal, so one more refresh runs when it ends.
  const pendingTokenRefreshRef = useRef(false);
  // Set when reconnect() was asked for while a reconnect was running (a list channel the server
  // closed, whose replacement must not be lost): one more reconnect runs when that one ends.
  const pendingReconnectRef = useRef(false);

  const setOrchestratorState = useCallback(
    (state: OrchestratorState) => {
      orchestratorStateRef.current = state;
      setConnectionStatus(mapToConnectionStatus(state));
    },
    []
  );

  // A token to work with. The current one is kept while it is younger than a day; a failed
  // refresh keeps it too, and only a refusal (401) drops it. The Mini App then signs in again
  // with its initData: at launch whatever its age (the server's clock decides), later only
  // while it is younger than the server's 5-minute limit.
  const ensureToken = useCallback(
    async (atLaunch: boolean): Promise<TokenResult> => {
      const current = jwtRef.current;
      if (current && !forceTokenRefreshRef.current && tokenAgeMs(current) < TOKEN_REFRESH_AGE_MS) {
        return { kind: "ok", token: current };
      }
      let result: TokenResult = { kind: "unauthorized" };
      if (current) {
        result = await fetchToken(null);
        if (result.kind === "unauthorized") clearJwt();
      }
      if (result.kind === "unauthorized" && !isWebAppRef.current) {
        const initData = (window as unknown as { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp?.initData;
        if (initData && (atLaunch || isInitDataFresh(initData))) result = await fetchToken(initData);
      }
      if (result.kind !== "transient") forceTokenRefreshRef.current = false;
      return result;
    },
    [fetchToken, clearJwt, jwtRef, isWebAppRef]
  );

  // Every credential was refused: the web app goes to its login page, the Mini App shows
  // "Session expired" (only reopening it from Telegram brings fresh initData).
  const endSession = useCallback(() => {
    clearJwt();
    setOrchestratorState("auth_failed");
    if (isWebAppRef.current) router.push("/login");
  }, [clearJwt, setOrchestratorState, isWebAppRef, router]);

  // A failed attempt: retry after a delay, until MAX_RETRIES; then the banner offers a manual retry.
  const scheduleRetry = useCallback(() => {
    retryCountRef.current++;
    setRetryCount(retryCountRef.current);
    setOrchestratorState("needs_retry");
    if (retryCountRef.current >= MAX_RETRIES) return;
    // Clear previous retry timeout to prevent orphaned timers
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
    }
    retryTimeoutRef.current = setTimeout(() => {
      // Reset to idle so runReconnect can proceed
      orchestratorStateRef.current = "idle";
      runReconnectRef.current();
    }, RETRY_DELAY_MS);
  }, [setOrchestratorState]);

  // Runs the token refresh an API refusal asked for during the sign-in that just ended. A
  // retry that is due already refreshes it (the force flag stays set); an ended session drops it.
  const runPendingTokenRefresh = useCallback(() => {
    if (!pendingTokenRefreshRef.current) return;
    pendingTokenRefreshRef.current = false;
    const state = orchestratorStateRef.current;
    if (state === "auth_failed") return;
    forceTokenRefreshRef.current = true;
    if (state === "needs_retry") return;
    reconnectRef.current();
  }, []);

  // === Reconnect Orchestrator ===

  const runReconnect = useCallback(async () => {
    // Only proceed from idle state
    if (orchestratorStateRef.current !== "idle") return;
    // Mutex: prevent concurrent reconnect calls
    if (reconnectLockRef.current) return;
    reconnectLockRef.current = true;

    setOrchestratorState("reconnecting");

    try {
      // Step 1: a token (asks the server only when the current one is old or was refused)
      const token = await ensureToken(false);
      if (token.kind === "unauthorized") {
        endSession();
        return;
      }
      if (token.kind === "transient") throw new Error("Token request failed");

      // The realtime client: kept while its socket is up, replaced only when it is down
      syncRealtime(token.token);

      // Step 2: Flush mutations (no-op if no list page mounted)
      if (onFlushNeededRef.current) {
        await onFlushNeededRef.current();
      }

      // Step 3: Rejoin realtime if the channel is not joined (no-op if no list page mounted)
      if (onResubscribeNeededRef.current) {
        await onResubscribeNeededRef.current();
      }

      // Step 4: Refresh server state (home page or list page)
      if (onRefreshNeededRef.current) {
        await onRefreshNeededRef.current();
      }

      // Success — enter cooldown
      retryCountRef.current = 0;
      setRetryCount(0);
      setOrchestratorState("cooldown");
      cooldownTimeoutRef.current = setTimeout(() => {
        if (orchestratorStateRef.current === "cooldown") {
          setOrchestratorState("idle");
        }
      }, COOLDOWN_MS);
    } catch (error) {
      console.error("[Orchestrator] Partial failure:", error);
      scheduleRetry();
    } finally {
      reconnectLockRef.current = false;
      const reconnectAgain = pendingReconnectRef.current;
      pendingReconnectRef.current = false;
      runPendingTokenRefresh();
      // A token refresh above may have started its own reconnect, which covers this request;
      // a retry that is due, or an ended session, does too.
      const state = orchestratorStateRef.current as OrchestratorState; // widened: the checks above narrow the ref to "idle"
      if (reconnectAgain && !reconnectLockRef.current && state !== "needs_retry" && state !== "auth_failed") {
        reconnectRef.current();
      }
    }
  }, [ensureToken, endSession, syncRealtime, scheduleRetry, setOrchestratorState, runPendingTokenRefresh, onFlushNeededRef, onResubscribeNeededRef, onRefreshNeededRef]);

  // Keep refs in sync for stable callbacks
  runReconnectRef.current = runReconnect;

  // The bootstrap's sign-in. It always asks the server, so a stored token is checked rather
  // than trusted. A failure that may pass counts as the first attempt and hands over to the
  // reconnect retry and its backoff.
  const startSession = useCallback(async () => {
    forceTokenRefreshRef.current = true;
    const token = await ensureToken(true);
    if (token.kind === "ok") {
      syncRealtime(token.token);
      setOrchestratorState("idle");
    } else if (token.kind === "unauthorized") {
      endSession();
    } else {
      console.warn("[Orchestrator] Sign-in at launch failed, handing over to the retry");
      scheduleRetry();
    }
    runPendingTokenRefresh();
  }, [ensureToken, endSession, syncRealtime, scheduleRetry, setOrchestratorState, runPendingTokenRefresh]);

  // Manual reconnect (works even when retryCount >= MAX_RETRIES)
  const reconnect = useCallback(() => {
    // A reconnect is already in flight: it may have passed the step this request is about,
    // so one more runs when it ends.
    if (reconnectLockRef.current) {
      pendingReconnectRef.current = true;
      console.warn("[Orchestrator] Reconnect requested while one is running, it runs again when that one ends");
      return;
    }
    // The bootstrap is still signing in; it hands over to the retry itself.
    if (orchestratorStateRef.current === "initializing") return;
    // Clear any pending timers
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    if (cooldownTimeoutRef.current) {
      clearTimeout(cooldownTimeoutRef.current);
      cooldownTimeoutRef.current = null;
    }
    // Reset retry count
    retryCountRef.current = 0;
    setRetryCount(0);
    // Force state to idle so runReconnect proceeds
    orchestratorStateRef.current = "idle";
    runReconnect();
  }, [runReconnect]);

  // Keep reconnect ref in sync
  reconnectRef.current = reconnect;

  // Throttled reconnect for browser event handlers (online, visibilitychange).
  // Prevents retry storms when network flaps rapidly.
  const debouncedReconnect = useCallback(() => {
    const now = Date.now();
    if (now - lastReconnectAttemptRef.current < RECONNECT_THROTTLE_MS) return;
    lastReconnectAttemptRef.current = now;
    // Browser events don't queue a reconnect behind a running one; only reconnect() does.
    if (reconnectLockRef.current) return;
    reconnectRef.current();
  }, []);

  // An API call was refused with a 401: reconnect with a token refresh whatever the token's
  // age. Throttled like the browser events, so a run of refusals can't storm the token route;
  // a call inside the throttle window waits for it instead of being lost, and a call while a
  // sign-in is running waits for that to end.
  const requestTokenRefresh = useCallback(() => {
    forceTokenRefreshRef.current = true;
    const refreshNow = () => {
      if (reconnectLockRef.current || orchestratorStateRef.current === "initializing") {
        pendingTokenRefreshRef.current = true;
        return;
      }
      debouncedReconnect();
    };
    if (tokenRefreshTimeoutRef.current) return;
    const wait = lastReconnectAttemptRef.current + RECONNECT_THROTTLE_MS - Date.now();
    if (wait <= 0) {
      refreshNow();
      return;
    }
    tokenRefreshTimeoutRef.current = setTimeout(() => {
      tokenRefreshTimeoutRef.current = null;
      refreshNow();
    }, wait);
  }, [debouncedReconnect]);

  // === Entry Points Effect ===
  useEffect(() => {
    const handleOnline = () => {
      debouncedReconnect();
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        debouncedReconnect();
      }
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("focus", debouncedReconnect);
    document.addEventListener("visibilitychange", handleVisibility);

    // 45-minute proactive timer: flush, rejoin and refresh during stable use (the token is
    // refreshed once it is a day old)
    const proactiveTimer = setInterval(() => {
      runReconnectRef.current();
    }, PROACTIVE_REFRESH_MS);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("focus", debouncedReconnect);
      document.removeEventListener("visibilitychange", handleVisibility);
      clearInterval(proactiveTimer);
      if (cooldownTimeoutRef.current) clearTimeout(cooldownTimeoutRef.current);
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
      if (tokenRefreshTimeoutRef.current) clearTimeout(tokenRefreshTimeoutRef.current);
    };
  }, [debouncedReconnect]);

  return {
    connectionStatus,
    retryCount,
    reconnect,
    runReconnectRef,
    startSession,
    requestTokenRefresh,
  };
}
