# Item sheet and quantity

**Date:** 2026-11-08
**Status:** owner's decisions taken (2026-11-08); waiting for spec approval.

## Owner's decisions

1. **The problem:** on grocery lists the row's icons squeeze the item name. A recurring item shows five
   (Not available, On the way, Not needed this week, Repeat, Delete). They take about 208px of a 390px
   phone, which leaves the name about 108px.
2. **Row shape: an item sheet.** A grocery row keeps the circle, the name, the quantity and small status
   marks. Tapping the name opens a sheet with the name and quantity fields and every action, Delete
   included. This supersedes the 2026-11-07 decision to put "Not needed this week" on the row.
3. **Quantity is free text:** "2", "1.5 kg", "3 packs", "500 g". It is optional and has no units list
   and no stepper.
4. **Grocery lists only.** Regular lists show no quantity.
5. **Voice fills it:** "two litres of milk" gives the name "milk" and the quantity "2 litres".
6. **A returning item keeps its quantity.** That covers typing it again, tapping a suggestion, and a
   recurring item coming back. A quantity said by voice replaces the old one.
7. **Typed text is never parsed.** "milk 2" in the add box is the name "milk 2". The quantity is set
   in the sheet.

### Defaults I chose (small calls)

- **Regular lists keep today's row:** tap the name to edit it in place, and X deletes. They have
  one icon, so the problem doesn't exist there, and a sheet would make edit and delete slower.
- **Completed rows keep today's row** (X, and the name can't be edited). They also show the quantity.
- **Not available rows** keep their one inline button, Back to the list, because it's what you do
  there. Delete moves into the sheet.
- **The duplicate mark stays tappable**, as today: it removes the duplicates.
- **The sheet doesn't open the keyboard by itself.** That would cover the actions. You tap the name
  field to edit it.

## Model

- Migration `033_item_quantity.sql`:
  `ALTER TABLE items ADD COLUMN IF NOT EXISTS quantity TEXT CHECK (quantity IS NULL OR char_length(quantity) BETWEEN 1 AND 30);`
- `null` means no quantity. It is never an empty string.
- Realtime already publishes every column of `items` (`REPLICA IDENTITY FULL`), so a new column reaches
  other devices with no change.
- The name (`text`) stays the item's identity. Duplicates, recycling, the categorizer's text reuse,
  the realtime echo match and search all keep comparing names only. "milk" with 2 L and "milk" with
  1 L are duplicates.

## Server

- **GET `/items`:** the explicit select adds `quantity`.
- **PATCH `/items`:** `updateItemSchema` gains `quantity: z.string().max(60).nullable().optional()`.
  - The route runs `normalizeForStorage`. An empty result is stored as `null`, and more than 30
    characters answers 400.
  - It sets `edited_by` like a name edit, so collaborators see who changed it.
  - It doesn't re-sort the item's category. Only a name change does.
- **Create** is unchanged: an item typed in the app has no quantity. The create RPC isn't touched.
- **Recycle** (`recycleItem`) gains an optional `quantity`. When it is passed (voice), the same update
  sets it. The app's recycle passes nothing, so the old quantity stays.
- **Recurring respawn, Not needed this week, skip, order, undo, clear, unmark** leave `quantity`
  alone. They already write only their own columns.

## Voice

- **Schema:** each item gains `quantity: { type: ["string", "null"] }`, and `required` doesn't change.
- **Prompt:** one rule is added. If the speaker gives an amount for an item (a count, weight, volume or
  packs), it goes in `quantity` as said, in the speaker's language ("2", "1.5 kg", "2 ליטר",
  "3 пачки"), and is kept out of `text`. Otherwise `quantity` is null. Remove actions never carry
  one. The model stays `gemini-3.8-flash`.
- **Parsing** (`parseVoiceResult`):
  - It copies a string quantity through `normalizeForStorage`. Empty becomes null.
  - A quantity over 30 characters is put back into the name, as `text quantity`, so it isn't lost.
