import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

type RemoveResult = "ok" | "timed out" | "error";

/**
 * Removes a realtime channel without waiting for it. Supabase answers "ok", "timed out" or
 * "error" instead of throwing, and a channel that did not answer "ok" stays subscribed, so
 * anything but "ok" is logged with `context` (IDs and why it was removed, never a token).
 */
export function removeChannelLogged(
  client: SupabaseClient,
  channel: RealtimeChannel,
  context: Record<string, unknown>
): void {
  client.removeChannel(channel).then(
    (result: RemoveResult) => {
      if (result !== "ok") console.warn("[Realtime] Remove channel failed:", context, result);
    },
    (err) => console.warn("[Realtime] Remove channel failed:", context, err)
  );
}

/** Removes every channel of a client without waiting, logging the answers that were not "ok". */
export function removeAllChannelsLogged(client: SupabaseClient): void {
  client.removeAllChannels().then(
    (results: RemoveResult[]) => {
      const failed = results.filter((r) => r !== "ok");
      if (failed.length > 0) {
        console.warn("[Realtime] Remove all channels failed:", { total: results.length }, failed);
      }
    },
    (err) => console.warn("[Realtime] Remove all channels failed:", err)
  );
}
