# Unmark all done Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Unmark all" action to a regular list's Completed section that flips every done item back to active, instantly with an undo toast.

**Architecture:** A non-destructive clone of the existing "Clear completed" machinery: a new POST endpoint doing one bulk Supabase update, a pure helper for the optimistic client update, a hook handler mirroring `handleClearCompleted` (optimistic + undo toast + direct fetch, NOT the mutation queue), and an optional button in `CompletedItemsSection` wired only for `listType === "regular"`.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (`@/src/lib/supabase`), next-intl, vitest.

## Global Constraints

- Auth: `verifyUserAuth(request, apiRateLimiter, "<endpoint-name>")` then `verifyListPermission(auth.userId, listId, "edit")`; 403 JSON on permission failure. Imports from `@/src/lib/api-auth`, `@/src/lib/rate-limit`, `@/src/lib/supabase`.
- Frontend fetch auth header: `Authorization: \`Bearer ${jwt}\`` where `jwt = jwtRef.current` (mirror `handleClearCompleted`).
- Do NOT route through the mutation queue / `src/utils/executor-factory.ts` — direct fetch, exactly like clear-completed.
- Regular lists only: the button is gated at the `page.tsx` call site via `listType === "regular"`; the shared component stays generic.
- Tests are pure-function vitest in `__tests__/unit/*.test.ts`, no DOM.
- `ItemData` is imported from `@/src/types`.

---

### Task 1: Pure helper `computeUnmarkCompleted`

**Files:**
- Create: `src/utils/unmark-completed.ts`
- Test: `__tests__/unit/unmark-completed.test.ts`

**Interfaces:**
- Produces: `computeUnmarkCompleted(items: ItemData[]): { next: ItemData[]; affectedIds: string[] }` — returns a new array with every `completed && !deleted_at` item flipped to `{ completed: false, completed_at: null }`, and the ids of exactly those items (in encounter order). All other items are returned by reference unchanged.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { computeUnmarkCompleted } from "@/src/utils/unmark-completed";
import type { ItemData } from "@/src/types";

// Minimal ItemData factory — only the fields the helper reads/writes matter;
// cast the rest so we don't couple the test to unrelated columns.
function item(over: Partial<ItemData> & { id: string }): ItemData {
  return {
    completed: false,
    completed_at: null,
    deleted_at: null,
    skipped_at: null,
    ordered_at: null,
    recurring: false,
    text: "x",
    ...over,
  } as ItemData;
}