- **Adding to a grocery list:**
  - **New item:** the insert carries the quantity.
  - **Fuzzy recycle:** the recycle sets the quantity when one was said, and otherwise keeps the old
    one.
  - Matching now uses the name without the amount. "two litres of milk" now finds a bought "milk",
    where before it created a second item.
- **Adding to a regular list:** the quantity is put back into the name (`text quantity`), so voice
  keeps the amount in the name as it does today.
- **Receipt line:** `- name, quantity` when there is a quantity.

## App

### Data and sync

- **`ItemData`:** gains `quantity?: string | null`. The temp row in `addSingleItem` sets
  `quantity: null`.
- **`handleSetQuantity(itemId, quantity | null)`:**
  - It sets the quantity optimistically, with `edited_by: userId`.
  - It queues the new mutation `set-quantity` `{ listId, itemId, quantity }`.
  - The engine's `FIELDS` gets `"set-quantity": ["quantity"]`, so an echo can't undo a queued value.
  - The executor's `case` sends `PATCH { itemId, quantity }`.
  - The new type is added to the guards: `single-executor`, `executor-factory` `REPLAYABLE_TYPES`,
    `mutation-request-parity` `SAMPLES`, and the `sync-engine` pending-field test.
- **A change on a temp (unsaved) item** waits for its create, as every change does today.

### The grocery row (`ItemRow`, when the page passes `onOpenDetails`)

- **Leading:** the circle, unchanged.
- **The name** wraps as today. After it come small marks (14px, not buttons):
  - On the way: an amber `Truck`, stroke 3. It stays visible on the row, for the 2026-06-26 reason:
    on a shared list, the other person must see the item is handled.
  - Recurring: a `Repeat` in `tg-active`, stroke 3.
  - The duplicate `Copy`, tappable as today.
  - The pending `Clock`.
- **Trailing:** the quantity in `tg-hint`, aligned to the row's end. It wraps rather than pushing
  the name out.
- **No trailing buttons** on active rows. On Not available rows, only Back to the list.
- **Tapping anywhere in the name column** (name, marks, quantity, empty space) opens the sheet. It no
  longer edits in place. A long press still drags the row, and the circle still checks it off.
- **Creator/editor line:** unchanged.

### The item sheet (`components/list/ItemSheet.tsx`, grocery lists only)

- **Opening:** the page holds `sheetItemId`. The sheet reads the live item from the items state, so a
  change from another device shows up. It closes by itself when the item is deleted, completed, gone,
  or moves between the list and Not available.
- **Built in the app's sheet pattern:** backdrop, rounded top, grabber, `sheet-enter`. Mirror the
  existing sheets and tokens, with no new palette. Final visuals go through the frontend-design skill.
- **Fields:**
  - **Name:** a growing text box, as today's edit box (max 500, a pasted line break becomes a space).
  - **Quantity:** a one-line field, max 30, with the placeholder "e.g. 2, 1 kg, 3 packs".
  - Both use a 16px font, so iOS doesn't zoom in.
  - Each field shows the live value until you type in it. After that it shows your draft.
- **Saving:** on Done, on a backdrop tap, and before any action. Enter in a field saves that field and
  leaves the sheet open.
  - **Name:** trimmed, saved only if non-empty and changed. That's today's rule.
  - **Quantity:** trimmed, saved only if changed. Empty clears it.
- **Active item:**
  - **Switches**, which flip in place: On the way and Recurring. They reuse the switch from the list
    settings, which moves into `components/ui/SwitchRow.tsx`, and the categories switch uses it too.
  - **Actions**, which act and then close the sheet: Not available, Not needed this week (recurring
    only), and Delete (destructive colour).
- **Not available item:** the actions are Back to the list and Delete.
- **Done** closes the sheet.
- **Haptics:** the same as the row buttons today.
- **Handlers:** the sheet calls the same handlers as the row did. There's no new code path for skip,
  order, recurring, pause or delete.

