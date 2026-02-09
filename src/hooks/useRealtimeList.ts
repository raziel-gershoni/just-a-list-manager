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

export function useRealtimeList(
  supabaseClient: SupabaseClient | null,
  listId: string,
  onChange: (change: RealtimeChange) => void
) {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connected"); // optimistic — assume online until proven otherwise
  const channelRef = useRef<RealtimeChannel | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!supabaseClient || !listId) {
      // Don't immediately show offline — client may still be initializing
      return;
    }

    if (!navigator.onLine) {
      setConnectionStatus("offline");
    }

    const channel = supabaseClient
      .channel(`list:${listId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "items",
          filter: `list_id=eq.${listId}`,
        },
        (payload) => {
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
          onChangeRef.current({
            table: "collaborators",
            eventType: payload.eventType as any,
            new: payload.new,
            old: payload.old,
          });
        }
      )
      .subscribe(); // No status callback — don't tie UI to Realtime health

    channelRef.current = channel;

    // Browser connectivity events
    const goOffline = () => setConnectionStatus("offline");
    const goOnline = () => setConnectionStatus("connected");
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);

    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
      if (channelRef.current) {
        supabaseClient.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [supabaseClient, listId]);

  return { connectionStatus };
}
