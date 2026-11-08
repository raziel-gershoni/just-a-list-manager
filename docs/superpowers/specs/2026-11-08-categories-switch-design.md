# A switch to turn grocery categories off

**Date:** 2026-11-08
**Status:** owner's decisions taken (2026-11-08); ready to build.

## Owner's decisions

1. **What it's for:** a grocery list with nothing to sort (a list of flours) turns categories off.
2. **Turning off cleans up everything.** It deletes the list's categories, their order and every item's
   category, hand placements included. **Turning on starts from zero:** the AI sorts the list as it
   sorts a brand-new grocery list.
3. **Defaults the owner was shown and didn't object to:**
   - The switch lives in the list's settings sheet, under Regular / Grocery, labelled
     "Sort into categories". It is on by default, so existing lists don't change.
   - It is not in the create-list sheet.
   - Only the list's owner can change it, the same as the list type.

This amends the 2026-10-08 categories spec, which had categories "always on" for grocery lists.

## Model

- Migration `032_list_categories_enabled.sql` adds `lists.categories_enabled BOOLEAN NOT NULL DEFAULT true`.
- A grocery list groups its items, and the AI sorts it, only while `categories_enabled` is true.
- Every other grocery feature depends on the list type alone and stays when the switch is off:
  - Not available, On the way, Repeat and Not needed this week.
  - The Not available and Recurring sections.
  - The "ready" signal button.

## Server

### One database function for the switch

`set_list_categories_enabled(p_list_id UUID, p_enabled BOOLEAN) RETURNS SETOF lists`, service role only.

- **First, the list row.** It updates the live list's `categories_enabled`. Turning off also clears
  `categories_rescan_at`. The update takes the list row lock, and a missing or deleted list returns
  no row.
- **Off, then cleanup in the same transaction:**
  - It deletes the list's `list_categories` rows.
  - It sets `category_id = NULL` and `category_locked = false` on every item of the list that has
    either, completed and deleted items included.
- **On** only sets the flag. A list that was off is already clean, and a repeated "on" (a second
  tap, another device) must never wipe a list that is sorted.
- It returns the updated list row.

### The categorizer's writes check the switch under the same lock

Both existing write functions are re-created in the same migration, with the same signatures:

- **`insert_list_category`** already locks the list row (`FOR UPDATE`). It now also returns no row when
  `categories_enabled` is false.
- **`apply_item_categories`** first takes the list row `FOR SHARE` with `categories_enabled` true, and
  returns 0 when there is no such row.

Because the switch function takes the same row lock first, a sort already running can't leave
anything behind:

- If the cleanup goes first, the late write sees the switch off and writes nothing.
- If the write goes first, the cleanup waits for it and then removes it.

Without this, a sort in the middle of its AI call when the owner turns categories off would leave
categories behind, and turning on would no longer start from zero.

### The categorizer (`src/services/categorize-list.ts`)

- **Entry gate:** it reads `type, categories_enabled` and returns unless the list is grocery with
  categories on.
- **Under the lock:** `runOnce` reads `type, categories_enabled, categories_rescan_at` in its existing
  read. It returns before any AI call or write when the list is no longer grocery with categories
  on. So a run, and its reruns, stop at the next round after the switch goes off.
- **Inserts:** an insert that returns no row (the cap, or now the switch off) is already skipped. Its
  comment names both causes.

### Routes

- **PATCH `/api/lists`:**
  - `updateListSchema` gains `categoriesEnabled: z.boolean().optional()`. It is owner-only, like
    every list setting.
  - Other fields are updated as today. Then, if `categoriesEnabled` is present, the route calls
    `set_list_categories_enabled` and answers with its row.
  - Turning on schedules `categorizeList(pending)` with `after()`, as a switch to grocery does.
  - "No updates provided" counts `categoriesEnabled` as an update.
  - A failure answers through `dbError` (500).
- **GET `/api/lists`:** both selects return `categories_enabled`, and so does the hand-written collab
  type.
- **GET `/items` sweep:** it reads `type, categories_enabled, categories_rescan_at`. It schedules a
  sort only for a grocery list with categories on. Otherwise a list with categories off would try a
  sort on every open, because none of its items has a category.
- **POST `/categories`** (only a sheet left open on an older screen can reach it while off):
  - It reads `categories_enabled` with its existing cap pre-check, and answers 409 "Categories are
    off for this list" before the translation AI call.
  - Its no-row answer from the insert function now names both causes.
- **Item PATCH `categoryId`** (a drag queued offline before the switch went off): the category is
  gone, so it gets the existing 400 "Unknown category", which the queue drops. No change.

## App

- **`useListData`:**
  - `categoriesEnabled` state, read from the list summary (`categories_enabled !== false`), with
    its setter returned.
  - `clearCategorization()` empties `categories` and sets `category_id: null` and
    `category_locked: false` on every item on screen that has either. When nothing changes, it
    returns the same array. Turning off locally and an "off" from realtime both use it, so the
    screen matches the cleanup without waiting for its echoes.
  - Without it, an item still carrying a deleted category would stay under "Sorting…" after turning
    back on, because the sorting retry only fills items with no category.
