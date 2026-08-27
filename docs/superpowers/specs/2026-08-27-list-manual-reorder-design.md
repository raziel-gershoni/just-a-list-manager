# Manual list reordering — Design

**Date:** 2026-08-27
**Status:** Approved (design)

## Problem

The home screen renders lists in whatever order the server returns: owned lists first, then lists shared with you, each ordered `updated_at DESC` (`app/api/lists/route.ts:20,38`). The client applies no sorting at all — `app/page.tsx:407` maps the raw response array.

That order is not meaningful to the user. `trg_lists_updated_at` (`001_initial.sql:83`) bumps `updated_at` on every rename, icon change, or colour change, so a list moves to the top for reasons unrelated to how often it is used. There is no way to put "Groceries" first and keep it there.

Items inside a list already support manual drag-reorder (`@dnd-kit/react` 0.2.4, 400 ms long-press, `src/hooks/useListDragDrop.ts`). Lists do not.

## Solution

Add drag-to-reorder on the home screen, mirroring the existing item pattern, backed by a **per-user** order.

The one thing that is not a copy of the item pattern: lists are shared. Item order is a property of the list; list order is a property of *you*. A single `lists.position` column would mean one collaborator's drag silently reorders the owner's home screen. So the order lives in a new `list_order(user_id, list_id, position)` table, where owner and collaborator are treated identically.

Confirmed scope decisions:

- **Storage:** per-user `list_order` table. Syncs across the user's devices; never leaks between users.
- **Unordered lists** (newly created, newly shared, never dragged) sort **above** the manual order, newest-updated first.
- **Gesture:** long-press the whole card, identical to item rows (400 ms delay, 5 px tolerance).
- **Failure/offline:** optimistic reorder + plain `fetch`, revert + refetch + toast on failure. **Not** routed through the mutation queue — this matches every other home-screen mutation (create, rename, delete are all bare fetches) and avoids building a home-level queue. An offline drag is lost; the user drags again.

## Architecture / edit points

### 1. Migration — `supabase/migrations/024_list_order.sql` (new)

```sql
-- Per-user manual ordering of the home screen list.
-- Sparse: a row exists only once a user has actually dragged.
-- Owner and collaborator are treated identically (collaborators has no owner row).
CREATE TABLE list_order (
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_id  UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  position BIGINT NOT NULL,
  PRIMARY KEY (user_id, list_id)
);

ALTER TABLE list_order ENABLE ROW LEVEL SECURITY;

CREATE POLICY "list_order_select_own" ON list_order FOR SELECT
  USING (user_id = auth.uid());

-- GET /api/lists filters lists on owner_id and no index exists for it.
CREATE INDEX IF NOT EXISTS idx_lists_owner ON lists(owner_id) WHERE deleted_at IS NULL;
```

Notes:

- `BIGINT`, not `INTEGER` — migration `010_position_bigint.sql` exists because a client wrote `Date.now()` into an `INTEGER` position column and overflowed it.
- The primary key `(user_id, list_id)` already provides the index for `WHERE user_id = $1`; no extra index is added.
- RLS is enabled with a SELECT-only policy, matching the convention set in `008_security_fixes.sql` (all API writes go through the service-role client, which bypasses RLS; RLS exists so the Supabase Security Advisor is satisfied and so Realtime could filter if ever needed).
- The table is **not** added to the realtime publication. The home screen has no realtime subscription and this change does not add one.
- Nothing writes to the `lists` table, so `trg_lists_updated_at` never fires and a reorder broadcasts no realtime events.
- `ON DELETE CASCADE` on both FKs means the 30-day hard-delete cleanup cron (`002_cleanup_cron.sql`) reaps order rows implicitly. A soft-deleted-then-restored list keeps its position, which is the desired behaviour.

### 2. Pure helpers — `src/utils/list-order.ts` (new)

Extracted so the ordering logic is unit-testable without a DB, mirroring the `list-notify.ts` / `unmark-completed.ts` precedent.

```ts
export interface OrderableList {
  id: string;
  owner_id: string;
  updated_at: string;
}

/**
 * Sort lists for a user's home screen.
 * - Lists with a manual position sort BELOW lists without one.
 * - Among positioned lists: highest position first (matches the item convention).
 * - Among unpositioned lists: owned before shared, then updated_at DESC
 *   (exactly today's behaviour, so a user who never drags sees no change).
 */
export function sortListsByUserOrder<T extends OrderableList>(
  lists: T[],
  positions: Map<string, number>,
  userId: string,
): T[];

/** Rows for the bulk upsert: first id (top) gets the highest position. */
export function buildListOrderRows(
  userId: string,
  orderedIds: string[],
): { user_id: string; list_id: string; position: number }[];
```

`buildListOrderRows` assigns `position = orderedIds.length - index`, matching the items convention (`app/api/lists/[id]/items/reorder/route.ts:38-40`) where the highest position renders first.

