# "On the way" (ordered) item state — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users mark a grocery item as "on the way" (ordered online, not yet received); it leaves the active list, sits in its own "On the way" section, and is checked off as done when it arrives.

**Architecture:** Mirror the existing `skipped_at` state end-to-end — a new `ordered_at` timestamp column, a PATCH `ordered` flag, a derived `orderedItems` group, a collapsible "On the way" section, and a truck row button. Received reuses the normal completion path. Grocery lists only.

**Tech Stack:** Next.js 16 / React 19 / TypeScript, Supabase (Postgres), zod schemas, next-intl i18n, vitest unit tests, Tailwind 4.

## Global Constraints

- Grocery lists only — no behavior change for `regular` / `reminders` lists.
- An item is in exactly one secondary state: marking ordered clears `skipped_at`; marking skipped clears `ordered_at`.
- `ordered_at` **never auto-resets** (unlike skip's 4-hour rule in `useListData.ts`).
- Migrations apply automatically via `scripts/migrate.mjs` on build — never add a manual migration step.
- Mirror existing UI patterns (skip button / `SkippedItemsSection`); reuse `--list-*` / `tg-*` tokens, no new palettes.
- Tests follow the pure-function pattern in `__tests__/unit/` (no DOM env configured).

---

### Task 1: Data layer — column, type, GET select

**Files:**
- Create: `supabase/migrations/023_item_ordered_at.sql`
- Modify: `src/types/items.ts` (add field to `ItemData`)
- Modify: `app/api/lists/[id]/items/route.ts:39` (GET select list)
- Modify: `__tests__/unit/list-helpers.test.ts:14`, `__tests__/unit/gen-mut-id.test.ts:12` (makeItem factories)

**Interfaces:**
- Produces: `ItemData.ordered_at: string | null`; DB column `items.ordered_at TIMESTAMPTZ`; GET returns `ordered_at`.

- [ ] **Step 1: Create the migration**

`supabase/migrations/023_item_ordered_at.sql`:
```sql
-- Items ordered online but not yet received ("On the way"). Mirrors skipped_at,
-- but never auto-resets. Grocery lists only (enforced client-side).
ALTER TABLE items ADD COLUMN ordered_at TIMESTAMPTZ;

CREATE INDEX idx_items_ordered_at ON items(list_id) WHERE ordered_at IS NOT NULL;
```

- [ ] **Step 2: Add the type field**

`src/types/items.ts` — add after the `skipped_at` line:
```typescript
  skipped_at: string | null;
  ordered_at: string | null;
```

- [ ] **Step 3: Return the column from GET**

`app/api/lists/[id]/items/route.ts:39` — add `ordered_at` to the select string (after `skipped_at`):
```typescript
    .select("id, text, completed, completed_at, deleted_at, skipped_at, ordered_at, recurring, position, created_by, edited_by, created_at, users!created_by(name), editor:users!edited_by(name)")
```

- [ ] **Step 4: Add `ordered_at` to the two test factories**

In `__tests__/unit/list-helpers.test.ts` and `__tests__/unit/gen-mut-id.test.ts`, add to the `makeItem` defaults (after `skipped_at: null,`):
```typescript
    skipped_at: null,
    ordered_at: null,
```

- [ ] **Step 5: Verify it compiles and existing tests pass**

Run: `npx tsc --noEmit`
Expected: errors ONLY in `src/hooks/useItemHandlers.ts` (full `ItemData` literals missing `ordered_at`) — fixed in Task 4. No other files.

Run: `npm run test:run`
Expected: PASS (factories now satisfy the type).

- [ ] **Step 6: Commit**
```bash
git add supabase/migrations/023_item_ordered_at.sql src/types/items.ts "app/api/lists/[id]/items/route.ts" __tests__/unit/list-helpers.test.ts __tests__/unit/gen-mut-id.test.ts
git commit -m "Add ordered_at column, type field, and GET projection"
```

---

### Task 2: Pure section predicates + derived data (TDD)

**Files:**
- Modify: `src/utils/list-helpers.ts` (add three predicates)
- Test: `__tests__/unit/item-sections.test.ts` (new)
- Modify: `src/hooks/useListDerivedData.ts` (use predicates, add `orderedItems`)

**Interfaces:**
- Consumes: `ItemData.ordered_at` (Task 1).
- Produces: `isActiveItem`, `isSkippedItem`, `isOrderedItem: (i: ItemData) => boolean`; `useListDerivedData` returns `orderedItems: ItemData[]`.

- [ ] **Step 1: Write the failing test**

`__tests__/unit/item-sections.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { isActiveItem, isSkippedItem, isOrderedItem } from "@/src/utils/list-helpers";
import type { ItemData } from "@/src/types";

function makeItem(overrides: Partial<ItemData> = {}): ItemData {
  return {
    id: "x", text: "t", completed: false, completed_at: null,
    deleted_at: null, skipped_at: null, ordered_at: null, recurring: false,
    position: 1, created_by: null, creator_name: null, edited_by: null, editor_name: null,
    ...overrides,
  };
}

describe("item section predicates", () => {
  it("ordered item is ordered, not active, not skipped", () => {
    const i = makeItem({ ordered_at: "2026-06-26T00:00:00Z" });
    expect(isOrderedItem(i)).toBe(true);
    expect(isActiveItem(i)).toBe(false);
    expect(isSkippedItem(i)).toBe(false);
  });

  it("ordered takes precedence over a stray skipped_at", () => {
    const i = makeItem({ ordered_at: "2026-06-26T00:00:00Z", skipped_at: "2026-06-26T00:00:00Z" });
    expect(isOrderedItem(i)).toBe(true);
    expect(isSkippedItem(i)).toBe(false);
  });

  it("plain item is active only", () => {
    const i = makeItem();
    expect(isActiveItem(i)).toBe(true);
    expect(isOrderedItem(i)).toBe(false);
    expect(isSkippedItem(i)).toBe(false);
  });

  it("completed/deleted ordered item is not in the ordered group", () => {
    expect(isOrderedItem(makeItem({ ordered_at: "x", completed: true }))).toBe(false);
    expect(isOrderedItem(makeItem({ ordered_at: "x", deleted_at: "x" }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/unit/item-sections.test.ts`
Expected: FAIL — `isActiveItem` / `isSkippedItem` / `isOrderedItem` not exported.

- [ ] **Step 3: Implement the predicates**

Append to `src/utils/list-helpers.ts`:
```typescript
import type { ItemData } from "@/src/types";

// Secondary item-state predicates. Mutually exclusive over non-completed,
// non-deleted items; "ordered" takes precedence over a stray "skipped".
export const isOrderedItem = (i: ItemData): boolean =>
  !i.completed && !i.deleted_at && !!i.ordered_at;

export const isSkippedItem = (i: ItemData): boolean =>
  !i.completed && !i.deleted_at && !!i.skipped_at && !i.ordered_at;

export const isActiveItem = (i: ItemData): boolean =>
  !i.completed && !i.deleted_at && !i.skipped_at && !i.ordered_at;
```
(If `list-helpers.ts` already imports `ItemData`, reuse the existing import instead of adding a duplicate.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/unit/item-sections.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the hook to the predicates and add `orderedItems`**

`src/hooks/useListDerivedData.ts` — update the import, the `activeItems`/`skippedItems` filters, add `orderedItems`, and return it:
```typescript
import { groupByCompletionTime, isActiveItem, isSkippedItem, isOrderedItem } from "@/src/utils/list-helpers";
```
```typescript
  const activeItems = useMemo(
    () => items.filter(isActiveItem).sort((a, b) => b.position - a.position),
    [items]
  );

  const orderedItems = useMemo(
    () => items.filter(isOrderedItem).sort((a, b) => b.position - a.position),
    [items]
  );

  const skippedItems = useMemo(
    () => items.filter(isSkippedItem).sort((a, b) => b.position - a.position),
    [items]
  );
```
Return statement:
```typescript
  return { activeItems, orderedItems, skippedItems, recurringItems, completedItems, completedGroups, duplicateTexts };
```

- [ ] **Step 6: Verify and commit**

Run: `npx tsc --noEmit` (expect only the Task-4 `useItemHandlers` literal errors) and `npm run test:run` (expect PASS).
```bash
git add src/utils/list-helpers.ts __tests__/unit/item-sections.test.ts src/hooks/useListDerivedData.ts
git commit -m "Add ordered/active/skipped section predicates and orderedItems group"
```

---

### Task 3: API — PATCH `ordered` flag + mutual exclusion

**Files:**
- Modify: `src/schemas/items.ts:18-27` (`updateItemSchema`)
- Modify: `app/api/lists/[id]/items/route.ts` (PATCH handler, ~311-326)

**Interfaces:**
- Consumes: `items.ordered_at` (Task 1).
- Produces: `PATCH /items` accepts `{ itemId, ordered: boolean }`; sets/clears `ordered_at`, clears `skipped_at` when ordering; `skipped:true` clears `ordered_at`; `restoreRecurring` clears `ordered_at`.

- [ ] **Step 1: Extend the schema**

`src/schemas/items.ts` — add to `updateItemSchema` (after `skipped`):
```typescript
  skipped: z.boolean().optional(),
  ordered: z.boolean().optional(),
```

- [ ] **Step 2: Handle `ordered` and mutual exclusion in PATCH**

`app/api/lists/[id]/items/route.ts` — replace the existing `skipped` block (lines 311-313) with:
```typescript
  if (typeof updates.skipped === "boolean") {
    patchData.skipped_at = updates.skipped ? new Date().toISOString() : null;
    if (updates.skipped) patchData.ordered_at = null; // mutually exclusive states
  }

  if (typeof updates.ordered === "boolean") {
    patchData.ordered_at = updates.ordered ? new Date().toISOString() : null;
    if (updates.ordered) patchData.skipped_at = null; // mutually exclusive states
  }
```
And in the `restoreRecurring` block (after `patchData.skipped_at = null;`, ~line 324) add:
```typescript
    patchData.ordered_at = null;
```

- [ ] **Step 3: Verify and commit**

Run: `npx tsc --noEmit` (still only the Task-4 literal errors).
```bash
git add src/schemas/items.ts "app/api/lists/[id]/items/route.ts"
git commit -m "PATCH /items: support ordered flag with skip/order mutual exclusion"
```

---

### Task 4: Optimistic handler `handleOrder` + clear-ordered on restore paths

**Files:**
- Modify: `src/hooks/useItemHandlers.ts` (add `handleOrder`; add `ordered_at` to literals; clear on restore/recycle)

**Interfaces:**
- Consumes: PATCH `ordered` (Task 3).
- Produces: `handleOrder: (itemId: string, ordered: boolean) => void`, returned from `useItemHandlers`.

- [ ] **Step 1: Add `ordered_at: null` to the two full `ItemData` literals**

`src/hooks/useItemHandlers.ts:52` (addSingleItem `newItem`) and `:224` (recurring occurrence) — after each `skipped_at: null,` add:
```typescript
        skipped_at: null,
        ordered_at: null,
```

- [ ] **Step 2: Clear `ordered_at` on restore-to-active spreads**

In the three "bring back to active" spreads, add `ordered_at: null`:
- `:126` recycle optimistic: `{ ...i, completed: false, completed_at: null, deleted_at: null, skipped_at: null, ordered_at: null, created_by: userId, creator_name: null }`
- `:424` handleRestoreRecurring optimistic: `{ ...i, completed: false, completed_at: null, deleted_at: null, skipped_at: null, ordered_at: null, position: Date.now() }`

- [ ] **Step 3: Add `handleOrder` (mirrors `handleSkip`)**

Insert after `handleSkip` (after line 382):
```typescript
  const handleOrder = useCallback(
    (itemId: string, ordered: boolean) => {
      const tg = getTelegramWebApp();
      tg?.HapticFeedback?.impactOccurred("light");

      // Optimistic update — ordered and skipped are mutually exclusive
      setItems((prev) =>
        prev.map((i) =>
          i.id === itemId
            ? { ...i, ordered_at: ordered ? new Date().toISOString() : null, skipped_at: ordered ? null : i.skipped_at }
            : i
        )
      );

      const mutId = genMutId();
      addMutation({
        id: mutId,
        type: "order",
        payload: { listId, itemId, ordered },
        execute: async () => {
          const jwt = jwtRef.current;
          const res = await fetch(`/api/lists/${listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId, ordered }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Order failed: ${res.status}`);
        },
      });
    },
    [jwtRef, listId, addMutation, setItems]
  );
```

- [ ] **Step 4: Export it**

Update the return object (line 671) to include `handleOrder`:
```typescript
  return { handleAddItem, handleToggle, handleDelete, handleEditItem, handleSkip, handleOrder, handleSetRecurring, handleRestoreRecurring, handleRemoveDuplicates, handleClearCompleted, handleRemind, handleSetReminder, handleUpdateReminder, handleCancelReminder };
```

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit`
Expected: PASS (all `ItemData` literal errors resolved).
Run: `npm run test:run` → PASS.
```bash
git add src/hooks/useItemHandlers.ts
git commit -m "Add handleOrder optimistic handler; clear ordered_at on restore paths"
```

---

### Task 5: Row UI — truck button (ItemRow + SortableItem passthrough)

**Files:**
- Modify: `components/ItemRow.tsx` (import `Truck`; add `ordered`/`onOrder` props + button)
- Modify: `components/SortableItem.tsx` (add `ordered`/`onOrder` props + passthrough)

**Interfaces:**
- Consumes: `handleOrder` (Task 4).
- Produces: `ItemRow` and `SortableItem` accept `ordered?: boolean` and `onOrder?: (id: string, ordered: boolean) => void`.

- [ ] **Step 1: Import the icon**

`components/ItemRow.tsx:5` — add `Truck` to the lucide import:
```typescript
import { Bell, Check, CircleOff, Clock, Copy, Pencil, Repeat, RotateCcw, Truck, X } from "lucide-react";
```

- [ ] **Step 2: Add the props**

`components/ItemRow.tsx` — in `ItemRowProps` (after the `onSkip` line) and in the destructured params (after `onSkip,`):
```typescript
  ordered?: boolean;
  onOrder?: (id: string, ordered: boolean) => void;
```

- [ ] **Step 3: Render the button**

In `components/ItemRow.tsx`, immediately after the skip-button block (after line 213, before the recurring block), add:
```tsx
      {onOrder && !completed && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            const tg = getTelegramWebApp();
            tg?.HapticFeedback?.impactOccurred("light");
            onOrder(id, !ordered);
          }}
          className="p-1.5 rounded-full shrink-0"
          aria-label={ordered ? t("ordered.restore") : t("ordered.toggleOn")}
        >
          {ordered ? (
            <RotateCcw className="w-[18px] h-[18px] text-tg-link" />
          ) : (
            <Truck className="w-[18px] h-[18px] text-tg-hint" />
          )}
        </button>
      )}