describe("computeUnmarkCompleted", () => {
  it("flips only completed, non-deleted items", () => {
    const items = [
      item({ id: "a", completed: true, completed_at: "2026-07-01T00:00:00Z" }),
      item({ id: "b", completed: false }),
      item({ id: "c", completed: true, completed_at: "2026-07-02T00:00:00Z", deleted_at: "2026-07-03T00:00:00Z" }),
    ];
    const { next, affectedIds } = computeUnmarkCompleted(items);

    expect(affectedIds).toEqual(["a"]);
    expect(next[0]).toMatchObject({ id: "a", completed: false, completed_at: null });
    expect(next[1]).toBe(items[1]); // untouched active item returned by reference
    expect(next[2]).toBe(items[2]); // deleted-but-completed item left alone
  });

  it("returns empty affectedIds when nothing is completed", () => {
    const items = [item({ id: "a" }), item({ id: "b" })];
    const { next, affectedIds } = computeUnmarkCompleted(items);
    expect(affectedIds).toEqual([]);
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(items[0]);
  });

  it("preserves order of affectedIds", () => {
    const items = [
      item({ id: "x", completed: true }),
      item({ id: "y", completed: false }),
      item({ id: "z", completed: true }),
    ];
    expect(computeUnmarkCompleted(items).affectedIds).toEqual(["x", "z"]);
  });

  it("does not mutate the input array or its completed items", () => {
    const original = item({ id: "a", completed: true, completed_at: "2026-07-01T00:00:00Z" });
    const items = [original];
    computeUnmarkCompleted(items);
    expect(original.completed).toBe(true);
    expect(original.completed_at).toBe("2026-07-01T00:00:00Z");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/unit/unmark-completed.test.ts`
Expected: FAIL — cannot resolve `@/src/utils/unmark-completed`.

- [ ] **Step 3: Write the helper**

```ts
import type { ItemData } from "@/src/types";

/**
 * Optimistic computation for "unmark all done": flip every completed,
 * non-deleted item back to active. The predicate (`completed && !deleted_at`)
 * matches the unmark-completed endpoint's filter so client and server agree.
 * Returns a new array (unaffected items kept by reference) plus the affected
 * ids in encounter order, for the undo toast.
 */
export function computeUnmarkCompleted(
  items: ItemData[]
): { next: ItemData[]; affectedIds: string[] } {
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/unit/unmark-completed.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/unmark-completed.ts __tests__/unit/unmark-completed.test.ts
git commit -m "Add computeUnmarkCompleted helper + tests"
```

---

### Task 2: Endpoint `unmark-completed`

**Files:**
- Create: `app/api/lists/[id]/items/unmark-completed/route.ts`

**Interfaces:**
- Produces: `POST /api/lists/:id/items/unmark-completed` → `{ unmarked: number; unmarkedIds: string[] }`. Bulk-updates `completed:false, completed_at:null` for every `completed=true, deleted_at IS NULL` row in the list. No reminder cancellation.

- [ ] **Step 1: Write the route** (clone of `clear-completed/route.ts`, minus reminder cancellation, with `completed`/`completed_at` instead of `deleted_at`)

```ts
import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: listId } = await params;
  const auth = await verifyUserAuth(request, apiRateLimiter, "items-unmark-completed");
  if (!auth.success) return auth.response;

  const perm = await verifyListPermission(auth.userId, listId, "edit");
  if (!perm.allowed) {
    return NextResponse.json(
      { error: "You don't have permission to edit this list" },
      { status: 403 }
    );
  }

  const supabase = createServerClient();

  // Flip all completed items back to active (non-destructive; reminders survive)
  const { data: unmarked, error } = await supabase
    .from("items")
    .update({ completed: false, completed_at: null })
    .eq("list_id", listId)
    .eq("completed", true)
    .is("deleted_at", null)
    .select("id");

  if (error) {
    return NextResponse.json(
      { error: "Failed to unmark items" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    unmarked: (unmarked || []).length,
    unmarkedIds: (unmarked || []).map((i) => i.id),
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors from this file.

- [ ] **Step 3: Commit**

```bash
git add "app/api/lists/[id]/items/unmark-completed/route.ts"
git commit -m "Add unmark-completed bulk endpoint"
```

---

### Task 3: Hook handler `handleUnmarkAllDone`

**Files:**
- Modify: `src/hooks/useItemHandlers.ts` (add handler after `handleClearCompleted` ~line 601; add to the `return { ... }` at line 735; add the import)

**Interfaces:**
- Consumes: `computeUnmarkCompleted` (Task 1), the `unmark-completed` endpoint (Task 2).
- Produces: `handleUnmarkAllDone: () => Promise<void>` on the hook's return object.

- [ ] **Step 1: Add the import** at the top of `src/hooks/useItemHandlers.ts` (with the other `@/src/utils` imports)

```ts
import { computeUnmarkCompleted } from "@/src/utils/unmark-completed";
```

- [ ] **Step 2: Add the handler** immediately after `handleClearCompleted`'s `useCallback` closes (after line 601)

```ts
  const handleUnmarkAllDone = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;

    const { affectedIds } = computeUnmarkCompleted(items);
    if (affectedIds.length === 0) return;

    const tg = getTelegramWebApp();
    tg?.HapticFeedback?.impactOccurred("light");

    // Optimistic: flip completed -> active
    setItems((prev) => computeUnmarkCompleted(prev).next);

    const idSet = new Set(affectedIds);
    const timeout = setTimeout(() => setUndoAction(null), 4000);
    setUndoAction({
      message: t('items.unmarkedCount', { count: affectedIds.length }),
      undo: () => {
        clearTimeout(timeout);
        setUndoAction(null);
        // Re-check optimistically
        setItems((prev) =>
          prev.map((i) =>
            idSet.has(i.id)
              ? { ...i, completed: true, completed_at: new Date().toISOString() }
              : i
          )
        );
        // Restore on server
        const currentJwt = jwtRef.current;
        for (const id of affectedIds) {
          fetch(`/api/lists/${listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${currentJwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId: id, completed: true }),
          });
        }
      },
      timeout,
    });

    await fetch(`/api/lists/${listId}/items/unmark-completed`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
    });
  }, [jwtRef, listId, items, t, setItems, setUndoAction]);
