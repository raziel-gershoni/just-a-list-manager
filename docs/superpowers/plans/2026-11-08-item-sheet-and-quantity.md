# Item Sheet and Quantity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grocery rows lose their trailing icon buttons in favour of a per-item sheet. Grocery items get an optional free-text quantity, which voice fills.

**Architecture:**
- **Data:** a nullable `items.quantity` column, with its own PATCH field and a new sync mutation
  type `set-quantity`.
- **Row:** `ItemRow` gains a "sheet mode", switched on by the page passing `onOpenDetails`. In that
  mode it shows the name, status marks and quantity, and tapping the name column opens a new
  `ItemSheet`.
- **Sheet:** it calls the existing item handlers, so skip, order, recurring, pause and delete keep
  one code path each.
- **Voice:** the Gemini schema gains `quantity`. The handler writes it on grocery lists and folds it
  back into the name on regular lists.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind 4, Supabase (Postgres, Realtime),
next-intl, vitest, lucide-react, @google/genai.

**Spec:** `docs/superpowers/specs/2026-11-08-item-sheet-and-quantity-design.md`

## Global Constraints

**Commands and safety:**
- Never run `npm run build`, because it migrates prod. The gate is
  `npx eslint . && npx vitest run && npx next typegen && npx tsc --noEmit`.
- Never read or print `.env*`.
- No network and no database.
- Run only `git add` and `git commit`. Never push, branch or rewrite history.
- End every commit message with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y`.

**Code rules:**
- Use TDD.
- Every new guard must be seen failing with its fix removed. Restore with your editor, never
  `git checkout`.
- Log every caught error (no empty catch). Never log item text, list names or tokens; ids are fine.
- No inline user-facing strings: use `messages/{en,he,ru}.json`, all three in the same commit.

**Quantity:**
- `null` means none, never `''`.
- At most **30** characters, counted in code points (`[...s].length`), to match Postgres
  `char_length`.
- Normalized with `normalizeForStorage` (`src/utils/text-normalize.ts`).

**Product rules:**
- Grocery lists only in the UI. Regular lists' rows stay exactly as today.
- The voice model stays `gemini-3.8-flash`. Change only the prompt, the schema and parsing.

**Styling:**
- No new palette. On-states: On the way is `text-amber-500` + `strokeWidth={3}`; Recurring is
  `text-tg-active` + `strokeWidth={3}`; off-state is `text-tg-hint` + `strokeWidth={2}`.
- Use logical CSS only (`start`/`end`/`ms`/`me`/`ps`/`pe`/`text-start`/`text-end`), never
  `left`/`right`/`ml`/`mr`/`text-left`/`text-right`, because Hebrew is RTL.
- Inputs use `text-base` (16px) or larger, so iOS doesn't zoom.
- The row's tappable name column is a `div role="button"`, never a `<button>`. dnd-kit refuses to
  start a drag under an interactive ancestor (`button`, `a[href]`, `input`).

## Review Focus

1. **The keyboard opens in the sheet** (iOS, Telegram) and covers Done. The sheet must scroll:
   `max-h-[90dvh] overflow-y-auto`. Pinned by a class assertion in Task 4.
2. **A backdrop tap after emptying the name** must keep the old name, not save "" and not throw.
   Pinned in Task 4.
3. **Another device completes the item while the sheet is open** with a typed quantity. The
   quantity must still be saved, and the sheet must close. Pinned in Task 4.
4. **A pending item's id changes from `temp-…` to the real uuid while its sheet is open.** The
   sheet must stay open on the same item. The page looks it up by `id` or `_tempId`. Pinned in
   Task 5.
5. **RTL:** the quantity sits at the row's end on both sides, with no physical left/right classes in
   the new or changed components. Pinned by a source check in Task 5.

---

### Task 1: Database column and items route

**Files:**
- Create: `supabase/migrations/033_item_quantity.sql`
- Modify: `app/api/lists/[id]/items/route.ts` (GET select string at ~line 81; PATCH builder after
  the `text` branch at ~line 445)
- Modify: `src/schemas/items.ts` (`updateItemSchema`)
- Modify: `__tests__/helpers/fake-items-table.ts` (add `quantity: string | null` to `ItemRow`,
  default `null` in `itemRow()`)
- Test: `__tests__/unit/items-get-columns.test.ts` (add a case)
- Test: create `__tests__/unit/items-patch-quantity.test.ts`

**Interfaces:**
- Produces: the PATCH body accepts `quantity: string | null`. The GET row carries `quantity`.

- [ ] **Step 1: Write the failing tests**

Add to `items-get-columns.test.ts`, inside the `describe`:

```ts
  it("returns each item's quantity, so a grocery row can show it", async () => {
    h.fake = fakeSupabase(() => ({ data: [], error: null }));
    await GET(new NextRequest("https://app.test/api/lists/l1/items?limit=500"), { params: Promise.resolve({ id: "l1" }) });

    const select = h.fake.calls.find((c) => c.table === "items" && c.op === "select")!;
    expect(select.cols).toMatch(/\bquantity\b/);
  });
```

Create `items-patch-quantity.test.ts`. Copy the header of `items-patch-pause.test.ts` verbatim:
the `vi.hoisted` block, the four `vi.mock`s, the `PATCH` import, `ITEM`, `params`, `patch`, and
`row()`. Use this `beforeEach`:

```ts
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  h.db = fakeItemsTable([itemRow({ id: ITEM, text: "milk", created_by: "u0" })]);
});
afterEach(() => vi.restoreAllMocks());

