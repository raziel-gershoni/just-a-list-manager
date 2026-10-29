"use client";

import { useEffect, useRef, useCallback } from "react";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import type { RealtimeChange } from "@/src/types";
import { removeChannelLogged } from "@/src/lib/realtime-cleanup";

const RESUBSCRIBE_TIMEOUT_MS = 10000;
// Closes in a burst ask the provider for one reconnect, so a server that keeps closing the
// channel can't make the app reconnect in a tight loop.
const RECONNECT_DEBOUNCE_MS = 2000;

// The list's channel and its join. There is at most one, so a list never has two live
// channels (each would apply every event).
type Subscription = {
  client: SupabaseClient;
  channel: RealtimeChannel;
  joined: boolean;
  // Rejoins waiting for the join to end
  waiters: { resolve: () => void; reject: (err: Error) => void }[];
};

export function useRealtimeList(
  supabaseClient: SupabaseClient | null,
  supabaseClientRef: React.RefObject<SupabaseClient | null>,
  listId: string,
  onChange: (change: RealtimeChange) => void,
  // Called when the channel was closed for good by something other than this hook
  // (realtime-js removes a closed channel and never rejoins it): the provider reconnects,
  // and the rejoin step starts the list's next channel.
  requestReconnect?: () => void
) {
  const subRef = useRef<Subscription | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const requestReconnectRef = useRef(requestReconnect);
  useEffect(() => {
    requestReconnectRef.current = requestReconnect;
  }, [requestReconnect]);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    },
    []
  );
  const subscribeCountRef = useRef(0);

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
              eventType: payload.eventType as RealtimeChange["eventType"],
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
              eventType: payload.eventType as RealtimeChange["eventType"],
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
              eventType: payload.eventType as RealtimeChange["eventType"],
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
            table: "list_categories",
            filter: `list_id=eq.${listId}`,
          },
          (payload) => {
            onChangeRef.current({
              table: "list_categories",
              eventType: payload.eventType as RealtimeChange["eventType"],
              new: payload.new,
              old: payload.old,
            });
          }
        );
    },
    [listId]
  );

  // The one place a channel is created. A channel of this client is reused, whether the
  // client effect or a resubscribe asked first. One of an older client is only forgotten:
  // TelegramProvider closed that client with all its channels when it replaced it.
  const subscribe = useCallback(
    (client: SupabaseClient): Subscription => {
      const current = subRef.current;
      if (current?.client === client) return current;

      subscribeCountRef.current++;
      const channelName = `list:${listId}:${subscribeCountRef.current}`;
      const sub: Subscription = { client, channel: createChannel(client, channelName), joined: false, waiters: [] };
      subRef.current = sub;

      sub.channel.subscribe((status, err) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn("[RealtimeList] Subscribe failed:", status, "listId:", listId, err);
        }
        if (subRef.current !== sub) return; // removed or forgotten
        if (status === "SUBSCRIBED") {
          sub.joined = true;
          for (const w of sub.waiters.splice(0)) w.resolve();
        } else if (status === "CLOSED") {
          // Closed for good: the next rejoin starts a new channel.
          subRef.current = null;
          for (const w of sub.waiters.splice(0)) w.reject(new Error(`Channel subscribe failed: ${status}`));
          // Not a close this hook asked for (those clear subRef first). Unless the provider
          // replaced the client, which closed its channels: then a rejoin is already coming.
          if (supabaseClientRef.current === client) {
            removeChannelLogged(client, sub.channel, { listId, reason: "closed" });
            if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = setTimeout(() => {
              reconnectTimerRef.current = null;
              requestReconnectRef.current?.();
            }, RECONNECT_DEBOUNCE_MS);
          }
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          sub.joined = false;
          // supabase-js rejoins by itself. A reconnect waiting on the join removes the channel
          // instead, so its retry starts a new one.
          if (sub.waiters.length > 0) {
            subRef.current = null;
            removeChannelLogged(client, sub.channel, { listId, reason: `resubscribe ${status}` });
            for (const w of sub.waiters.splice(0)) w.reject(new Error(`Channel subscribe failed: ${status}`));
          }
        }
      });
      return sub;
    },
    [listId, createChannel, supabaseClientRef]
  );

  // Orchestrator step 3: rejoin only when the list's channel is not joined. Resolves once it
  // is; rejects when the join fails or takes longer than RESUBSCRIBE_TIMEOUT_MS.
  const resubscribe = useCallback((): Promise<void> => {
    const client = supabaseClientRef.current;
    if (!client || !listId) return Promise.resolve(); // No client — no-op
    const sub = subscribe(client);
    if (sub.joined) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (subRef.current === sub && !sub.joined) {
          subRef.current = null;
          removeChannelLogged(client, sub.channel, { listId, reason: "resubscribe timed out" });
        }
        for (const w of sub.waiters.splice(0)) w.reject(new Error("Resubscribe timed out"));
      }, RESUBSCRIBE_TIMEOUT_MS);
      sub.waiters.push({
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
    });
  }, [listId, supabaseClientRef, subscribe]);

  // The list's channel on the current client (created here, or by a resubscribe that ran first)
  useEffect(() => {
    if (!supabaseClient || !listId) return;
    subscribe(supabaseClient);

    return () => {
      const sub = subRef.current;
      // Only this client's channel: one on a newer client belongs to the next run.
      if (sub?.client !== supabaseClient) return;
      subRef.current = null;
      removeChannelLogged(supabaseClient, sub.channel, { listId, reason: "cleanup" });
      for (const w of sub.waiters.splice(0)) w.reject(new Error("Channel removed"));
    };
  }, [supabaseClient, listId, subscribe]);

  return { resubscribe };
}