`sortListsByUserOrder` must be a stable, total ordering — ties broken by `id` as a last resort so the output is deterministic.

### 3. `GET /api/lists` — apply the order

In `app/api/lists/route.ts`, after `uniqueLists` is built and while the item-count and shared-set queries run:

```ts
const { data: orderRows } = await supabase
  .from("list_order")
  .select("list_id, position")
  .eq("user_id", auth.userId)
  .in("list_id", listIds);

const positions = new Map<string, number>(
  (orderRows || []).map((r) => [r.list_id, Number(r.position)]),
);
```

Then sort `listsWithCounts` with `sortListsByUserOrder(listsWithCounts, positions, auth.userId)` before returning.

The per-query `.order("updated_at", ...)` calls stay — they are the input the comparator falls back to, and they keep the response deterministic when no order rows exist.

**Response shape is unchanged.** The client renders array order, so no `position` field is added to the payload and `interface ListData` (`app/page.tsx:16-26`) is untouched. `src/hooks/useListData.ts`, which fetches the whole `/api/lists` array to find one list, is unaffected.

### 4. Endpoint — `app/api/lists/reorder/route.ts` (new)

Collection-level rather than `[id]`-scoped, because the operation spans lists. There is no `app/api/lists/[id]/route.ts` today; all list CRUD is collection-level, so this fits the existing shape.

```
POST /api/lists/reorder   { orderedIds: string[] }  ->  { updated: number }
```

1. `verifyUserAuth(request, apiRateLimiter, "lists-reorder")`.
2. `parseBody(reorderListsSchema, body)`.
3. **Authorization.** Deliberately *not* `verifyListPermission(..., "edit")` — reordering your own home screen is not editing anyone's list, so a **view-only collaborator may reorder**. Instead, reuse the visibility lookup already in the GET handler:
   ```ts
   const [{ data: owned }, { data: collab }] = await Promise.all([
     supabase.from("lists").select("id")
       .eq("owner_id", auth.userId).is("deleted_at", null).in("id", orderedIds),
     supabase.from("collaborators").select("list_id")
       .eq("user_id", auth.userId).eq("status", "approved").in("list_id", orderedIds),
   ]);
   ```
   Filter `orderedIds` down to that allow-set. Ids the caller cannot see are **silently dropped**, mirroring how the items endpoint drops `temp-` ids; a concurrently deleted list must not 500 the request. Return `{ updated: 0 }` when nothing survives.
4. **Write.** A single bulk upsert, not the items endpoint's `Promise.all` of N independent updates (which can leave a partial reorder behind on failure):
   ```ts
   const rows = buildListOrderRows(auth.userId, allowedIds);
   const { error } = await supabase
     .from("list_order")
     .upsert(rows, { onConflict: "user_id,list_id" });
   ```
5. On error, 500 `{ error: "Failed to save list order" }`; otherwise `{ updated: rows.length }`.

Stale order rows for lists no longer sent are left in place — they are harmless (a list the user cannot see never appears) and the FK cascade cleans them up on hard delete.

### 5. Validation — `src/schemas/lists.ts`

```ts
// POST /api/lists/reorder
export const reorderListsSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1).max(500),
});
```

`.uuid()` rather than the items schema's `.min(1)`: list creation on the home screen is server-first, so there are no optimistic `temp-` ids to accommodate. `.max(500)` mirrors the items schema; a user owns at most 50 lists but can be a collaborator on an unbounded number.

### 6. `components/SortableListCard.tsx` (new)

A direct mirror of `components/SortableItem.tsx`:

```tsx
const longPressSensor = PointerSensor.configure({
  activationConstraints: [new PointerActivationConstraints.Delay({ value: 400, tolerance: 5 })],
});
```

Module scope is load-bearing — a sensor created in the component body gets a new identity per render and activation breaks.

