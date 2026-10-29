import type { ItemData } from "@/src/types";

/**
 * A server row with the local value of every field a change still in the sync engine
 * touches (`pendingFields`), so a confirmation or refresh never undoes a change that has
 * not landed yet. Presence markers ("created", "deleted") are not row fields and are ignored.
 */
export function overlayPending(server: ItemData, local: ItemData, pending: Set<string>): ItemData {
  const merged: Record<string, unknown> = { ...server };
  for (const field of pending) {
    if (field in local) merged[field] = local[field as keyof ItemData];
  }
  return merged as unknown as ItemData;
}