```

- [ ] **Step 4: Thread the props through `SortableItem`**

`components/SortableItem.tsx` — add to `SortableItemProps` (after `onSkip`), to the destructure (after `onSkip,`), and to the `<ItemRow>` (after `onSkip={onSkip}`):
```typescript
  ordered?: boolean;
  onOrder?: (id: string, ordered: boolean) => void;
```
```tsx
        onSkip={onSkip}
        ordered={ordered}
        onOrder={onOrder}
```

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit` → PASS.
```bash
git add components/ItemRow.tsx components/SortableItem.tsx
git commit -m "ItemRow: add truck (on the way) button; SortableItem passthrough"
```

---

### Task 6: "On the way" section + page wiring + i18n

**Files:**
- Create: `components/list/OrderedItemsSection.tsx`
- Modify: `app/list/[id]/page.tsx` (import, panel state, derived destructure, active-row props, render section, empty-state)
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json`

**Interfaces:**
- Consumes: `orderedItems` (Task 2), `handleOrder` (Task 4), `OrderedItemsSection`.

- [ ] **Step 1: Create the section component**

`components/list/OrderedItemsSection.tsx`:
```tsx
"use client";

import { ChevronDown, ChevronRight, Truck } from "lucide-react";
import { useTranslations } from "next-intl";
import ItemRow from "@/components/ItemRow";
import type { ItemData } from "@/src/types";
import { normalizeForCompare } from "@/src/utils/text-normalize";

