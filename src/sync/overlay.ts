import type { ItemData } from "@/src/types";

/**
 * A server row with the on-screen values of the fields the user changed and the server
 * hasn't confirmed yet (`pendingFields`), so a confirmation, a refresh or a realtime echo
 * never undoes a change that has not landed. Everything else, a collaborator's change
 * included, comes from the server. Of the presence markers, "deleted" keeps the on-screen
 * deleted_at, and "created" (a create or recycle still on its way) keeps the whole
 * on-screen row.
 */
export function overlayPending(server: ItemData, local: ItemData, pending: Set<string>): ItemData {
  if (pending.size === 0) return server;
  if (pending.has("created")) return local;
  const merged: Record<string, unknown> = { ...server };
  const mine = local as unknown as Record<string, unknown>;
  for (const field of pending) {
    if (field === "deleted") merged.deleted_at = local.deleted_at;
    else if (field in mine) merged[field] = mine[field];
  }
  return merged as unknown as ItemData;
}

/**
 * The pending fields with the "created" marker dropped: for a row whose create or recycle
 * has been answered (or echoed), so the server row shows with only the later changes
 * overlaid, rather than the whole on-screen row being kept.
 */
export function withoutCreated(pending: Set<string>): Set<string> {
  if (!pending.has("created")) return pending;
  const fields = new Set(pending);
  fields.delete("created");
  return fields;
}
