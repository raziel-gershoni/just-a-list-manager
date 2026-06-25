# "On the way" — ordered grocery items

**Date:** 2026-06-26
**Status:** Approved (design)

## Problem

On grocery lists, some items get **ordered online but not yet received**. Today there's no way to represent that: an item is either active (to buy), "Not available" (skipped), completed, or deleted. The user wants to mark such items as *on the way* so they leave the active to-buy list, sit in their own group, and are checked off when they arrive.

A real (if rare) workflow: order part of a list online, go to a store and buy part of it, and fail to find the rest. So "on the way" and "Not available" must be able to coexist on the same list.

## Solution overview

Add an **`ordered`** item state that parallels the existing **`skipped`** state end-to-end: a timestamp column, a PATCH flag, a derived group, a collapsible section, and a row action button. "Received" reuses the existing completion path (received = done). Grocery lists only.

Key differences from `skipped`:
- **No auto-reset.** `skipped` auto-clears after 4 hours (`useListData.ts`); `ordered` persists until the item is received or manually un-ordered.
- Both the skip button and the new ordered (truck) button are shown **side by side** on every active grocery row — no per-list toggle. (Deliberate "ship simple, evaluate later" choice; a per-list toggle / new list type was considered and rejected for v1.)

## States and invariants

An item has these mutually exclusive "out-of-active" states, each backed by a timestamp column:

| State | Column | Section |
|-------|--------|---------|
| Active (to buy) | — | main list |
| On the way | `ordered_at` | "On the way" |
| Not available | `skipped_at` | "Not available" |
| Completed | `completed_at` | "Completed" |
| Deleted | `deleted_at` | (hidden) |

Invariants:
- **One secondary state at a time.** Marking an item ordered sets `ordered_at` and clears `skipped_at`. Marking it skipped clears `ordered_at`. (An item can't be both "not available" and "on the way".)
- **Ordered never auto-resets.** No equivalent of skip's 4-hour rule.
- **Received = done.** Checking off an "On the way" item runs the normal completion toggle. Because the active/ordered filters require `!completed`, the item moves to Completed with no special completion-path code. `ordered_at` is left set; if the item is later un-completed it naturally returns to "On the way" — acceptable.

## Changes by layer

### 1. Database — `supabase/migrations/023_item_ordered_at.sql`
```sql
ALTER TABLE items ADD COLUMN ordered_at TIMESTAMPTZ;
CREATE INDEX idx_items_ordered_at ON items(list_id) WHERE ordered_at IS NOT NULL;
```
Applied automatically by `scripts/migrate.mjs` on build/deploy — no manual step. Mirrors the `skipped_at` column and its partial index.

### 2. Types — `src/types/items.ts`
Add `ordered_at: string | null;` to `ItemData`.

### 3. API — `app/api/lists/[id]/items/route.ts` (PATCH) + `src/schemas/*`
- Extend the update schema with `ordered?: boolean`.
- In the PATCH handler:
  - `ordered === true` → set `ordered_at = now()`, set `skipped_at = null`.
  - `ordered === false` → set `ordered_at = null`.
  - When `skipped === true` is handled, also set `ordered_at = null` (symmetry).

### 4. Optimistic handler — `src/hooks/useItemHandlers.ts`
Add `onOrder(id, ordered)` mirroring `onSkip`:
- Optimistically set/clear `ordered_at` (and clear `skipped_at` when ordering).
- Enqueue a PATCH `{ itemId, ordered }` via `useMutationQueue`.
- Mutation type string: `"order"` (parallel to `"skip"`).

### 5. Derived data — `src/hooks/useListDerivedData.ts`
- **Active filter** gains `&& !ordered_at` so ordered items leave the active list.
- New **`orderedItems`** group: `ordered_at != null && !completed && !deleted_at`, sorted by `position` desc (mirrors skipped).

### 6. Sections / list view — `app/list/[id]/page.tsx` (+ new `OrderedItemsSection`)
- New collapsible **"On the way (N)"** section component mirroring `SkippedItemsSection`.
- Section order (grocery): **active → On the way → Not available → Completed**.
- Wire `onOrder` into the item handlers and pass `ordered`/`onOrder` props to rows.

### 7. Row UI — `components/ItemRow.tsx`
- Add props `ordered?: boolean` and `onOrder?: (id: string, ordered: boolean) => void`.
- Render a button (gated on `onOrder && !completed`) that mirrors the skip button's two-state shape:
  - `ordered === false` (active row): lucide **`Truck`**, gray (`text-tg-hint`) — tap to mark on the way.
  - `ordered === true` ("On the way" section row): lucide **`RotateCcw`**, `text-tg-link` — tap to un-order back to active.
- On active grocery rows this sits next to the existing skip button.
- In the "On the way" section, rows render the checkbox (received), the un-order button, and delete — mirroring how the "Not available" section renders skipped rows.

### 8. i18n — `messages/{en,he,ru}.json`
Add keys following the existing flat-dotted + ICU convention:
- `items.orderedSection` → "On the way ({count})"
- `items.ordered.toggleOn` → "Mark as ordered"
- `items.ordered.restore` → "Add back to list"

### 9. Realtime — no change
`ordered_at` syncs through the generic column-merge in `useListRealtime`.

## Testing

- **Unit (`vitest`, `__tests__/unit/`):** extend the derived-data / list-helpers tests to cover: an item with `ordered_at` is excluded from active and included in `orderedItems`; a completed item with `ordered_at` is excluded from `orderedItems`; ordered/skipped mutual exclusion in the optimistic handler.
- **Manual:** on a grocery list, mark an item on the way (leaves active, appears in "On the way", persists past 4h), check it off from the section (moves to Completed), un-order it (returns to active), and confirm marking ordered clears a prior skipped state.

## Out of scope (v1)

- Per-list toggle / new "hybrid" list type.
- Delivery dates, tracking numbers, ETAs.
- Non-grocery lists.
- Ordering directly from the "Not available" section.

## Update (2026-06-26): ordered items stay in the list

After shipping the "On the way" section, we changed the presentation: **ordered items now stay in the active list** with an in-row marker instead of moving into a separate collapsed section. Rationale: in a shared list, a collapsed section hides ordered items, so a second person doesn't see them as handled and re-adds them as duplicates. Keeping them visible solves that.

Changes from the original design:
- Removed the "On the way" section, the `orderedItems` derived group, the `isOrderedItem` predicate, the `OrderedItemsSection` component, and the `panel_ordered` state. `isActiveItem` no longer excludes `ordered_at`.
- The truck row button now marks the item in place and turns **amber + bold** when ordered (the app's attention color, reusing the recurring-toggle on-state recipe), plus a small amber **"on the way"** caption under the item text.
- i18n: dropped `items.orderedSection`; `items.ordered` is now `{ toggleOn, label }`.
- Unchanged: `ordered_at` column, PATCH `ordered` flag, `handleOrder`, executor-factory `order` case, recycle clearing, ordered/skipped mutual exclusion, received = done, no auto-reset, grocery-only.