interface OrderedItemsSectionProps {
  orderedItems: ItemData[];
  showOrdered: boolean;
  setShowOrdered: React.Dispatch<React.SetStateAction<boolean>>;
  duplicateTexts: Set<string>;
  isShared: boolean;
  userId: string | null;
  onToggle: (id: string, completed: boolean) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, newText: string) => void;
  onOrder: (id: string, ordered: boolean) => void;
}

export default function OrderedItemsSection({
  orderedItems,
  showOrdered,
  setShowOrdered,
  duplicateTexts,
  isShared,
  userId,
  onToggle,
  onDelete,
  onEdit,
  onOrder,
}: OrderedItemsSectionProps) {
  const t = useTranslations();

  if (orderedItems.length === 0) return null;

  return (
    <>
      <button
        onClick={() => setShowOrdered((p) => { localStorage.setItem("panel_ordered", String(!p)); return !p; })}
        className="flex items-center gap-2.5 w-full px-5 py-3.5 text-[13px] font-medium tracking-wide text-tg-hint bg-tg-secondary-bg/80 backdrop-blur-md border-t border-separator"
      >
        {showOrdered ? (
          <ChevronDown className="w-4 h-4" />
        ) : (
          <ChevronRight className="w-4 h-4 rtl:scale-x-[-1]" />
        )}
        <Truck className="w-3.5 h-3.5" style={{ color: "var(--list-blue)" }} strokeWidth={2.5} />
        {t('items.orderedSection', { count: orderedItems.length })}
      </button>
      {showOrdered && (
        <div className="item-enter">
          {orderedItems.map((item) => (
            <ItemRow
              key={item.id}
              id={item.id}
              text={item.text}
              completed={false}
              ordered={true}
              isDuplicate={duplicateTexts.has(normalizeForCompare(item.text))}
              creatorName={isShared ? item.creator_name : null}
              isOwnItem={item.created_by === userId}
              editorName={isShared ? item.editor_name : null}
              isOwnEdit={item.edited_by === userId || item.edited_by === item.created_by}
              onToggle={onToggle}
              onDelete={onDelete}
              onEdit={onEdit}
              onOrder={onOrder}
            />
          ))}
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Add i18n keys (en, he, ru)**

In each `messages/{en,he,ru}.json`, after the `"skippedSection"` line (79), insert an `orderedSection` line and an `ordered` object. Use these values:

`en.json`:
```json
    "skippedSection": "Not available ({count})",
    "orderedSection": "On the way ({count})",
    "ordered": {
      "toggleOn": "Mark as ordered",
      "restore": "Add back to list"
    },
```
`he.json`:
```json
    "skippedSection": "לא זמין ({count})",
    "orderedSection": "בדרך ({count})",
    "ordered": {
      "toggleOn": "סמן כהוזמן",
      "restore": "החזר לרשימה"
    },
```
`ru.json`:
```json
    "skippedSection": "Нет в наличии ({count})",
    "orderedSection": "В пути ({count})",
    "ordered": {
      "toggleOn": "Отметить как заказанное",
      "restore": "Вернуть в список"
    },
```

- [ ] **Step 3: Import + panel state in the page**

`app/list/[id]/page.tsx` — add the import next to `SkippedItemsSection` (line 14):
```typescript
import OrderedItemsSection from "@/components/list/OrderedItemsSection";
```
Add panel state after the `showSkipped` block (after line 60):
```typescript
  const [showOrdered, setShowOrdered] = useState(() => {
    if (typeof window === "undefined") return false;
    const v = localStorage.getItem("panel_ordered");
    return v === null ? false : v === "true";
  });
```

- [ ] **Step 4: Destructure `orderedItems` and `handleOrder`**

Line 155 — add `orderedItems` to the `useListDerivedData` destructure:
```typescript
  const { activeItems, orderedItems, skippedItems, recurringItems, completedItems, completedGroups, duplicateTexts } =
    useListDerivedData(items, t as (key: string) => string);
```
Line 102 — add `handleOrder` to the `useItemHandlers` destructure:
```typescript
  const { handleAddItem, handleToggle, handleDelete, handleEditItem, handleSkip, handleOrder, handleSetRecurring, handleRestoreRecurring, handleRemoveDuplicates, handleClearCompleted, handleRemind, handleSetReminder, handleUpdateReminder, handleCancelReminder } =
```

- [ ] **Step 5: Pass order props to active rows**

In the active `SortableItem` (after line 252 `onSkip={...}`), add:
```tsx
                  onSkip={listType === "grocery" ? handleSkip : undefined}
                  ordered={item.ordered_at != null}
                  onOrder={listType === "grocery" ? handleOrder : undefined}
```

- [ ] **Step 6: Render the section (above "Not available")**

In the grocery sections block, insert `OrderedItemsSection` BEFORE `SkippedItemsSection` (before line 264):
```tsx
            {listType === "grocery" && (
              <>
                <OrderedItemsSection
                  orderedItems={orderedItems}
                  showOrdered={showOrdered}
                  setShowOrdered={setShowOrdered}
                  duplicateTexts={duplicateTexts}
                  isShared={isShared}
                  userId={userId}
                  onToggle={handleToggle}
                  onDelete={handleDelete}
                  onEdit={handleEditItem}
                  onOrder={handleOrder}
                />
                <SkippedItemsSection
```

- [ ] **Step 7: Include ordered items in the empty-state guard**

Line 302 — add `orderedItems.length === 0 &&`:
```tsx
        {activeItems.length === 0 && orderedItems.length === 0 && skippedItems.length === 0 && recurringItems.length === 0 && completedItems.length === 0 && (
```

- [ ] **Step 8: Verify and commit**

Run: `npx tsc --noEmit` → PASS. Run: `npm run lint` → no new errors.
```bash
git add components/list/OrderedItemsSection.tsx "app/list/[id]/page.tsx" messages/en.json messages/he.json messages/ru.json
git commit -m "Add On the way section, page wiring, and i18n for ordered items"
```

---

### Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Type-check, lint, unit tests, build**

```bash
npx tsc --noEmit          # expect: clean
npm run lint              # expect: no new errors
npm run test:run          # expect: all pass (incl. item-sections.test.ts)
npm run build             # expect: success (ENVIRONMENT_FALLBACK static-gen warning is pre-existing, not a failure)
```

- [ ] **Step 2: Manual checklist (grocery list)**

- Tap the truck on an active item → it leaves the active list and appears under "On the way".
- Confirm it does NOT auto-disappear after 4h (no skip-style reset).
- Tap its checkbox in "On the way" → moves to Completed.
- Tap the ↺ on an "On the way" item → returns to the active list.
- Mark an item skipped, then ordered → it moves out of "Not available" into "On the way" (and vice-versa).
- Verify `regular` and `reminders` lists show no truck button and no "On the way" section.

---

## Self-Review

**Spec coverage:** column + index (T1) ✓; type field (T1) ✓; GET projection (T1, required — GET uses an explicit column list) ✓; PATCH `ordered` + mutual exclusion + restoreRecurring clear (T3) ✓; optimistic `handleOrder` (T4) ✓; no auto-reset — verified by *not* touching `useListData`'s 4h block ✓; active filter excludes ordered + `orderedItems` group (T2) ✓; "On the way" section above "Not available" (T6) ✓; truck button side-by-side with skip on active rows (T5/T6) ✓; received = done via existing toggle (`onToggle` passed to section rows, T6) ✓; i18n en/he/ru (T6) ✓; realtime unchanged (generic merge carries `ordered_at`) ✓; unit tests (T2) ✓.

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `handleOrder(itemId, ordered)` / `onOrder(id, ordered)` / PATCH `{ ordered }` / `ordered_at` consistent across T2–T6. `ItemData` literal sites enumerated (useItemHandlers :52,:224 full literals; :126,:424 restore spreads; useListData :124 respawn — note: T4 covers useItemHandlers; `useListData.ts:124` respawn spread also clears flags but spreads `...base` which already carries `ordered_at`, and a respawned recurring item should drop it — handled in T4's restore semantics only for the handler; `useListData:124` returns to active so add `ordered_at: null` there too).

**Gap found & folded in:** `useListData.ts:124` (recurring auto-respawn) returns an item to active and should null `ordered_at`. Add to Task 4 Step 2: in `src/hooks/useListData.ts:124`, add `ordered_at: null` to the returned spread.