- **`useListRealtime`:** a `lists` UPDATE with a boolean `categories_enabled` sets the state. When it
  is false, it also calls `clearCategorization()`. That call is idempotent, so it's safe on every
  update, since the full row comes with each one.
- **The list page:**
  - `grouped: listType === "grocery" && categoriesEnabled`. When off, the list is flat, "Sorting…"
    and its retry are gone, and a drag is a plain reorder.
  - **The switch row** sits in the settings sheet, only on grocery lists, below the type control.
    - Its label is "Sort into categories".
    - It is a `role="switch"` button with `aria-checked` and a 44px touch target. Its knob moves the
      right way in RTL.
    - It is built in the app's own tokens. The app has no switch component yet.
  - **Turning off** asks first, with `askConfirm`. A confirmed off:
    - It sets the state and calls `clearCategorization()` right away, then PATCHes.
    - A failed save restores the state and reloads the categories (`loadCategories()`), with the
      usual `errors.generic` toast.
  - **Turning on:**
    - It sets the state, then PATCHes. A failed save sets it back, with the same toast.
    - While the AI sorts, every item shows under "Sorting…". Categories and assignments arrive by
      realtime, and the existing sorting retry covers a missed echo.
  - **Categories button:** shown only while the switch is on.

## Copy

| Key | en | he | ru |
|---|---|---|---|
| `categories.enabled` | Sort into categories | מיון לפי קטגוריות | Сортировка по категориям |
| `categories.confirmOff` | Turn off sorting? The list's categories and their order will be deleted. | לכבות את המיון? הקטגוריות של הרשימה והסדר שלהן יימחקו. | Отключить сортировку? Категории списка и их порядок будут удалены. |

## Inverse cases

- **On, then off, then on:** each off cleans up, and each on sorts from zero.
- **Off on an already-off list** (a second device): cleans up again, which is harmless.
- **On on an already-on list:** sets the flag, which is unchanged, and schedules a pending sort that
  finds nothing to do. Nothing is wiped.
- **Grocery → Regular → Grocery:** the switch keeps its value, so a list that was off stays off. The
  switch to grocery schedules a sort, and the gate stops it. Switching to Regular still keeps
  categories, as today.
- **A sort mid-AI-call when turned off:** its writes are refused under the list lock (see above). The
  run stops at its next round.
- **Off, then on, during one AI call:** the old run's assignments point at deleted categories and are
  refused. Any new categories it inserts come from that call. The pending sort that the "on"
  scheduled sorts the rest.
- **Offline:** the switch is a direct save. It fails and flips back, as the type control does.
- **Home order:** changing the switch bumps `lists.updated_at` like any setting, so the list moves up
  on the home screen of users who haven't dragged their lists. That's the same as changing the type
  or color.
- **Editors and viewers** see the switch, as they see the type control today. The server refuses
  them with 403, and the switch flips back with the toast. A refused off also reloads the categories.

## Non-goals

- No global switch and no create-sheet switch.
- No undo of the cleanup. The confirmation is the guard.
- No refusal on the category rename, delete or reorder routes while off. With no rows, they have
  nothing to act on.

## Tests

- **SQL** (in-memory PGlite, scratch only):
  - Off deletes categories, nulls and unlocks items, clears the owed re-scan and returns the row.
  - On only sets the flag.
  - Both write functions refuse while off and work while on.
- **`categorize-list.test.ts`:**
  - Off at the entry gate: no lock is taken and no AI call is made.
  - Off under the lock: no AI call and no writes.
  - The gate's failed-read path still works.
- **`items-route-categorize.test.ts`:** no sweep when off.
- **`lists-route-categorize.test.ts`** (or a sibling):
  - `categoriesEnabled` calls the function with the right arguments.
  - On schedules a pending sort, and off doesn't.
  - Owner-only.
  - A failed function call answers 500.
  - The "no updates" check counts it.
- **`categories-routes.test.ts`:** POST answers 409 while off, with no AI call.
- **GET `/api/lists`:** both selects carry `categories_enabled`.
- **`list-realtime-metadata.test.ts`:** an UPDATE sets the state, and an off clears categorization.
- **`useListData`:** `clearCategorization` clears what it should and returns the same array when there
  is nothing to clear.
- **Page:**
  - The rendered switch shows only on grocery lists.
  - Turning off asks first, and clears before saving.
  - A failed save restores the state.
  - Turning on PATCHes.
  - The Categories button follows the switch.
  - `grouped` follows the switch.
  - Update `grouped-list-wiring.test.ts` and `categories-sheet-wiring.test.ts` so they bite on the
    new gate.
- **Locale parity.**
- **Bite checks:** remove each guard once and see its test go red.
