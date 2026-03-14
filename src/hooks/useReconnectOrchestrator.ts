"use client";

import { useState, useCallback, useRef, useEffect } from "react";

// --- Orchestrator types ---

type OrchestratorState =
  | "initializing"
  | "idle"
  | "reconnecting"
  | "needs_retry"
  | "cooldown"
  | "auth_failed";

export type ConnectionStatus = "connecting" | "connected" | "auth_failed";

const MAX_RETRIES = 5;
const COOLDOWN_MS = 5000;
const RETRY_DELAY_MS = 2000;
const RECONNECT_THROTTLE_MS = 5000; // Min interval between reconnect() calls from browser events
const PROACTIVE_REFRESH_MS = 45 * 60 * 1000; // 45 minutes

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
  fetchToken: (initData: string | null) => Promise<string | null>;
  clearJwt: () => void;
  jwtRef: React.RefObject<string | null>;
  recreateSupabaseClient: (token: string) => void;
  isWebAppRef: React.RefObject<boolean>;
  onFlushNeededRef: React.MutableRefObject<(() => Promise<void>) | null>;
  onResubscribeNeededRef: React.MutableRefObject<(() => Promise<void>) | null>;
  onRefreshNeededRef: React.MutableRefObject<(() => Promise<void>) | null>;
  router: ReturnType<typeof import("next/navigation").useRouter>;
}) {
  const {
    fetchToken,
    clearJwt,
    recreateSupabaseClient,
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
  const reconnectLockRef = useRef(false);
  const runReconnectRef = useRef<() => void>(() => {});
  const reconnectRef = useRef<() => void>(() => {});
  const lastReconnectAttemptRef = useRef<number>(0);

  const setOrchestratorState = useCallback(
    (state: OrchestratorState) => {
      orchestratorStateRef.current = state;
      setConnectionStatus(mapToConnectionStatus(state));
    },
    []
  );

  // === Reconnect Orchestrator ===

  const runReconnect = useCallback(async () => {
    // Only proceed from idle state
    if (orchestratorStateRef.current !== "idle") return;
    // Mutex: prevent concurrent reconnect calls
    if (reconnectLockRef.current) return;
    reconnectLockRef.current = true;

    setOrchestratorState("reconnecting");

    try {
      // Step 1: Refresh JWT (try existing JWT first)
      let newToken = await fetchToken(null);
      if (!newToken && !isWebAppRef.current) {
        // Clear expired JWT so initData path is used
        clearJwt();
        // Fallback: re-read Telegram.WebApp.initData (only in Mini App mode)
        const tg = (window as unknown as { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp;
        const freshInitData = tg?.initData;
        if (freshInitData) {
          newToken = await fetchToken(freshInitData);
        }
      }

      if (!newToken) {
        // Web app: if token refresh fails after retries, redirect to login
        if (isWebAppRef.current) {
          localStorage.removeItem("web_auth_token");
          clearJwt();
        }
        // Token failure is retriable (could be network error, not just auth failure).
        // Only go terminal after exhausting retries.
        retryCountRef.current++;
        setRetryCount(retryCountRef.current);

        if (retryCountRef.current >= MAX_RETRIES) {
          if (isWebAppRef.current) {
            localStorage.removeItem("web_auth_token");
            router.push("/login");
            return;
          }
          setOrchestratorState("auth_failed");
          return;
        }

        setOrchestratorState("needs_retry");
        if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = setTimeout(() => {
          orchestratorStateRef.current = "idle";
          runReconnectRef.current();
        }, RETRY_DELAY_MS);
        return;
      }

      // Persist refreshed token for web users
      if (isWebAppRef.current) {
        localStorage.setItem("web_auth_token", newToken);
      }

      // Recreate Supabase client with fresh token
      recreateSupabaseClient(newToken);

      // Step 2: Flush mutations (no-op if no list page mounted)
      if (onFlushNeededRef.current) {
        await onFlushNeededRef.current();
      }

      // Step 3: Resubscribe realtime (no-op if no list page mounted)
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
      retryCountRef.current++;
      setRetryCount(retryCountRef.current);

      if (retryCountRef.current >= MAX_RETRIES) {
        // Stop auto-retrying — UI will show manual retry banner
        setOrchestratorState("needs_retry");
        return;
      }

      setOrchestratorState("needs_retry");
      // Clear previous retry timeout to prevent orphaned timers
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
      retryTimeoutRef.current = setTimeout(() => {
        // Reset to idle so runReconnect can proceed
        orchestratorStateRef.current = "idle";
        runReconnectRef.current();
      }, RETRY_DELAY_MS);
    } finally {
      reconnectLockRef.current = false;
    }
  }, [fetchToken, clearJwt, recreateSupabaseClient, setOrchestratorState, isWebAppRef, onFlushNeededRef, onResubscribeNeededRef, onRefreshNeededRef, router]);

  // Keep refs in sync for stable callbacks
  runReconnectRef.current = runReconnect;

  // Manual reconnect (works even when retryCount >= MAX_RETRIES)
  const reconnect = useCallback(() => {
    // If a reconnect is already in flight, don't interfere
    if (reconnectLockRef.current) return;
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
    reconnectRef.current();
  }, []);

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
    document.addEventListener("visibilitychange", handleVisibility);

    // 45-minute proactive timer (ensures JWT never expires during stable use)
    const proactiveTimer = setInterval(() => {
      runReconnectRef.current();
    }, PROACTIVE_REFRESH_MS);

    return () => {
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
      clearInterval(proactiveTimer);
      if (cooldownTimeoutRef.current) clearTimeout(cooldownTimeoutRef.current);
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    };
  }, [debouncedReconnect]);

  // Function to set orchestrator state from outside (e.g., bootstrap sets "idle")
  const setOrchestratorStateFn = useCallback(
    (state: OrchestratorState) => {
      setOrchestratorState(state);
    },
    [setOrchestratorState]
  );

  return {
    connectionStatus,
    retryCount,
    reconnect,
    runReconnectRef,
    setOrchestratorState: setOrchestratorStateFn,
  };
}