describe("PATCH quantity", () => {
  it("stores the normalized quantity and records who changed it", async () => {
    const res = await patch({ quantity: "  2   litres " });
    expect(res.status).toBe(200);
    expect(row()).toMatchObject({ quantity: "2 litres", edited_by: "u1", text: "milk" });
  });

  it("clears it with null", async () => {
    h.db.rows[0].quantity = "3";
    await patch({ quantity: null });
    expect(row().quantity).toBe(null);
  });

  it("stores an empty or blank quantity as null, never ''", async () => {
    h.db.rows[0].quantity = "3";
    await patch({ quantity: "   " });
    expect(row().quantity).toBe(null);
  });

  it("counts characters like Postgres: 30 code points pass, 31 answer 400 and write nothing", async () => {
    const thirty = "🥛".repeat(30); // 60 UTF-16 units, 30 code points
    expect((await patch({ quantity: thirty })).status).toBe(200);
    expect(row().quantity).toBe(thirty);
    const res = await patch({ quantity: "x".repeat(31) });
    expect(res.status).toBe(400);
    expect(row().quantity).toBe(thirty);
  });

  it("a quantity-only change is a valid update", async () => {
    const res = await patch({ quantity: "1 kg" });
    expect(res.status).not.toBe(400);
  });

  it("does not re-sort the item (only a name change resets the category)", async () => {
    const before = h.db.calls.length;
    await patch({ quantity: "2" });
    const updates = h.db.calls.slice(before).filter((c) => c.op === "update");
    expect(updates).toHaveLength(1);
  });
});
```

If `fake-items-table.ts` records calls under different field names, adapt the last test to its
API. It must still assert exactly one `update` call (no category reset).

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run __tests__/unit/items-get-columns.test.ts __tests__/unit/items-patch-quantity.test.ts`
Expected: FAIL. `quantity` isn't in the select, and the PATCH answers 400 "No valid fields to update".

- [ ] **Step 3: Implement**

`supabase/migrations/033_item_quantity.sql`:

```sql
-- Item sheet and quantity (docs/superpowers/specs/2026-11-08-item-sheet-and-quantity-design.md):
-- an optional free-text amount on a grocery item ("2", "1.5 kg", "3 packs"). Null when there is
-- none, never ''. The name (text) stays the item's identity; nothing compares quantities.
ALTER TABLE items ADD COLUMN IF NOT EXISTS quantity TEXT
  CHECK (quantity IS NULL OR char_length(quantity) BETWEEN 1 AND 30);
```

In `src/schemas/items.ts`, `updateItemSchema`, add after `text`:

```ts
  // Free text ("2", "1 kg"); null or blank clears it. The route normalizes it and refuses more
  // than 30 characters; 60 here only bounds the raw body before normalizing.
  quantity: z.string().max(60).nullable().optional(),
```

In the route's GET select string, insert `quantity, ` after `text, `.

In PATCH, right after the `if (typeof updates.text === "string") { … }` block:

```ts
  if (updates.quantity !== undefined) {
    const canonical = updates.quantity === null ? "" : normalizeForStorage(updates.quantity);
    // Code points, like Postgres char_length: an emoji counts once.
    if ([...canonical].length > 30) {
      console.warn("[items/PATCH] Quantity too long:", { listId, itemId });
      return NextResponse.json({ error: "Quantity is too long" }, { status: 400 });
    }
    patchData.quantity = canonical.length > 0 ? canonical : null;
    patchData.edited_by = auth.userId;
  }
```

- [ ] **Step 4: Run and see them pass**

Run: `npx vitest run __tests__/unit/items-get-columns.test.ts __tests__/unit/items-patch-quantity.test.ts __tests__/unit/items-patch-pause.test.ts`
Expected: PASS.

- [ ] **Step 5: Bite checks**

One at a time, restoring each after its run:
- Remove `quantity, ` from the select. The GET test must fail.
- Replace `[...canonical].length` with `canonical.length`. The 30-emoji test must fail.
- Remove `canonical.length > 0 ? canonical : null` in favour of `canonical`. The blank test must
  fail.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/033_item_quantity.sql src/schemas/items.ts "app/api/lists/[id]/items/route.ts" __tests__/helpers/fake-items-table.ts __tests__/unit/items-get-columns.test.ts __tests__/unit/items-patch-quantity.test.ts
