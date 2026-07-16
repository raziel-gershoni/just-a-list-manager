# Unmark all done — Design

**Date:** 2026-07-16
**Status:** Approved (design)

## Problem

In a **regular** list you check items off as you go; they pile up in the sticky **"Completed (N)"** section. To reuse the list (a chores routine, a packing list, a weekly checklist) you currently have to uncheck each item by hand. There is a bulk **"Clear completed"** action that *deletes* done items, but no way to bulk **reset** them back to active.

## Solution

Add an **"Unmark all done"** action that flips every completed item in a regular list back to active — the non-destructive sibling of "Clear completed". It lives beside "Clear completed" in the same **Completed (N)** section header, works instantly with an **undo toast**, and is a near-exact clone of the clear-completed machinery (same auth, same single bulk write, same optimistic + undo + direct-fetch frontend path — deliberately **not** routed through the mutation queue).

Confirmed scope decisions:
- **Interaction:** instant flip + undo toast (identical to Clear completed).
- **Which lists:** **regular only.** Grocery (which shares the component) and reminders (separate render) do not show it.

## Architecture / edit points

### 1. Endpoint — `app/api/lists/[id]/items/unmark-completed/route.ts` (new)

Clone of `clear-completed/route.ts`:
- `verifyUserAuth(request, apiRateLimiter, "items-unmark-completed")` → `verifyListPermission(auth.userId, listId, "edit")` (403 on failure).
- One bulk update, same filter shape as clear-completed:
  ```ts
  supabase.from("items")
    .update({ completed: false, completed_at: null })
    .eq("list_id", listId)
    .eq("completed", true)
    .is("deleted_at", null)
    .select("id")
  ```
- Returns `{ unmarked: number, unmarkedIds: string[] }`.
- **No** `cancelItemReminders` call — unmarking is not a deletion, so reminders must survive.

### 2. Pure helper — `src/utils/unmark-completed.ts` (new)

Extract the optimistic computation so it is unit-testable (mirrors the `list-notify.ts` precedent):
```ts
export function computeUnmarkCompleted(items: ItemData[]): { next: ItemData[]; affectedIds: string[] } {
  const affectedIds: string[] = [];
  const next = items.map((i) => {
    if (i.completed && !i.deleted_at) {
      affectedIds.push(i.id);
      return { ...i, completed: false, completed_at: null };
    }
    return i;
  });
  return { next, affectedIds };
}
```
The predicate (`completed && !deleted_at`) deliberately matches the endpoint filter so optimistic state and server state agree.

### 3. Frontend handler — `handleUnmarkAllDone` in `src/hooks/useItemHandlers.ts`

Mirrors `handleClearCompleted`:
1. Light haptic (not the warning haptic clear-completed uses — unmarking is less destructive).
2. Optimistic: `const { next, affectedIds } = computeUnmarkCompleted(items); setItems(next);`. Bail early if `affectedIds.length === 0`.
3. `setUndoAction`: undo re-checks the affected items — optimistically flips them back to `completed: true` in local state and restores each on the server via per-item PATCH `{ itemId, completed: true }` (the same restore mechanism clear-completed's undo uses). Toast copy `items.unmarkedCount` = "Unmarked {count} items".
4. Single `await fetch("/api/lists/${listId}/items/unmark-completed", { method: "POST", headers: { Authorization: `Bearer ${jwt}` } })` — the auth header shape used by `handleClearCompleted`. No `addMutation`, no `executor-factory.ts` case.

Return `handleUnmarkAllDone` from the hook.

### 4. UI — `components/list/CompletedItemsSection.tsx`

- New **optional** prop `onUnmarkAllDone?: () => void`.
- When present, render a button **before** the "Clear completed" button in the sticky header:
  - Icon `RotateCcw` + label `t('items.unmarkAllDone')`.
  - Neutral hint styling (`text-tg-hint`), **not** the destructive red — it is a reset, not a delete.
  - `onClick` calls `e.stopPropagation()` then `onUnmarkAllDone()` (the header itself is a collapse toggle, same as the trash button).
- The two right-aligned buttons share the `ms-auto` group so layout stays tidy on narrow/RTL screens.

### 5. Wiring — `app/list/[id]/page.tsx`

- Destructure `handleUnmarkAllDone` from `useItemHandlers(...)`.
- Pass `onUnmarkAllDone={handleUnmarkAllDone}` to `CompletedItemsSection` **only when `listType === "regular"`** (e.g. `onUnmarkAllDone={listType === "regular" ? handleUnmarkAllDone : undefined}`). Grocery reuses the same component but must not receive the callback; the reminders completed section is a separate render and is untouched.

### 6. i18n — `messages/{en,he,ru}.json`

Add under `items`:
- `unmarkAllDone` — "Unmark all" (button label; concise to fit beside "Clear completed").
- `unmarkedCount` — "Unmarked {count} items" (undo toast; ICU `{count}`).

Use exact existing translations' tone; match the `clearCompleted` / `clearedCount` sibling keys.

## Not doing

- No DB migration (uses existing `completed` / `completed_at` columns).
- No mutation-queue / `executor-factory.ts` change (direct fetch, mirroring clear-completed).
- No reminder cancellation.
- No grocery/reminders exposure (regular only).
- No confirmation dialog (undo toast is the safety net, per the chosen interaction).

## Known trade-off

Undo re-completes via PATCH `{ completed: true }`, which stamps a fresh `completed_at`. Undone items therefore regroup under "today" in the completed section rather than their original completion date. This is cosmetic and matches the same class of behavior in clear-completed's restore (the `updateItemSchema` PATCH derives `completed_at` server-side and accepts no explicit timestamp).

## Testing

- `__tests__/unit/unmark-completed.test.ts` (new) — pure-function vitest over `computeUnmarkCompleted`:
  - flips only `completed && !deleted_at` items; leaves active, deleted, and already-active items untouched;
  - `affectedIds` contains exactly the flipped ids, in order;
  - returns empty `affectedIds` and an unchanged-shape array when nothing is completed;
  - flipped items have `completed === false` and `completed_at === null`.
- Endpoint import/type correctness and prop wiring are covered by `tsc` / `next build`.
- Repo convention: pure-function vitest, no DOM.