```

- [ ] **Step 3: Export it** — add `handleUnmarkAllDone` to the return object (line 735)

Change:
```ts
  return { handleAddItem, handleToggle, handleDelete, handleEditItem, handleSkip, handleOrder, handleSetRecurring, handleRestoreRecurring, handleRemoveDuplicates, handleClearCompleted, handleRemind, handleReady, handleSetReminder, handleUpdateReminder, handleCancelReminder };
```
to (insert `handleUnmarkAllDone` right after `handleClearCompleted`):
```ts
  return { handleAddItem, handleToggle, handleDelete, handleEditItem, handleSkip, handleOrder, handleSetRecurring, handleRestoreRecurring, handleRemoveDuplicates, handleClearCompleted, handleUnmarkAllDone, handleRemind, handleReady, handleSetReminder, handleUpdateReminder, handleCancelReminder };
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useItemHandlers.ts
git commit -m "Add handleUnmarkAllDone handler (optimistic + undo)"
```

---

### Task 4: UI button + page wiring

**Files:**
- Modify: `components/list/CompletedItemsSection.tsx` (import `RotateCcw`; add optional prop; render button)
- Modify: `app/list/[id]/page.tsx` (destructure `handleUnmarkAllDone` at line 104; pass gated prop at the `CompletedItemsSection` at line 291-303)

**Interfaces:**
- Consumes: `handleUnmarkAllDone` (Task 3), `items.unmarkAllDone` i18n key (Task 5).
- Produces: renders an "Unmark all" button when `onUnmarkAllDone` is provided.

- [ ] **Step 1: `CompletedItemsSection.tsx` — extend the lucide import** (line 3)

Change:
```ts
import { CheckCircle2, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
```
to:
```ts
import { CheckCircle2, ChevronDown, ChevronRight, RotateCcw, Trash2 } from "lucide-react";
```

- [ ] **Step 2: Add the optional prop** to the interface (after `onClearCompleted` at line 20) and to the destructure (after `onClearCompleted` at line 34)

Interface — change:
```ts
  onClearCompleted: () => void;
}
```
to:
```ts
  onClearCompleted: () => void;
  onUnmarkAllDone?: () => void;
}
```

Destructure — change:
```ts
  onClearCompleted,
}: CompletedItemsSectionProps) {
```
to:
```ts
  onClearCompleted,
  onUnmarkAllDone,
}: CompletedItemsSectionProps) {
```

- [ ] **Step 3: Render the button** — replace the single "Clear completed" button (lines 59-68) with a right-aligned group that renders "Unmark all" first (only when the callback is provided), then "Clear completed"

Change:
```tsx
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClearCompleted();
          }}
          className="ms-auto text-tg-destructive/80 text-[12px] font-medium tracking-wide flex items-center gap-1"
        >
          <Trash2 className="w-3 h-3" />
          {t('items.clearCompleted')}
        </button>
```
to:
```tsx
        <span className="ms-auto flex items-center gap-3">
          {onUnmarkAllDone && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onUnmarkAllDone();
              }}
              className="text-tg-hint text-[12px] font-medium tracking-wide flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" />
              {t('items.unmarkAllDone')}
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClearCompleted();
            }}
            className="text-tg-destructive/80 text-[12px] font-medium tracking-wide flex items-center gap-1"
          >
            <Trash2 className="w-3 h-3" />
            {t('items.clearCompleted')}
          </button>
        </span>
