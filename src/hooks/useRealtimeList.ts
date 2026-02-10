"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

interface RealtimeChange {
  table: string;
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: any;
  old: any;
}

type ConnectionStatus = "connected" | "connecting" | "offline";

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;

export function useRealtimeList(
  supabaseClient: SupabaseClient | null,
  listId: string,
  onChange: (change: RealtimeChange) => void,
  options?: { onReconnect?: () => void }
) {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [realtimeEventCount, setRealtimeEventCount] = useState(0);
  const [lastRealtimeEvent, setLastRealtimeEvent] = useState<string | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onReconnectRef = useRef(options?.onReconnect);
  onReconnectRef.current = options?.onReconnect;

  useEffect(() => {
    if (!supabaseClient || !listId) return;

    let active = true;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let hadSuccessfulConnection = false;
    let subscribeCount = 0;

    function subscribe() {
      if (!active || !supabaseClient) return;

      // Clean up any existing channel before creating a new one
      if (channelRef.current) {
        supabaseClient.removeChannel(channelRef.current);
        channelRef.current = null;
      }

      // Only show "connecting" if we previously had a successful connection
      // (i.e., we're recovering from a failure, not on first attempt)
      if (hadSuccessfulConnection) {
        setConnectionStatus("connecting");
      }

      // Use unique channel name to avoid stale channel conflicts on retry
      subscribeCount++;
      const channelName = `list:${listId}:${subscribeCount}`;
      console.log(`[Realtime] Subscribing to channel "${channelName}"`);
      const channel = supabaseClient
        .channel(channelName)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "items",
            filter: `list_id=eq.${listId}`,
          },
          (payload) => {
            const desc = `items:${payload.eventType}:${(payload.new as any)?.id || (payload.old as any)?.id || "?"}`;
            console.log(`[Realtime] Event received: ${desc}`, payload);
            setRealtimeEventCount((c) => c + 1);
            setLastRealtimeEvent(desc);
            onChangeRef.current({
              table: "items",
              eventType: payload.eventType as any,
              new: payload.new,
              old: payload.old,
            });
          }
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "lists",
            filter: `id=eq.${listId}`,
          },
          (payload) => {
            const desc = `lists:${payload.eventType}:${(payload.new as any)?.id || (payload.old as any)?.id || "?"}`;
            console.log(`[Realtime] Event received: ${desc}`, payload);
            setRealtimeEventCount((c) => c + 1);
            setLastRealtimeEvent(desc);
            onChangeRef.current({
              table: "lists",
              eventType: payload.eventType as any,
              new: payload.new,
              old: payload.old,
            });
          }
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "collaborators",
            filter: `list_id=eq.${listId}`,
          },
          (payload) => {
            const desc = `collaborators:${payload.eventType}:${(payload.new as any)?.id || (payload.old as any)?.id || "?"}`;
            console.log(`[Realtime] Event received: ${desc}`, payload);
            setRealtimeEventCount((c) => c + 1);
            setLastRealtimeEvent(desc);
            onChangeRef.current({
              table: "collaborators",
              eventType: payload.eventType as any,
              new: payload.new,
              old: payload.old,
            });
          }
        )
        .subscribe((status, err) => {
          if (!active) return;
          console.log("[Realtime] Channel status:", status, err || "");

          if (status === "SUBSCRIBED") {
            const wasReconnecting = hadSuccessfulConnection && retryCount > 0;
            retryCount = 0;
            hadSuccessfulConnection = true;
            setConnectionStatus("connected");

            // Fire onReconnect if this was a recovery from a failure
            if (wasReconnecting) {
              console.log("[Realtime] Recovered — refreshing data");
              onReconnectRef.current?.();
            }
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            console.warn(`[Realtime] ${status} on channel "${channelName}", scheduling retry #${retryCount + 1}`, err);
            setLastRealtimeEvent(`ERROR:${status}`);
            scheduleRetry();
          }
        });

      channelRef.current = channel;
    }

    function scheduleRetry() {
      if (!active) return;

      // Remove the failed channel
      if (channelRef.current && supabaseClient) {
        supabaseClient.removeChannel(channelRef.current);
        channelRef.current = null;
      }

      // Only show "connecting" if we previously had a successful connection
      if (hadSuccessfulConnection) {
        setConnectionStatus("connecting");
      }

      const delay = Math.min(MIN_RETRY_MS * Math.pow(2, retryCount), MAX_RETRY_MS);
      retryCount++;
      console.log(`[Realtime] Retrying in ${delay}ms (attempt #${retryCount})`);

      retryTimer = setTimeout(() => {
        retryTimer = null;
        subscribe();
      }, delay);
    }

    // Browser connectivity events
    const goOffline = () => {
      if (!active) return;
      setConnectionStatus("offline");
    };

    const goOnline = () => {
      if (!active) return;
      console.log("[Realtime] Browser online — re-subscribing immediately");
      retryCount = 0;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      subscribe();
    };

    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);

    // Initial subscribe
    subscribe();

    return () => {
      active = false;
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (channelRef.current && supabaseClient) {
        supabaseClient.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [supabaseClient, listId]);

  return { connectionStatus, realtimeEventCount, lastRealtimeEvent };
}