The component calls `useSortable({ id, index, sensors: [longPressSensor] })`, puts `ref` on a wrapper `div` with `touch-pan-y select-none transition-transform duration-150`, adds `opacity-50 scale-[1.02] shadow-lg rounded-2xl` while `isDragSource` (`rounded-2xl` to match `ListCard`'s own radius), and renders `ListCard` inside with its props passed straight through. `ListCard` itself is not modified.

`@dnd-kit/dom` is imported directly for the sensor but is only a transitive dependency of `@dnd-kit/react`; it is added to `package.json` dependencies as part of this change so the import is not resolving by accident.

### 7. `src/hooks/useListsDragDrop.ts` (new)

Mirror of `useListDragDrop.ts`, simplified: it works on array order rather than position integers, and does not touch the mutation queue.

```ts
export function useListsDragDrop({ lists, setLists, jwtRef, onReorderFailed }): {
  handleDragStart: DragDropEvents["dragstart"];
  handleDragEnd: DragDropEvents["dragend"];
  suppressClickRef: React.RefObject<boolean>;
}
```

- **dragstart:** snapshot `previousRef.current = [...lists]`, `HapticFeedback.impactOccurred("medium")`, `suppressClickRef.current = true`.
- **dragend:**
  - `event.canceled` → restore the snapshot, release the click guard, return.
  - Read `projectedIndex` via the cast the item hook uses: `(source as { sortable?: { index: number } }).sortable?.index` — `sortable` exists at runtime but not on the base `Draggable` type.
  - Bail when `originalIndex === -1`, `projectedIndex == null`, or the indices match.
  - Splice, `setLists(reordered)`, then `POST /api/lists/reorder` with `keepalive: true`.
  - On a non-OK response or a thrown fetch: restore the snapshot, call `onReorderFailed()`.
  - Release the click guard on **every** path (a `setTimeout(..., 0)` after the synchronous work, so the click that follows pointerup is still suppressed). The item hook resets its ref in five separate places; every early return here must do the same or taps stay dead.

**Click suppression** is the one problem the item pattern never had to solve: item rows do not navigate, but `ListCard`'s root is a `<button>` that pushes `/list/[id]`, and a long-press still fires a click on release — including a long-press that starts a drag and ends with no movement. `app/page.tsx` checks `suppressClickRef.current` before routing.

### 8. `app/page.tsx`

- Wrap the card map (lines 406-424) in `<DragDropProvider onDragStart={...} onDragEnd={...}>`, matching `app/list/[id]/page.tsx:239`. No sensors, collision detector, modifiers, or `DragOverlay` on the provider — the item screen passes only the two handlers, and adding an overlay risks the `touch-pan-y` scroll container.
- Replace `<ListCard>` with `<SortableListCard index={i} …>` inside `lists.map((list, i) => …)`.
- Guard the navigation: `onClick={() => { if (suppressClickRef.current) return; router.push(...); }}`.
- Generalise the toast: `undoAction.undo` becomes optional so a message-only failure toast can reuse the existing slot (lines 486-496); the Undo button renders only when `undo` is present. Rename the state to reflect that it is now a general toast.
- Wire `onReorderFailed` to show `t('lists.reorderFailed')` and call `fetchLists()`.

**Drive-by fix.** The delete-undo path (line 232) restores a list with `setLists((prev) => [...prev, listToDelete])` — appending it at the end and losing its place. With an explicit order that becomes visibly wrong, so the list is spliced back at the index it was removed from.

### 9. i18n

One new key in the `lists` namespace, added to `messages/en.json`, `messages/he.json`, and `messages/ru.json` at the same position (the three files are currently key-for-key identical and nothing enforces that):

```
"reorderFailed": "Couldn't save the new order"
```

Note `app/page.tsx` uses the root `useTranslations()` style with fully-dotted keys (`t('lists.reorderFailed')`), while `ListCard` uses the namespaced style. Match the file being edited.

### 10. Testing

The repo has no jsdom environment and no component tests (`vitest.config.ts` matches `__tests__/**/*.test.ts` only — a `.tsx` test would be silently skipped). Following the established convention, the logic is extracted and unit-tested as pure functions.

`__tests__/unit/list-order.test.ts` (new):

- `sortListsByUserOrder`
  - unpositioned lists sort above positioned ones
  - positioned lists sort by position descending
  - among unpositioned: owned before shared
  - among unpositioned and equally owned: `updated_at` descending
  - **regression guard:** with an empty position map the output equals today's ordering
  - stable/deterministic for exact ties
- `buildListOrderRows`
  - first id gets `orderedIds.length`, last gets `1`
  - every row carries the given `user_id`
  - empty input yields an empty array

`__tests__/unit/locale-parity.test.ts` (new) — guard test in the style of `list-colors-css.test.ts`: `en`, `he`, and `ru` must have identical leaf-key sets. They match exactly today and nothing enforces it, so an en-only key would ship a raw key path to Hebrew and Russian users.

**No `src/utils/executor-factory.ts` change is required**, because this deliberately does not go through the mutation queue. Recorded explicitly because the repo's known trap is the opposite case — a new queued mutation type that is missing a factory case is silently dropped on offline replay.

## Known consequences

- An offline drag is lost rather than replayed. Accepted: consistent with every other home-screen mutation.
- The order reaches the user's other devices on the next focus/refetch (the reconnect orchestrator), not live. The home screen has no realtime subscription.
- A newly created or newly shared list sits above the manual order until the user places it.
- A view-only collaborator can reorder their own home screen. Intentional.
- A user who has never dragged sees no change in ordering whatsoever.

## Out of scope

- Realtime sync of the home screen.
- Grouping, pinning, archiving, or filtering lists.
- Reordering from anywhere other than the home screen.
- Backfilling `list_order` rows for existing lists.