```

- [ ] **Step 4: `page.tsx` — destructure the handler** (line 104)

Add `handleUnmarkAllDone` to the destructure right after `handleClearCompleted`:
```ts
  const { handleAddItem, handleToggle, handleDelete, handleEditItem, handleSkip, handleOrder, handleSetRecurring, handleRestoreRecurring, handleRemoveDuplicates, handleClearCompleted, handleUnmarkAllDone, handleRemind, handleReady, handleSetReminder, handleUpdateReminder, handleCancelReminder } =
    useItemHandlers({
```

- [ ] **Step 5: `page.tsx` — pass the gated prop** to the `CompletedItemsSection` at line 291-303 (add after `onClearCompleted={handleClearCompleted}` at line 302)

```tsx
              onClearCompleted={handleClearCompleted}
              onUnmarkAllDone={listType === "regular" ? handleUnmarkAllDone : undefined}
            />
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add components/list/CompletedItemsSection.tsx "app/list/[id]/page.tsx"
git commit -m "Wire Unmark all button into regular-list completed section"
```

---

### Task 5: i18n keys

**Files:**
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json` (add `items.unmarkAllDone` and `items.unmarkedCount` beside the existing `items.clearCompleted` / `items.clearedCount`)

**Interfaces:**
- Produces: `items.unmarkAllDone` (button label) and `items.unmarkedCount` (undo toast, ICU `{count}`) in all three locales.

- [ ] **Step 1: `messages/en.json`** — add after the `clearCompleted` / `clearedCount` keys inside `items`

```json
    "unmarkAllDone": "Unmark all",
    "unmarkedCount": "Unmarked {count} items",
```

- [ ] **Step 2: `messages/he.json`** — add the same keys with Hebrew copy (match existing tone: `clearCompleted` = "נקה שהושלמו", `clearedCount` = "{count} פריטים נוקו")

```json
    "unmarkAllDone": "בטל סימון הכל",
    "unmarkedCount": "בוטל הסימון של {count} פריטים",
```

- [ ] **Step 3: `messages/ru.json`** — add the same keys with Russian copy (match existing tone: `clearCompleted` = "Очистить выполненные", `clearedCount` = "Очищено {count}")

```json
    "unmarkAllDone": "Снять отметки",
    "unmarkedCount": "Снято отметок: {count}",
```

> Before editing each file, `grep -n "clearCompleted\|clearedCount" messages/<file>` to find the exact anchor line and verify the surrounding comma/formatting so the JSON stays valid. Confirm the real Hebrew/Russian values of the sibling keys and match their tone rather than trusting the samples above verbatim.

- [ ] **Step 4: Validate JSON**

Run: `node -e "['en','he','ru'].forEach(l=>{const m=require('./messages/'+l+'.json');if(!m.items.unmarkAllDone||!m.items.unmarkedCount)throw new Error('missing key in '+l);});console.log('ok')"`
Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add messages/en.json messages/he.json messages/ru.json
git commit -m "Add unmark-all-done i18n keys (en/he/ru)"
```

---

### Task 6: Full verification

- [ ] **Step 1: Unit tests**

Run: `npx vitest run`
Expected: all pass (including the new `unmark-completed.test.ts` and the existing suite).

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: typecheck clean; build succeeds (the pre-existing `ENVIRONMENT_FALLBACK` static-gen warning is benign and unrelated).

- [ ] **Step 3: Manual smoke reasoning** (no device): confirm the button appears only in a regular list's Completed section, tapping flips all done items to active + shows the undo toast, and Undo re-checks them. Grocery/reminders lists show no such button.

---

## Self-Review

- **Spec coverage:** endpoint (Task 2 ✓), pure helper + test (Task 1 ✓), hook handler with optimistic + undo + direct fetch (Task 3 ✓), UI button gated to regular via optional prop (Task 4 ✓), i18n en/he/ru (Task 5 ✓), verification incl. build (Task 6 ✓). "Not doing" items (no migration, no queue, no reminder cancel, no confirm) are respected across tasks.
- **Placeholder scan:** none — all code blocks are complete; the only deferred detail is the exact he/ru sibling copy, which Task 5 instructs the implementer to verify against the actual files.
- **Type consistency:** `computeUnmarkCompleted(items): { next; affectedIds }` is defined in Task 1 and consumed identically in Tasks 1/3; endpoint returns `{ unmarked, unmarkedIds }` (Task 2), not consumed by the client (optimistic path ignores the body, like clear-completed); `onUnmarkAllDone?: () => void` matches between component prop (Task 4) and the `handleUnmarkAllDone: () => Promise<void>` passed in (Tasks 3/4 — a `Promise<void>` is assignable to `() => void`).
