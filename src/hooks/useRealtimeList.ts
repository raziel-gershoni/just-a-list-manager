"use client";

import { useEffect, useRef, useCallback } from "react";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

interface RealtimeChange {
  table: string;
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: any;
  old: any;
}

const RESUBSCRIBE_TIMEOUT_MS = 10000;

export function useRealtimeList(
  supabaseClient: SupabaseClient | null,
  supabaseClientRef: React.RefObject<SupabaseClient | null>,
  listId: string,
  onChange: (change: RealtimeChange) => void
) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const subscribeCountRef = useRef(0);
  // Flag to prevent the effect from re-creating a channel that resubscribe() just set up
  const resubscribedRef = useRef(false);

  const createChannel = useCallback(
    (client: SupabaseClient, channelName: string): RealtimeChannel => {
      return client
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
        );
    },
    [listId]
  );

  // Resubscribe function for orchestrator step 3
  const resubscribe = useCallback((): Promise<void> => {
    return new Promise((resolve, reject) => {
      // Use the ref to get the latest client (may have been recreated)
      const client = supabaseClientRef.current;
      if (!client) {
        resolve(); // No client — no-op
        return;
      }

      // Old channel was on the previous client (already cleaned up by recreateSupabaseClient).
      // Just clear the ref — don't try to remove from the new client.
      channelRef.current = null;

      subscribeCountRef.current++;
      const channelName = `list:${listId}:${subscribeCountRef.current}`;
      const channel = createChannel(client, channelName);

      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Clean up the failed channel to prevent orphaned subscriptions
        client.removeChannel(channel);
        reject(new Error("Resubscribe timed out"));
      }, RESUBSCRIBE_TIMEOUT_MS);

      channel.subscribe((status) => {
        if (settled) return;
        if (status === "SUBSCRIBED") {
          settled = true;
          clearTimeout(timeout);
          channelRef.current = channel;
          resubscribedRef.current = true;
          resolve();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          settled = true;
          clearTimeout(timeout);
          client.removeChannel(channel);
          reject(new Error(`Channel subscribe failed: ${status}`));
        }
      });
    });
  }, [listId, supabaseClientRef, createChannel]);

  // Initial subscribe on mount or client change
  useEffect(() => {
    if (!supabaseClient || !listId) return;

    // If resubscribe() already created a channel on this client, skip creation
    // but still return cleanup so the channel is removed on unmount
    if (resubscribedRef.current) {
      resubscribedRef.current = false;
    } else {
      // Clean up any existing channel
      if (channelRef.current) {
        supabaseClient.removeChannel(channelRef.current);
        channelRef.current = null;
      }

      subscribeCountRef.current++;
      const channelName = `list:${listId}:${subscribeCountRef.current}`;
      const channel = createChannel(supabaseClient, channelName);

      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          channelRef.current = channel;
        }
      });
    }

    return () => {
      if (channelRef.current) {
        // Use the ref client since supabaseClient from closure may be stale
        const client = supabaseClientRef.current;
        if (client) {
          client.removeChannel(channelRef.current);
        }
        channelRef.current = null;
      }
    };
  }, [supabaseClient, supabaseClientRef, listId, createChannel]);

  return { resubscribe };
}