### Elsewhere

- **Completed rows** (grocery) and **Recurring section rows** show the quantity, read-only.
- **Regular lists:** the page passes no quantity and no `onOpenDetails`, so the row is unchanged.

## Copy

New keys:

| Key | en | he | ru |
|---|---|---|---|
| `items.sheet.name` (field label) | Item name | שם הפריט | Название |
| `items.quantity.label` | Quantity | כמות | Количество |
| `items.quantity.placeholder` | e.g. 2, 1 kg, 3 packs | למשל 2, 1 ק״ג, 3 חבילות | Например: 2, 1 кг, 3 пачки |
| `items.skip` | Not available | לא זמין | Нет в наличии |
| `items.unskip` | Back to the list | החזר לרשימה | Вернуть в список |
| `items.ordered.title` | On the way | בדרך | В пути |
| `items.recurring.title` | Recurring | חוזר | Повторяющийся |

Reused keys: `items.recurring.notThisWeek`, `common.delete`, `common.done`, and `items.ordered.label`
(the truck mark's label). The repeat mark's label is `items.recurring.title`. The old row-button
labels (`items.ordered.toggleOn`, `items.recurring.toggleOn`, `items.recurring.toggleOff`) are
removed if nothing else uses them.

## Inverse cases

- **Grocery → Regular:** quantities stay stored but hidden, and the row goes back to today's regular
  row. Switching back to grocery shows them again. Categories behave the same way.
- **Clearing a quantity** stores null. Setting it again works.
- **A sheet open while another device:**
  - **deletes the item:** it closes, and drafts are dropped.
  - **completes it, or moves it between the list and Not available:** it closes, and drafts are saved.
  - **renames it:** the name field shows the new name unless you've typed in it.
- **Offline:** `set-quantity` queues and replays like a name edit.
- **Voice on a regular list:** the amount stays in the name.
- **A returning item** keeps its quantity. A voice quantity replaces it.
- **Remove duplicates** keeps one row, with its own quantity.
- **Categories:** the quantity isn't sent to the categorizer, and changing it doesn't re-sort.

## Non-goals

- No parsing of typed text, no units list, no stepper.
- No quantity on regular lists.
- No change to regular, completed or Recurring-section rows beyond showing the quantity.
- No swipe or long-press menu.
- No quantity in the add box's suggestions.

## Tests

- **SQL** (scratch PGlite): the column, its check (null, 1..30, refuses '' and 31), and that it survives
  respawn and recycle with no quantity.
- **Routes:**
  - GET selects `quantity`.
  - PATCH `quantity` stores normalized text, maps empty to null, refuses over 30, sets `edited_by`,
    and doesn't reset the category.
  - A quantity-only PATCH isn't "No valid fields".
- **Recycler:** a passed quantity is written, and an absent one leaves the column out of the update.
- **Voice:**
  - The schema carries `quantity`.
  - Parsing: a string is normalized, empty becomes null, and an over-long quantity folds into the name.
  - Grocery insert and recycle carry it. A regular list folds it into the name.
  - The receipt shows it.
- **Sync:** the four guard tests above, plus optimistic set, echo protection while queued, and replay.
- **Row:**
  - A grocery active row renders no trailing buttons.
  - The marks follow the state.
  - The quantity shows.
  - A tap on the name calls `onOpenDetails` and opens no edit box.
  - A Not available row keeps only Back to the list.
  - A regular row is unchanged (`item-row-long-text` still passes).
- **Sheet:**
  - Each control shows for the right state.
  - Each action calls its handler and closes.
  - The switches flip without closing.
  - Saving rules for both fields, including on backdrop tap and before an action.
  - The live value until typed.
  - It closes when the item is deleted or completed.
- **`not-this-week-ui`:** moves its row assertions to the sheet.
- **Locale parity.**
- **Bite checks:** remove each guard once and see its test go red.