git commit -m "feat(items): optional quantity column, returned by GET and set by PATCH"
```

---

### Task 2: Recycler and voice carry the quantity

**Files:**
- Modify: `src/services/item-recycler.ts` (`recycleItem`, ~line 68)
- Modify: `src/services/voice-processor.ts` (schema ~30-47, `VoiceItem`, `parseVoiceResult`, prompt
  ~107-112)
- Modify: `src/services/voice-handler.ts` (the two `lists` selects `"id, name"` at ~127 and ~147,
  `processAddItem` ~424-489, `recycleOrThrow` ~603)
- Test: `__tests__/unit/item-recycler.test.ts`, `__tests__/unit/voice-processor.test.ts`,
  `__tests__/unit/voice-handler-failures.test.ts` (or a new `voice-handler-quantity.test.ts` that
  copies its harness)

**Interfaces:**
- Consumes: the `items.quantity` column (Task 1).
- Produces:
  - `recycleItem(itemId, userId, listId, text, opts?: { quantity?: string })`. The new argument is
    optional; when `opts.quantity` is a string, the same update sets it.
  - `VoiceItem` gains `quantity: string | null`.

- [ ] **Step 1: Write the failing tests**

**Recycler** (`item-recycler.test.ts`, using its existing fake): a completed item recycled with
`{ quantity: "2 L" }` gets `quantity: "2 L"` in the update payload. Recycled with no `opts`, the
update payload has no `quantity` key (`expect("quantity" in payload).toBe(false)`).

**Voice processor** (`voice-processor.test.ts`, which already feeds JSON text to the parser through
its harness):
- `{"items":[{"text":"milk","action":"add","targetList":null,"quantity":"  2  litres "}]}` parses
  to `quantity: "2 litres"`.
- `"quantity":"   "` parses to `quantity: null`.
- A missing quantity parses to `quantity: null`.
- A 31-code-point quantity `"q".repeat(31)` parses to `text: "milk " + "q".repeat(31)` and
  `quantity: null`.
- `"quantity":"2"` on a `remove` item parses to `quantity: null`.
- The schema sent to Gemini has `items.items.properties.quantity` deep-equal to
  `{ type: ["string", "null"] }`. Assert it through the captured `generateContent` config, as the
  file's existing schema test does.
- The prompt contains `quantity` (a substring assertion on the captured prompt text).

**Voice handler** (copy the `voice-handler-failures.test.ts` harness; the fake db answers the
`lists` select with rows that now include `type`):
- A grocery list, add `{text:"milk", quantity:"2 L"}`, no fuzzy match. The `items` insert payload
  has `text: "milk", quantity: "2 L"`. The receipt contains `- milk, 2 L`.
- A grocery list, a fuzzy match above 0.6. `recycleItem` is called with a fifth argument
  `{ quantity: "2 L" }`, and the receipt contains `2 L`.
- A grocery list, a fuzzy match, no quantity. `recycleItem` is called with no fifth argument, or
  `undefined`.
- A regular list, add `{text:"milk", quantity:"2 L"}`. The insert payload has `text: "milk 2 L"`
  and no `quantity` key. The receipt line is `- milk 2 L`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run __tests__/unit/item-recycler.test.ts __tests__/unit/voice-processor.test.ts __tests__/unit/voice-handler-quantity.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

**`item-recycler.ts`:**

```ts
export async function recycleItem(
  itemId: string,
  userId: string,
  listId: string,
  text: string,
  // A quantity said by voice replaces the old one; the app's recycle passes none and keeps it.
  opts?: { quantity?: string }
): Promise<RecyclableItem | null> {
```

In the update object, add `...(typeof opts?.quantity === "string" ? { quantity: opts.quantity } : {}),`.

**`voice-processor.ts`:**
- Schema item properties: add `quantity: { type: ["string", "null"] },`, and leave `required`
  unchanged.
- `VoiceItem`: add `quantity: string | null;`.
- `parseVoiceResult`, inside the loop. Import `normalizeForStorage` from `@/src/utils/text-normalize`.

```ts
    const text = r.text.trim();
    const said = r.action === "add" && typeof r.quantity === "string" ? normalizeForStorage(r.quantity) : "";
    // Too long for the quantity field: keep it in the name rather than lose it.
    const tooLong = [...said].length > 30;
    items.push({
      text: tooLong ? `${text} ${said}` : text,
      action: r.action,
      targetList: typeof r.targetList === "string" && r.targetList.trim() ? r.targetList : null,
      quantity: said && !tooLong ? said : null,
    });
```

Update the doc comment above `parseVoiceResult` so it names text, action, targetList and quantity.

- Prompt: append one rule line after the existing last rule:

```
- If an item to add has an amount (a count, weight, volume or packs), put the amount in quantity exactly as said, in the speaker's language ("2", "1.5 kg", "2 ליטר", "3 пачки"), and leave it out of text. Otherwise quantity is null. Items to remove have no quantity.
```

**`voice-handler.ts`:**
- Both `lists` selects become `"id, name, type"`. Thread `type` through to `targetList`.
- `processAddItem` gains a `listType: string` parameter, passed `targetList.type` at the call site.
  At its top:

```ts
  // Quantities live on grocery items only; elsewhere the amount stays in the name, as before.
  const grocery = listType === "grocery";
  const name = !grocery && voiceItem.quantity ? `${voiceItem.text} ${voiceItem.quantity}` : voiceItem.text;
  const quantity = grocery ? voiceItem.quantity : null;
  const shown = (t: string) => (quantity ? `${t}, ${quantity}` : t);
```

- Use `name` everywhere `voiceItem.text` was used inside `processAddItem`: the fuzzy lookup, both
  similarity calls, the insert `text`, and the receipt.
- The insert adds `...(quantity ? { quantity } : {})`.
- The receipt for a new item becomes `shown(name)`. For a recycle it becomes
  `` `${shown(match.text)} ${getMsg(lang, "voice.recycledLabel")}` `` (and the same with
  `bestMatch`).
- `recycleOrThrow(itemId, text, userId, listId, quantity?: string | null)` calls
  `recycleItem(itemId, userId, listId, text, quantity ? { quantity } : undefined)`. Pass
  `quantity` from both recycle sites.

- [ ] **Step 4: Run and see them pass**

Run: `npx vitest run __tests__/unit/item-recycler.test.ts __tests__/unit/voice-processor.test.ts __tests__/unit/voice-handler-quantity.test.ts __tests__/unit/voice-handler-failures.test.ts __tests__/unit/voice-categorize-wiring.test.ts __tests__/unit/voice-processor-sdk.test.ts`
Expected: PASS. The existing voice tests may need `type` added to their fake list rows, and
`quantity: null` to their expected `VoiceItem`s. Make those edits only.

- [ ] **Step 5: Bite checks**

One at a time, restoring each after its run:
- Drop the recycler spread. The recycle test must fail.
- Drop the `tooLong` fold. The 31-character test must fail.
- Make `grocery` always true. The regular-list fold test must fail.
- Drop `quantity` from the schema. The schema test must fail.

- [ ] **Step 6: Commit**

```bash
git add src/services/item-recycler.ts src/services/voice-processor.ts src/services/voice-handler.ts __tests__/unit/item-recycler.test.ts __tests__/unit/voice-processor.test.ts __tests__/unit/voice-handler-quantity.test.ts __tests__/unit/voice-handler-failures.test.ts __tests__/unit/voice-categorize-wiring.test.ts __tests__/unit/voice-processor-sdk.test.ts
git commit -m "feat(voice): an amount said for a grocery item goes in its quantity"
```

Add to the commit only the files that actually changed.

---

### Task 3: `set-quantity` through the sync engine

**Files:**
- Modify: `src/types/items.ts` (add `quantity?: string | null;` after `text`, with a comment like
  the other optional fields)
- Modify: `src/hooks/useItemHandlers.ts`:
  - `addSingleItem`'s `newItem`: add `quantity: null`.
  - Add `handleSetQuantity`.
  - Export it from the return object.
- Modify: `src/sync/engine.ts` (`FIELDS`)
- Modify: `src/utils/executor-factory.ts` (new `case "set-quantity"`)
- Test: `__tests__/unit/executor-factory.test.ts` (`REPLAYABLE_TYPES` and a request-shape test)
- Test: `__tests__/unit/mutation-request-parity.test.ts` (`SAMPLES`)
- Test: `__tests__/unit/sync-engine.test.ts` (the `pendingFields` describe)
- Test: create `__tests__/unit/set-quantity-handler.test.ts`, or extend the existing handler test
  that exercises `handleEditItem`. Find it with `grep -l handleEditItem __tests__/unit`.

**Interfaces:**
- Consumes: PATCH `{ itemId, quantity }` (Task 1).
- Produces: `handleSetQuantity(itemId: string, quantity: string | null): void` on the
  `useItemHandlers` return. It is given the user's raw input and normalizes it itself.

- [ ] **Step 1: Write the failing tests**

- **`executor-factory.test.ts`:**
  - Add `"set-quantity"` to `REPLAYABLE_TYPES`.
  - Add a test that the executor for
    `{type:"set-quantity", payload:{listId:"l1", itemId:"i1", quantity:"2"}}` sends
    `PATCH /api/lists/l1/items` with the JSON body `{"itemId":"i1","quantity":"2"}`.
  - Add the same test with `quantity: null`, which sends `"quantity":null`.
- **`mutation-request-parity.test.ts`:** add `"set-quantity": { itemId: A, quantity: "2" },` to
  `SAMPLES`.
- **`sync-engine.test.ts`**, in `describe("pendingFields")`: after
  `w.add("set-quantity", { itemId: "q1", quantity: "2" })`,
  `expect(w.engine().pendingFields("q1")).toEqual(new Set(["quantity"]))`.
- **Handler test:**
  - `handleSetQuantity("i1", "  2   kg ")` sets the item's `quantity` to `"2 kg"` and
    `edited_by` to the user.
  - It queues one mutation `{ type: "set-quantity", payload: { listId, itemId: "i1", quantity: "2 kg" } }`.
  - `handleSetQuantity("i1", "  ")` sets `quantity: null` and queues `quantity: null`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run __tests__/unit/executor-factory.test.ts __tests__/unit/mutation-request-parity.test.ts __tests__/unit/sync-engine.test.ts __tests__/unit/single-executor.test.ts __tests__/unit/set-quantity-handler.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

**`engine.ts` `FIELDS`:** add `"set-quantity": ["quantity"],`.

**`executor-factory.ts`:** add a case after `edit`:

```ts
      case "set-quantity":
        return async () => {
          const jwt = getJwt();
          const res = await fetch(`/api/lists/${payload.listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId: payload.itemId, quantity: payload.quantity ?? null }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Quantity failed: ${res.status}`);
        };
```

**`useItemHandlers.ts`:**

```ts
  // The quantity a grocery item's sheet saves: normalized like the server stores it, so the
  // realtime echo matches what the screen shows. Blank clears it (null, never '').
  const handleSetQuantity = useCallback(
    (itemId: string, typed: string | null) => {
      const canonical = typed === null ? "" : normalizeForStorage(typed);
      const quantity = canonical.length > 0 ? canonical : null;
      setItems((prev) =>
        prev.map((i) => (i.id === itemId ? { ...i, quantity, edited_by: userId, editor_name: null } : i))
      );
      addMutation({
        id: genMutId(),
        type: "set-quantity",
        payload: { listId, itemId, quantity },
      });
    },
    [listId, addMutation, userId, setItems]
  );
```

Add `handleSetQuantity` to the return object.

- [ ] **Step 4: Run and see them pass**

Run the Step 2 command again. Expected: PASS. `single-executor.test.ts` passes because the case exists.

- [ ] **Step 5: Bite checks**

One at a time, restoring each after its run:
- Remove the `FIELDS` entry. The pendingFields test must fail.
- Remove the `case`. `single-executor`, `executor-factory` and the parity test must fail.

- [ ] **Step 6: Commit**

```bash
git add src/types/items.ts src/hooks/useItemHandlers.ts src/sync/engine.ts src/utils/executor-factory.ts __tests__/unit/executor-factory.test.ts __tests__/unit/mutation-request-parity.test.ts __tests__/unit/sync-engine.test.ts __tests__/unit/set-quantity-handler.test.ts
git commit -m "feat(sync): set-quantity change type, optimistic and replayable"
```

---

### Task 4: `SwitchRow` and the item sheet

**Files:**
- Create: `components/ui/SwitchRow.tsx`
- Modify: `app/(app)/list/[id]/page.tsx` (the categories switch at ~553-568 uses `SwitchRow`)
- Create: `components/list/ItemSheet.tsx`
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json` (new keys)
- Test: create `__tests__/unit/item-sheet.test.ts`
- Test: `__tests__/unit/categories-switch-page.test.ts` must still pass unchanged. If it asserts
  exact markup, adapt it only as far as the move requires, keeping each assertion's intent.

**Interfaces:**
- Consumes: `handleSetQuantity` (Task 3); `ItemData.quantity` (Task 3).
- Produces:
  - `SwitchRow` props: `{ label: string; checked: boolean; onChange: () => void; icon?: React.ReactNode }`.
  - `ItemSheet` default export, with these props:

```ts
export interface ItemSheetProps {
  item: ItemData | undefined;   // the live item; undefined when it is gone
  openedSkipped: boolean;       // was it a Not available item when the sheet opened
  onClose: () => void;
  onEdit: (id: string, text: string) => void;
  onSetQuantity: (id: string, quantity: string | null) => void;
  onSkip: (id: string, skipped: boolean) => void;
  onOrder: (id: string, ordered: boolean) => void;
  onSetRecurring: (id: string, recurring: boolean) => void;
  onPause: (id: string) => void;
  onDelete: (id: string) => void;
}
```

- [ ] **Step 1: Add the copy**

In each `messages/*.json`, under `items`:
- Add `"sheet": { "name": … }` and `"quantity": { "label": …, "placeholder": … }`.
- Add `"skip": …` and `"unskip": …` at the `items` level.
- Add `"title"` inside the existing `items.ordered` and `items.recurring` objects.

| Key | en | he | ru |
|---|---|---|---|
| `items.sheet.name` | Item name | שם הפריט | Название |
| `items.quantity.label` | Quantity | כמות | Количество |
| `items.quantity.placeholder` | e.g. 2, 1 kg, 3 packs | למשל 2, 1 ק״ג, 3 חבילות | Например: 2, 1 кг, 3 пачки |
| `items.skip` | Not available | לא זמין | Нет в наличии |
| `items.unskip` | Back to the list | החזר לרשימה | Вернуть в список |
| `items.ordered.title` | On the way | בדרך | В пути |
| `items.recurring.title` | Recurring | חוזר | Повторяющийся |

- [ ] **Step 2: Write the failing tests** (`__tests__/unit/item-sheet.test.ts`)

**Harness:** the same technique as `__tests__/unit/item-row-long-text.test.ts`.
- Call the component as a function with React hooks stubbed:
  - `vi.mock("react", …)` with a state store that persists across calls, so re-rendering reads
    the typed draft back;
  - a `useEffect` that runs synchronously;
  - `next-intl`'s `useTranslations` returning the key.
- Find elements by props in the returned tree: `aria-label`, `role`, `onChange`.

Write a small `render(props)` helper that returns the tree and a `find(pred)` walker. With
`item = { id:"i1", text:"milk", quantity:null, ordered_at:null, recurring:false, skipped_at:null, completed:false, deleted_at:null, … }`:

**Which controls show:**
- **Active item:** the tree contains a `role="switch"` with `aria-checked=false` labelled
  `items.ordered.title`, another labelled `items.recurring.title`, and buttons labelled
  `items.skip` and `common.delete`.
  - It has no `items.recurring.notThisWeek` button while `recurring: false`, and has one when
    `recurring: true`.
- **`openedSkipped: true`** with `skipped_at` set: there are buttons `items.unskip` and
  `common.delete`, and no switches and no `items.skip`.

**Actions:**
- `items.skip` calls `onSkip("i1", true)` then `onClose()`.
- `items.unskip` calls `onSkip("i1", false)` then `onClose()`.
- `items.recurring.notThisWeek` calls `onPause("i1")` then `onClose()`.
- `common.delete` calls `onDelete("i1")` then `onClose()`.

**Switches:** the On the way switch calls `onOrder("i1", true)` and not `onClose`. With
`ordered_at` set, it calls `onOrder("i1", false)`. The Recurring switch calls
`onSetRecurring("i1", !recurring)` and not `onClose`.

**Saving the quantity:**
- Type `"2 kg"` into the quantity input (call its `onChange`), then press Done (`common.done`).
  It calls `onSetQuantity("i1", "2 kg")` once, then `onClose()`.
- Done with an unchanged quantity calls no `onSetQuantity`.
- Clearing a set quantity (`"3"` → `""`) and pressing Done calls `onSetQuantity("i1", null)`.

**Saving the name:**
- Type `"oat milk"` into the name box, then tap the backdrop (call the outer element's
  `onClick`). It calls `onEdit("i1", "oat milk")`.
- Type `"   "` into the name box and tap the backdrop. It calls no `onEdit` (Review Focus 2).
- A pasted line break in the name becomes a space (`"oat\nmilk"` is saved as `"oat milk"`).
- Type a quantity, then tap `items.skip`. `onSetQuantity` is called before `onSkip` (record the
  call order).

**Live value and closing:**
- **Live value until typed:**
  - Render with `text: "milk"`, re-render with `text: "milk 3%"`, and the name box's `value` is
    `"milk 3%"`.
  - Then type `"x"` and re-render with `text: "y"`. The `value` stays `"x"`.
- **Closes by itself** (Review Focus 3):
  - Re-render with `item: undefined`. `onClose` is called and nothing is saved.
  - Re-render with `completed: true` after typing a quantity. `onSetQuantity` is called, then
    `onClose`.
  - Re-render with `skipped_at` set while `openedSkipped: false`. `onClose` is called.
- **Scrolls** (Review Focus 1): the sheet panel's `className` contains `max-h-[90dvh]` and
  `overflow-y-auto`.
- **Inputs don't zoom:** both inputs' `className` contains `text-base` or `text-[17px]`, so not
  under 16px.

- [ ] **Step 3: Run and see them fail**

Run: `npx vitest run __tests__/unit/item-sheet.test.ts`
Expected: FAIL (the module isn't found).

- [ ] **Step 4: Implement `SwitchRow`**

`components/ui/SwitchRow.tsx`. This is the categories switch markup, moved, plus an optional
leading icon:

```tsx
"use client";

import type { ReactNode } from "react";

// An on/off row: the whole row is the switch (44px+ target), the knob moves the right way in RTL.
// Used by list settings (Sort into categories) and the item sheet (On the way, Recurring).
export default function SwitchRow({ label, checked, onChange, icon }: {
  label: string;
  checked: boolean;
  onChange: () => void;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className="w-full min-h-11 flex items-center justify-between gap-3 py-3 px-4 rounded-2xl bg-tg-secondary-bg text-tg-text font-medium text-start active:scale-[0.98]"
    >
      <span className="flex items-center gap-3 min-w-0">
        {icon}
        <span className="min-w-0">{label}</span>
      </span>
      <span
        aria-hidden="true"
        className={`relative inline-flex h-7 w-12 shrink-0 rounded-full motion-safe:transition-colors ${checked ? "bg-tg-button" : "bg-tg-hint/50"}`}
      >
        <span
          className={`absolute top-0.5 start-0.5 h-6 w-6 rounded-full bg-white shadow-sm motion-safe:transition-transform ${checked ? "translate-x-5 rtl:-translate-x-5" : ""}`}
        />
      </span>
    </button>
  );
}
```

In `page.tsx`, replace the categories switch `<button role="switch">…</button>` with
`<SwitchRow label={t('categories.enabled')} checked={categoriesEnabled} onChange={toggleCategories} />`,
keeping its `{listType === "grocery" && (…)}` gate.

- [ ] **Step 5: Implement `ItemSheet`**

`components/list/ItemSheet.tsx`. Layout, top to bottom, inside the app's sheet shell. Copy the
shell from `components/list/SignalSheet.tsx`:
- **Backdrop:** `fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm backdrop-enter`,
  `onClick={finish}`.
- **Panel:** `role="dialog" aria-modal="true" aria-label={item.text}`,
  `bg-tg-bg w-full max-w-lg rounded-t-3xl px-4 pt-3 pb-6 sheet-enter max-h-[90dvh] overflow-y-auto`,
  `onClick={(e) => e.stopPropagation()}`. Then the grabber `w-10 h-1 rounded-full bg-tg-hint/30 mx-auto mb-4`.
- **Name:** a growing `textarea rows={1}`, `aria-label={t("items.sheet.name")}`, `maxLength={500}`,
  class `block w-full resize-none overflow-hidden wrap-anywhere bg-transparent text-[17px] leading-6 font-semibold text-tg-text outline-none border-b-2 border-tg-hint/20 focus:border-tg-button/60 pb-2 mb-3`.
  - It auto-grows like `ItemRow`'s edit box (`height = auto; height = scrollHeight` in an effect
    on the shown value).
  - `onChange` replaces line breaks with a space, using the same regex as `ItemRow`:
    `/[^\S\r\n]*[\r\n]+[^\S\r\n]*/g`.
  - Enter saves the name and blurs (`preventDefault`). There is no autofocus.
- **Quantity row:** a `label` styled like a switch row:
  `flex items-center gap-3 min-h-11 px-4 py-2 rounded-2xl bg-tg-secondary-bg mb-4`.
  - Its text `t("items.quantity.label")` is `text-tg-text font-medium shrink-0`.
  - It holds an `input type="text" inputMode="text" enterKeyHint="done" maxLength={30}`, with
    `placeholder={t("items.quantity.placeholder")}` and class
    `flex-1 min-w-0 bg-transparent text-base text-end text-tg-text placeholder:text-tg-hint outline-none tabular-nums`.
    The end-aligned value echoes the quantity's place on the row.
  - Enter saves the quantity and blurs.
- **Controls:** `flex flex-col gap-2`.
  - **Active item:**
    1. An action button **Not available**: `CircleOff`, label `t("items.skip")`.
    2. A `SwitchRow` **On the way**, with the icon
       `<Truck className={`w-5 h-5 shrink-0 ${ordered ? "text-amber-500" : "text-tg-hint"}`} strokeWidth={ordered ? 3 : 2} />`.
    3. A `SwitchRow` **Recurring**, with the icon
       `<Repeat className={`w-5 h-5 shrink-0 ${item.recurring ? "text-tg-active" : "text-tg-hint"}`} strokeWidth={item.recurring ? 3 : 2} />`.
    4. Only when `item.recurring`: an action button **Not needed this week**, `CalendarOff`, label
       `t("items.recurring.notThisWeek")`.
  - **Not available item:** an action button **Back to the list**, `RotateCcw` in `text-tg-link`,
    label `t("items.unskip")`.
  - Then, in both cases, `mt-2`: an action button **Delete**, with `Trash2` and its label in
    `text-tg-destructive`, label `t("common.delete")`.
- **Action button class:**
  `w-full min-h-11 flex items-center gap-3 py-3 px-4 rounded-2xl bg-tg-secondary-bg text-tg-text font-medium text-start active:scale-[0.98]`.
  Its icon is `w-5 h-5 shrink-0 text-tg-hint` (except Back to the list and Delete, as above), and
  its `aria-label` equals its label.
- **Done:** `w-full mt-4 py-3.5 rounded-2xl bg-tg-button text-tg-button-text font-medium active:scale-[0.98]`,
  label `t("common.done")`, `onClick={finish}`.

Behaviour:

```tsx
  const t = useTranslations();
  // Drafts: null until the user types, so the field shows the live value (a rename from another
  // device shows up) until then.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [qtyDraft, setQtyDraft] = useState<string | null>(null);

  const saveDrafts = (it: ItemData) => {
    if (nameDraft !== null) {
      const trimmed = nameDraft.trim();
      if (trimmed && trimmed !== it.text) onEdit(it.id, trimmed);
    }
    if (qtyDraft !== null) {
      const trimmed = qtyDraft.trim();
      if (trimmed !== (it.quantity ?? "")) onSetQuantity(it.id, trimmed || null);
    }
    setNameDraft(null);
    setQtyDraft(null);
  };

  // Gone or deleted: close and drop the drafts. Completed, or moved between the list and Not
  // available: save the drafts, then close.
  useEffect(() => {
    if (!item || item.deleted_at) { onClose(); return; }
    if (item.completed || (item.skipped_at != null) !== openedSkipped) { saveDrafts(item); onClose(); }
  });

  if (!item || item.deleted_at || item.completed || (item.skipped_at != null) !== openedSkipped) return null;

  const finish = () => { saveDrafts(item); onClose(); };
  const act = (fn: () => void) => { saveDrafts(item); fn(); onClose(); };
  const ordered = item.ordered_at != null;
```

- **Not available** is `act(() => onSkip(item.id, true))`, and **Back to the list** is
  `act(() => onSkip(item.id, false))`.
- **Not needed this week** is
  `act(() => { getTelegramWebApp()?.HapticFeedback?.impactOccurred("light"); onPause(item.id); })`.
  `handlePause` gives no haptic itself, while the other handlers do.
- **Delete** is `act(() => onDelete(item.id))`.
- **The switches** call `onOrder(item.id, !ordered)` and `onSetRecurring(item.id, !item.recurring)`
  directly, with no save and no close.
- **The name field's value** is `nameDraft ?? item.text`, and the quantity field's is
  `qtyDraft ?? item.quantity ?? ""`.
- **Enter in a field** saves only that field. Write a `saveName(it)` and a `saveQuantity(it)`,
  call each one from `saveDrafts`, and call the right one on Enter.

- [ ] **Step 6: Run and see them pass**

Run: `npx vitest run __tests__/unit/item-sheet.test.ts __tests__/unit/categories-switch-page.test.ts __tests__/unit/locale-parity.test.ts __tests__/unit/locale-sync.test.ts`
Expected: PASS.

- [ ] **Step 7: Bite checks**

One at a time, restoring each after its run:
- Remove the `trimmed &&` from the name save. The blank-name test must fail.
- Remove `saveDrafts(item)` from the completed branch of the effect. The Review Focus 3 test must
  fail.
- Remove `saveDrafts(item);` from `act`. The order test must fail.
- Remove `?? item.text` in favour of a seeded initial state. The live-value test must fail.

- [ ] **Step 8: Commit**

```bash
git add components/ui/SwitchRow.tsx components/list/ItemSheet.tsx "app/(app)/list/[id]/page.tsx" messages/en.json messages/he.json messages/ru.json __tests__/unit/item-sheet.test.ts __tests__/unit/categories-switch-page.test.ts
git commit -m "feat(list): item sheet with name, quantity and every item action; shared SwitchRow"
```

---

### Task 5: The grocery row, sections and page wiring

**Files:**
- Modify: `components/ItemRow.tsx`
- Modify: `components/SortableItem.tsx`
- Modify: `components/list/SkippedItemsSection.tsx`, `components/list/CompletedItemsSection.tsx`,
  `components/list/RecurringItemsSection.tsx`
- Modify: `app/(app)/list/[id]/page.tsx` (both render branches ~385-436, sections ~441-478, sheet
  state, the `<ItemSheet>` render)
- Modify: `messages/*.json` (remove `items.ordered.toggleOn` and `items.recurring.toggleOn` if a
  grep shows nothing uses them after this task; `items.recurring.toggleOff` stays, because
  `RecurringItemsSection` uses it)
- Modify: `README.md` (one Features bullet), and
  `docs/superpowers/specs/2026-11-07-not-needed-this-week-design.md` (one line under its decision:
  "Superseded 2026-11-08: the action moved into the item sheet
  (2026-11-08-item-sheet-and-quantity-design.md).")
- Test: create `__tests__/unit/grocery-row.test.ts`
- Test: `__tests__/unit/not-this-week-ui.test.ts`. Its row assertions move to `item-sheet.test.ts`
  coverage. Keep the RecurringItemsSection and page/SortableItem wiring assertions, updated to the
  new prop names.
- Test: `__tests__/unit/item-row-long-text.test.ts` must pass unchanged (the regular row).
- Test: `__tests__/unit/grouped-list-wiring.test.ts`, `__tests__/unit/reminders-ui-removed.test.ts`
  must pass. Adapt only the source strings that this task renames.

**Interfaces:**
- Consumes: `ItemSheet`/`ItemSheetProps` (Task 4); `handleSetQuantity` (Task 3); `items.unskip`,
  `items.recurring.title` and `items.ordered.label` (Task 4 and existing).
- Produces:
  - **`ItemRowProps`:**
    - It removes `onOrder`, `onToggleRecurring` and `onPause` (only the sheet uses them now).
    - It keeps `ordered` and `recurring` as booleans for the marks.
    - It adds `quantity?: string | null` and `onOpenDetails?: (id: string) => void`.
    - `onSkip` now only drives Back to the list on a Not available row.
  - **`SortableItem`** forwards `quantity` and `onOpenDetails` and drops the three removed props.

- [ ] **Step 1: Write the failing tests** (`__tests__/unit/grocery-row.test.ts`)

Render `ItemRow` with `renderToStaticMarkup`, as `not-this-week-ui.test.ts` does (it mocks
`next-intl` to echo keys and calls `ItemRow` with real React). Base props:
`{ id:"a", text:"Milk", completed:false, onToggle, onDelete, onEdit, onOpenDetails }`.

**Sheet-mode rows:**
- Sheet mode, active: the markup contains no `<button` other than the circle. Count `<button`
  occurrences, which equal 1, unless `isDuplicate` with `onRemoveDuplicates`, which gives 2.
- `ordered: true` renders an element with `aria-label="items.ordered.label"`. `recurring: true`
  renders one with `aria-label="items.recurring.title"`. Neither appears when false.
- `quantity: "2 L"` renders `2 L`, and its element's class contains `text-end` and `shrink-0`.
  `quantity: null` renders no quantity element. Give it `data-qty` so the test can find it.
- **The tap:**
  - Call `ItemRow` as a function (the `item-row-long-text` technique) and find the
    `role="button"` div that contains the name. Its `onClick` calls `onOpenDetails("a")`, and the
    next render has no `textarea`.
  - Its `onKeyDown` with `{key:"Enter"}` also calls `onOpenDetails("a")`.
- **A Not available row** (`skipped: true, onSkip, onOpenDetails`): exactly two `<button`, the
  circle and one with `aria-label="items.unskip"`. That button's click calls `onSkip("a", false)`.

**Regular rows:**
- No `onOpenDetails`, with `quantity: "2 L"` passed: `2 L` isn't rendered (the page never passes it
  there, but the row also ignores it). There is a delete button, and a tap on the name opens the
  inline `textarea`. `item-row-long-text.test.ts` covers the rest.

**Source checks:**
- **RTL** (Review Focus 5): `ItemRow.tsx`, `ItemSheet.tsx` and `SwitchRow.tsx` sources don't match
  `/\b(ml|mr|pl|pr|left|right)-|text-(left|right)\b/`.
- **Page wiring** (on `page.tsx`):
  - Both render branches pass `quantity={item.quantity}` and `onOpenDetails={openSheet}` only on
    grocery. The flat branch uses `listType === "grocery" ? … : undefined`.
  - `<ItemSheet` is rendered with `item={sheetItem}`.
  - `sheetItem` is found by `i.id === sheet.id || i._tempId === sheet.id` (Review Focus 4). Assert
    the source contains `i._tempId === sheet.id`.
  - **Bite this:** with the `_tempId` clause removed, a temp-id swap would close the sheet.

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run __tests__/unit/grocery-row.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `ItemRow`**

- Props, as in Interfaces. Add `const sheetMode = !!onOpenDetails;`.
- **The name column** (`div.flex-1.min-w-0 …`): in view mode its inner tap div becomes:

```tsx
          <div
            {...(sheetMode
              ? {
                  role: "button",
                  tabIndex: 0,
                  "aria-haspopup": "dialog" as const,
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenDetails!(id); }
                  },
                }
              : {})}
            onClick={() => {
              if (sheetMode) { onOpenDetails!(id); return; }
              if (!completed && onEdit) { setEditText(text); setIsEditing(true); }
            }}
            className={sheetMode ? "flex items-start gap-3 cursor-pointer" : undefined}
          >
```

- **Inside it:** the existing name block (the `div.flex.items-start.gap-1.5` with the text `span`
  and the duplicate mark, plus the creator/editor line) goes in a `div.flex-1.min-w-0`.
  - In sheet mode, after the duplicate mark, add the marks, each `shrink-0 mt-[5px]`:
    - On the way:
      `{ordered && <Truck aria-label={t("ordered.label")} role="img" className="w-3.5 h-3.5 shrink-0 mt-[5px] text-amber-500" strokeWidth={3} />}`
    - Recurring:
      `{recurring && <Repeat aria-label={t("recurring.title")} role="img" className="w-3.5 h-3.5 shrink-0 mt-[5px] text-tg-active" strokeWidth={3} />}`
    - Pending: `{isPending && <Clock className="w-3.5 h-3.5 shrink-0 mt-[5px] text-tg-hint" />}`
  - Then, a sibling of that `div.flex-1`:

```tsx
            {sheetMode && quantity && (
              <span data-qty className="shrink-0 max-w-[40%] text-end text-[15px] leading-6 text-tg-hint tabular-nums wrap-anywhere">
                {quantity}
              </span>
            )}
```

  When not in sheet mode, keep the original structure exactly. Render the wrapper only in sheet
  mode, or make sure `item-row-long-text.test.ts` still finds the `span` inside the `div` with
  `onClick`.
- **Trailing area:**
  - The pending `Clock` stays trailing only when `!sheetMode`.
  - Remove the Order, Pause and Repeat buttons and their imports.
  - The skip button renders only when `skipped && onSkip && !completed`: `RotateCcw` in
    `text-tg-link`, with `aria-label={t("unskip")}`, calling `onSkip(id, false)`.
  - The delete `X` renders only when `!sheetMode`.
- **Completed rows** get a read-only quantity. `CompletedItemsSection` passes `quantity` on grocery
  lists, and `ItemRow` renders `data-qty` when `quantity` is set and `completed`, even outside sheet
  mode. The X stays. A regular list never passes `quantity`.

- [ ] **Step 4: Wire `SortableItem`, the sections and the page**

**`SortableItem.tsx`:** drop `onOrder`, `onToggleRecurring` and `onPause` from its props and the
forward. Add `quantity` and `onOpenDetails` to both.

**`SkippedItemsSection`:** add props `onOpenDetails` and `listType`-free `quantity` per item
(it renders only on grocery). Pass `quantity={item.quantity}` and `onOpenDetails={onOpenDetails}`.

**`CompletedItemsSection`:** add a prop `showQuantity: boolean` and pass
`quantity={showQuantity ? item.quantity : undefined}`.

**`RecurringItemsSection`:** after the truncated text block, add
`{item.quantity && <span className="shrink-0 text-[15px] text-tg-hint tabular-nums">{item.quantity}</span>}`.

**`page.tsx`:**

```tsx
  // The item sheet (grocery lists): which item, and whether it was a Not available item when it
  // opened. Found by id or by the temp id it had, so a pending item's save doesn't close it.
  const [sheet, setSheet] = useState<{ id: string; skipped: boolean } | null>(null);
  const openSheet = useCallback((id: string) => {
    const it = items.find((i) => i.id === id);
    if (it) setSheet({ id, skipped: it.skipped_at != null });
  }, [items]);
  const sheetItem = sheet ? items.find((i) => i.id === sheet.id || i._tempId === sheet.id) : undefined;
  // A type change to Regular closes it: regular lists have no sheet.
  if (sheet && listType !== "grocery") setSheet(null);
```

- **The grouped branch** (always grocery): remove `onSkip`, `onOrder`, `onToggleRecurring` and
  `onPause`. Add `quantity={item.quantity}` and `onOpenDetails={openSheet}`. Keep `ordered` and
  `recurring`.
- **The flat branch:** remove those four props. Add
  `quantity={listType === "grocery" ? item.quantity : undefined}` and
  `onOpenDetails={listType === "grocery" ? openSheet : undefined}`.
- **`SkippedItemsSection`:** gets `onOpenDetails={openSheet}`.
- **`CompletedItemsSection`:** gets `showQuantity={listType === "grocery"}`.
- **After the `SignalSheet`:**

```tsx
      {sheet && listType === "grocery" && (
        <ItemSheet
          item={sheetItem}
          openedSkipped={sheet.skipped}
          onClose={() => setSheet(null)}
          onEdit={handleEditItem}
          onSetQuantity={handleSetQuantity}
          onSkip={handleSkip}
          onOrder={handleOrder}
          onSetRecurring={handleSetRecurring}
          onPause={handlePause}
          onDelete={handleDelete}
        />
      )}
```

- Destructure `handleSetQuantity` from `useItemHandlers`.

- [ ] **Step 5: Update the moved tests**

- **`not-this-week-ui.test.ts`:**
  - Delete the row-level `ItemRow` pause-button cases, which `item-sheet.test.ts` now covers, and
    the Truck→CalendarOff→Repeat markup order.
  - Keep the RecurringItemsSection render cases.
  - Its source checks become: `page.tsx` contains `onPause={handlePause}` (the sheet), and
    `SortableItem.tsx` doesn't contain `onPause`.
- **The other tests:** update the source strings in `grouped-list-wiring.test.ts` and
  `reminders-ui-removed.test.ts` only if they referenced a removed prop.

- [ ] **Step 6: Remove unused copy, README, spec note**

- **Copy:** run `grep -rn "ordered.toggleOn\|recurring.toggleOn" app components src`. For each key
  with no hits, delete it from all three `messages/*.json`.
- **README Features:** one bullet: "Item sheet (grocery lists): tap an item for its quantity,
  On the way, Recurring, Not available, Not needed this week and Delete. Voice fills the quantity."
  Match the README's existing bullet style.
- **Spec note:** add the "Superseded 2026-11-08" line to the 2026-11-07 spec, under its
  "**Where:**" decision.

- [ ] **Step 7: Run the full gate**

Run: `npx eslint . && npx vitest run && npx next typegen && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 8: Bite checks**

One at a time, restoring each after its run:
- Render the delete `X` in sheet mode as well. The button-count test must fail.
- Drop `i._tempId === sheet.id`. The page source test must fail.
- Drop `role: "button"` from the tap div. The tap test must fail, because it finds the div by its
  role.

- [ ] **Step 9: Commit**

```bash
git add components/ItemRow.tsx components/SortableItem.tsx components/list/SkippedItemsSection.tsx components/list/CompletedItemsSection.tsx components/list/RecurringItemsSection.tsx "app/(app)/list/[id]/page.tsx" messages/en.json messages/he.json messages/ru.json README.md docs/superpowers/specs/2026-11-07-not-needed-this-week-design.md __tests__/unit/grocery-row.test.ts __tests__/unit/not-this-week-ui.test.ts __tests__/unit/grouped-list-wiring.test.ts __tests__/unit/reminders-ui-removed.test.ts
git commit -m "feat(list): grocery rows open the item sheet; quantity and status marks on the row"
```

Add to the commit only the files that actually changed.
