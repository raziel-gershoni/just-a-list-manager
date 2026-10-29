import type { ItemData } from "@/src/types";
import type { QueuedMutation } from "@/src/utils/mutation-queue";
import { overlayPending, withoutCreated } from "@/src/sync/overlay";

/** The item fields a queued or in-flight change touches (SyncEngine.pendingFields). */
export type PendingFieldsOf = (itemId: string) => Set<string>;

/**
 * A background refresh merged into the screen instead of replacing it.
 * - `prev`: the rows on screen now; `base`: the rows on screen when the GET went out;
 *   `server`: the GET's rows.
 * - A row that changed on screen while the GET was out (an optimistic change, a realtime
 *   event, a create that landed) is newer than the snapshot and stays as it is.
 * - Any other row is the server row overlaid with its pending fields.
 * - A row only on screen stays while it is unsaved (`_pending`), changed during the GET, or
 *   has a change on its way that decides its presence (a restore) or its whole state.
 * - A row only on the server is added, unless its delete is on its way or it left the
 *   screen while the GET was out.
 * Pending creates are never matched to server rows by text: a completed row with the same
 * text is not the new item. The create's answer resolves its temp row (applyCreateResult).
 */
export function mergeRefresh(
  prev: ItemData[],
  base: ItemData[],
  server: ItemData[],
  pendingFields: PendingFieldsOf
): ItemData[] {
  const atStart = new Map(base.map((i) => [i.id, i]));
  const onScreen = new Map(prev.map((i) => [i.id, i]));
  const serverIds = new Set(server.map((i) => i.id));
  const changedDuringGet = (row: ItemData) => atStart.get(row.id) !== row;

  const onlyOnScreen = prev.filter((row) => {
    if (serverIds.has(row.id)) return false;
    if (row._pending || changedDuringGet(row)) return true;
    const fields = pendingFields(row.id);
    return fields.has("deleted") || fields.has("created");
  });
  const fromServer = server.flatMap((row) => {
    const local = onScreen.get(row.id);
    if (!local) return pendingFields(row.id).has("deleted") || atStart.has(row.id) ? [] : [row];
    if (changedDuringGet(local)) return [local];
    return [overlayPending(row, local, pendingFields(row.id))];
  });
  return [...onlyOnScreen, ...fromServer];
}

/**
 * The create's answer turns its temp row into the saved row, keeping the on-screen values of
 * any change made to the new item that is still on its way (a tick right after adding). When
 * the realtime INSERT got there first, the saved row is already on screen, so the temp row
 * just goes: the same id never shows twice.
 */
export function applyCreateResult(
  prev: ItemData[],
  tempId: string,
  created: ItemData,
  pendingFields: PendingFieldsOf
): ItemData[] {
  if (prev.some((i) => i.id === created.id)) return prev.filter((i) => i.id !== tempId);
  // The engine maps the temp id to the saved one before it reports success, so the item's
  // pending fields are under the saved id. The create itself is no longer among them.
  const fields = withoutCreated(pendingFields(created.id));
  return prev.map((i) =>
    i.id === tempId
      ? overlayPending({ ...created, creator_name: null, editor_name: null, _pending: false }, i, fields)
      : i
  );
}

/**
 * The recycle's answer puts the server's row on screen: the item comes back at the top
 * (the server gives it the list's highest position), which the optimistic recycle doesn't
 * do. While the recycle was on its way its realtime echo was held back ("created" keeps the
 * whole on-screen row), so this is where the server row shows. A change made to the item
 * after the recycle and still on its way keeps its on-screen value.
 * An answer for another item (the server added the text as a new item) changes nothing
 * here: that item's realtime INSERT brings it.
 */
export function applyRecycleResult(
  prev: ItemData[],
  recycleId: string,
  recycled: ItemData | null,
  pendingFields: PendingFieldsOf
): ItemData[] {
  if (!recycled || recycled.id !== recycleId) return prev;
  const fields = withoutCreated(pendingFields(recycleId));
  return prev.map((i) => (i.id === recycleId ? overlayPending({ ...i, ...recycled }, i, fields) : i));
}

/** A landed change's answer applied to the screen: a create's or a recycle's saved row. */
export function applyMutationResult(
  prev: ItemData[],
  m: QueuedMutation,
  result: unknown,
  pendingFields: PendingFieldsOf
): ItemData[] {
  if (m.type === "create" && typeof m.payload.tempId === "string" && result) {
    return applyCreateResult(prev, m.payload.tempId, result as ItemData, pendingFields);
  }
  if (m.type === "recycle" && typeof m.payload.recycleId === "string") {
    return applyRecycleResult(prev, m.payload.recycleId, (result as ItemData | null) ?? null, pendingFields);
  }
  return prev;
}
