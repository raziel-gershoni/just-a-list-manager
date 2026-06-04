# Normalize-on-add Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `items.text` row in the DB canonical (NFC + bidi-stripped + quote-folded to ASCII + whitespace-collapsed + trimmed), with all server-side write/search paths going through the same canonicalizer, and the compare-time helpers simplified to plain case-folding.

**Architecture:** A new pure utility `normalizeForStorage` (same chain as `normalizeForCompare` minus the lowercase) is applied at every server-side write boundary (4 sites) and every server-side text-search boundary (2 sites). A one-time TypeScript migration script rewrites existing rows using the same utility. The compare-time normalizer (`normalizeForCompare`) shrinks to a single `.toLocaleLowerCase()` call; `sortForDedup` is deleted; `handleRemoveDuplicates` reverts to a pure position sort.

**Tech Stack:** TypeScript, Vitest 3.x, postgres (already a project dep, used by the existing migration script), `tsx` (run ad-hoc via `npx tsx`).

**Spec:** `docs/superpowers/specs/2026-06-04-normalize-on-add-design.md`

---

## File Structure

- **Modify:** `src/utils/text-normalize.ts` — add `normalizeForStorage`; later simplify `normalizeForCompare`.
- **Modify:** `app/api/lists/[id]/items/route.ts` — swap 4 `.trim()` calls (POST idempotent, POST batch×2, PATCH).
- **Modify:** `src/services/voice-handler.ts` — wrap one `voiceItem.text` in normalizer.
- **Modify:** `src/services/item-recycler.ts` — normalize 2 search inputs.
- **Modify:** `src/hooks/useItemHandlers.ts` — drop the `sortForDedup` call.
- **Modify:** `src/utils/duplicate-detection.ts` — delete `sortForDedup` and the noisy-chars regex.
- **Create:** `scripts/normalize-items.ts` — one-time migration with `--dry-run` mode.
- **Modify:** `__tests__/unit/text-normalize.test.ts` — add normalizeForStorage block; prune 6 obsolete normalizeForCompare tests.
- **Modify:** `__tests__/unit/duplicate-detection.test.ts` — delete sortForDedup tests.

---

## Task 1: Build `normalizeForStorage` via TDD

**Files:**
- Modify: `src/utils/text-normalize.ts`
- Test: `__tests__/unit/text-normalize.test.ts`

### - [ ] Step 1.1: Add the first failing test (production case)

Append a new `describe` block at the end of `__tests__/unit/text-normalize.test.ts`:

```ts
describe("normalizeForStorage", () => {
  it("folds curly U+201D and Hebrew gershayim U+05F4 both to ASCII straight quote", () => {
    const curly = 'קערות חד”פ';
    const gershayim = 'קערות חד״פ';
    const expected = 'קערות חד"פ';
    expect(normalizeForStorage(curly)).toBe(expected);
    expect(normalizeForStorage(gershayim)).toBe(expected);
  });
});
```

You also need to update the existing import line at the top:

```ts
import { normalizeForCompare, normalizeForStorage } from "@/src/utils/text-normalize";
```

### - [ ] Step 1.2: Run the test, verify it fails

Run: `npm run test:run -- __tests__/unit/text-normalize.test.ts`
Expected: FAIL — `normalizeForStorage` is not exported.

### - [ ] Step 1.3: Add the implementation

In `src/utils/text-normalize.ts`, after `normalizeForCompare`, append:

```ts
export function normalizeForStorage(s: string): string {
  return s
    .normalize("NFC")
    .replace(BIDI_MARKS, "")
    .replace(QUOTE_FOLD_RE, (c) => QUOTE_FOLD[c])
    .replace(WHITESPACE_RUN, " ")
    .trim();
}
```

Reuses the file's existing `BIDI_MARKS`, `QUOTE_FOLD`, `QUOTE_FOLD_RE`, and `WHITESPACE_RUN` constants. The only structural difference from `normalizeForCompare` is that `.toLocaleLowerCase()` is omitted.

### - [ ] Step 1.4: Run the test, verify it passes

Run: `npm run test:run -- __tests__/unit/text-normalize.test.ts`
Expected: PASS (the previous 8 normalizeForCompare tests + 1 new normalizeForStorage test = 9 passing).

### - [ ] Step 1.5: Add remaining normalizeForStorage tests

Append five more tests inside the `describe("normalizeForStorage", ...)` block, right after the production-case test from Step 1.1:

```ts
  it("strips a leading RLM mark (U+200F)", () => {
    expect(normalizeForStorage("‏בצל מיובש")).toBe("בצל מיובש");
  });

  it("collapses runs of whitespace and trims edges", () => {
    expect(normalizeForStorage("  קמח   לחם  ")).toBe("קמח לחם");
  });

  it("preserves case (key difference from normalizeForCompare)", () => {
    expect(normalizeForStorage("Milk")).toBe("Milk");
  });

  it("folds Latin smart apostrophe (U+2019) to ASCII", () => {
    expect(normalizeForStorage("O’Brien")).toBe("O'Brien");
  });

  it("leaves genuinely different texts different (no typo tolerance)", () => {
    expect(normalizeForStorage("חלב")).not.toBe(normalizeForStorage("חלבב"));
  });
```

### - [ ] Step 1.6: Run the test, verify all pass

Run: `npm run test:run -- __tests__/unit/text-normalize.test.ts`
Expected: PASS (8 + 6 = 14 tests in this file).

### - [ ] Step 1.7: Run the full test suite

Run: `npm run test:run`
Expected: all pass (existing 62 + 6 new normalizeForStorage = 68).

### - [ ] Step 1.8: Commit

```bash
git add src/utils/text-normalize.ts __tests__/unit/text-normalize.test.ts
git commit -m "Add normalizeForStorage for write-time canonicalization"
```

---

## Task 2: Apply normalizeForStorage at the 4 server-side write sites

**Files:**
- Modify: `app/api/lists/[id]/items/route.ts:86, 183, 187, 299`
- Modify: `src/services/voice-handler.ts:417`

### - [ ] Step 2.1: Add the import in the API route

In `app/api/lists/[id]/items/route.ts`, change the existing imports block to include `normalizeForStorage`:

```ts
import { createItemIdempotentSchema, createItemSchema, updateItemSchema } from "@/src/schemas/items";
import { parseBody } from "@/src/lib/api-validation";
import { cancelItemReminders } from "@/src/services/reminders";
import { normalizeForStorage } from "@/src/utils/text-normalize";
```

(Place the new import after the last existing import in the block.)

### - [ ] Step 2.2: Swap the POST idempotent path (line 86)

In `app/api/lists/[id]/items/route.ts`, change line 86 from:

```ts
    const text = parsed.data.text.trim();
```

to:

```ts
    const text = normalizeForStorage(parsed.data.text);
```

### - [ ] Step 2.3: Swap the POST batch path — comma-split (line 183)

In `app/api/lists/[id]/items/route.ts`, change line 183 from:

```ts
      .map((t: string) => t.trim())
```

to:

```ts
      .map((t: string) => normalizeForStorage(t))
```

### - [ ] Step 2.4: Swap the POST batch path — array (line 187)

In `app/api/lists/[id]/items/route.ts`, change line 187 from:

```ts
      .map((item) => item.text.trim())
```

to:

```ts
      .map((item) => normalizeForStorage(item.text))
```

### - [ ] Step 2.5: Swap the PATCH path (lines 298–299)

In `app/api/lists/[id]/items/route.ts`, change lines 298–300 from:

```ts
  if (typeof updates.text === "string" && updates.text.trim().length > 0 && updates.text.trim().length <= 500) {
    patchData.text = updates.text.trim();
    patchData.edited_by = auth.userId;
  }
```

to:

```ts
  if (typeof updates.text === "string") {
    const canonical = normalizeForStorage(updates.text);
    if (canonical.length > 0 && canonical.length <= 500) {
      patchData.text = canonical;
      patchData.edited_by = auth.userId;
    }
  }
```

Rationale: the original used `.trim()` for both the length-check predicate AND the stored value. Since the predicate logically operates on the canonical form (the same value being stored), compute it once.

### - [ ] Step 2.6: Add the import in voice-handler

In `src/services/voice-handler.ts`, add to the top-of-file imports (after the existing imports, before the first function):

```ts
import { normalizeForStorage } from "@/src/utils/text-normalize";
```

If the file uses a specific import grouping, place this with the other `@/src/utils/...` imports if any; otherwise just append to the import block.

### - [ ] Step 2.7: Swap the voice direct insert (line 417)

In `src/services/voice-handler.ts`, change line 417 from:

```ts
    text: voiceItem.text,
```

to:

```ts
    text: normalizeForStorage(voiceItem.text),
```

### - [ ] Step 2.8: Type-check

Run: `npx tsc --noEmit`
Expected: no errors.

### - [ ] Step 2.9: Full test suite

Run: `npm run test:run`
Expected: all 68 tests still pass (no test changes in this task).

### - [ ] Step 2.10: Commit

```bash
git add app/api/lists/[id]/items/route.ts src/services/voice-handler.ts
git commit -m "Normalize text at all server-side write boundaries"
```

---

## Task 3: Apply normalizeForStorage at 2 server-side search inputs

**Files:**
- Modify: `src/services/item-recycler.ts`

### - [ ] Step 3.1: Add the import

In `src/services/item-recycler.ts`, add after the existing `import { createServerClient } from "@/src/lib/supabase";`:

```ts
import { normalizeForStorage } from "@/src/utils/text-normalize";
```

### - [ ] Step 3.2: Normalize the input of `findRecyclableItems`

In `src/services/item-recycler.ts`, locate the function `findRecyclableItems`. At the top of the function body (right after the `createServerClient` call), add:

```ts
  const canonical = normalizeForStorage(searchText);
```

Then change the ILIKE line (around line 38) from:

```ts
    .ilike("text", `%${escapeIlike(searchText)}%`)
```

to:

```ts
    .ilike("text", `%${escapeIlike(canonical)}%`)
```

### - [ ] Step 3.3: Normalize the input of `findFuzzyMatch`

In `src/services/item-recycler.ts`, locate the function `findFuzzyMatch`. At the top of the function body, add:

```ts
  const canonical = normalizeForStorage(text);
```

Then change the RPC call (around line 106) from:

```ts
  const { data, error } = await supabase.rpc("find_fuzzy_items", {
    p_list_id: listId,
    p_search_text: text,
    p_threshold: 0.3,
  });
```

to:

```ts
  const { data, error } = await supabase.rpc("find_fuzzy_items", {
    p_list_id: listId,
    p_search_text: canonical,
    p_threshold: 0.3,
  });
```

Also change the fallback line in the same function (look for `return findRecyclableItems(listId, text);` inside the error branch) from:

```ts
    return findRecyclableItems(listId, text);
```

to:

```ts
    return findRecyclableItems(listId, canonical);
```

(`findRecyclableItems` will normalize again internally — that's a no-op since normalization is idempotent — but passing `canonical` keeps the data-flow explicit.)

### - [ ] Step 3.4: Type-check

Run: `npx tsc --noEmit`
Expected: no errors.

### - [ ] Step 3.5: Full test suite

Run: `npm run test:run`
Expected: all 68 tests still pass.

### - [ ] Step 3.6: Commit

```bash
git add src/services/item-recycler.ts
git commit -m "Normalize search input in findRecyclableItems and findFuzzyMatch"
```

---

## Task 4: Add the one-time migration script

**Files:**
- Create: `scripts/normalize-items.ts`

### - [ ] Step 4.1: Create the script

Write the file `scripts/normalize-items.ts`:

```ts
import postgres from "postgres";
import { normalizeForStorage } from "../src/utils/text-normalize.ts";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");
const sql = postgres(DATABASE_URL, { ssl: "require" });

const rows = await sql<{ id: string; text: string }[]>`SELECT id, text FROM items`;

let changed = 0;
const samples: { id: string; before: string; after: string }[] = [];

for (const r of rows) {
  const canonical = normalizeForStorage(r.text);
  if (canonical !== r.text) {
    changed++;
    if (samples.length < 10) {
      samples.push({ id: r.id, before: r.text, after: canonical });
    }
    if (!dryRun) {
      await sql`UPDATE items SET text = ${canonical}, updated_at = now() WHERE id = ${r.id}`;
    }
  }
}

console.log(`${dryRun ? "Would update" : "Updated"} ${changed} of ${rows.length} rows`);
if (samples.length > 0) {
  console.log("\nSample of changes:");
  for (const s of samples) {
    console.log(`  ${s.id.slice(0, 8)}  "${s.before}"  ->  "${s.after}"`);
  }
}

await sql.end();
```

### - [ ] Step 4.2: Smoke-test the script's dry-run mode locally

Run: `npx tsx scripts/normalize-items.ts --dry-run`

Expected: the script connects, prints `Would update N of M rows`, and if N>0 prints up to 10 sample diffs. Should NOT modify any row (verify by re-running — N should be identical on the second dry-run).

If `npx tsx` prompts to install on first use, accept. If it fails because `tsx` cannot find the `.ts` import path, change the import in the script from `"../src/utils/text-normalize.ts"` to `"../src/utils/text-normalize"` (no extension) and retry.

**Do NOT run without `--dry-run` yet.** The migration is run manually in Task 7 after deploy.

### - [ ] Step 4.3: Commit

```bash
git add scripts/normalize-items.ts
git commit -m "Add one-time migration script for items.text canonicalization"
```

---

## Task 5: Simplify `normalizeForCompare` and prune obsolete tests

**Files:**
- Modify: `src/utils/text-normalize.ts`
- Modify: `__tests__/unit/text-normalize.test.ts`

### - [ ] Step 5.1: Simplify the body of `normalizeForCompare`

In `src/utils/text-normalize.ts`, change the existing `normalizeForCompare` function from:

```ts
export function normalizeForCompare(s: string): string {
  return s
    .normalize("NFC")
    .replace(BIDI_MARKS, "")
    .replace(QUOTE_FOLD_RE, (c) => QUOTE_FOLD[c])
    .replace(WHITESPACE_RUN, " ")
    .trim()
    .toLocaleLowerCase();
}
```

to:

```ts
export function normalizeForCompare(s: string): string {
  return s.toLocaleLowerCase();
}
```

The constants `BIDI_MARKS`, `QUOTE_FOLD`, `QUOTE_FOLD_RE`, `WHITESPACE_RUN` remain in the file — `normalizeForStorage` still uses them.

### - [ ] Step 5.2: Prune obsolete normalizeForCompare tests

In `__tests__/unit/text-normalize.test.ts`, inside the existing `describe("normalizeForCompare", ...)` block, **delete** the following six tests:

1. `"treats curly double quote (U+201D) and Hebrew gershayim (U+05F4) as equal — production case"`
2. `"strips a leading RLM mark (U+200F) so prefixed and unprefixed items compare equal"`
3. `"collapses runs of whitespace and trims edges"`
4. `"does NOT collapse a comma into whitespace"`
5. `"treats Latin straight apostrophe and curly apostrophe as equal"`
6. `"does NOT fold Hebrew final letters into their medial form"`

**Keep** these two tests:

- `"is case-insensitive for Latin text"`
- `"does NOT treat genuinely different items as equal (no typo tolerance by design)"`

After this edit, the `describe("normalizeForCompare", ...)` block should contain exactly 2 tests. The `describe("normalizeForStorage", ...)` block remains unchanged (6 tests).

### - [ ] Step 5.3: Run the test file

Run: `npm run test:run -- __tests__/unit/text-normalize.test.ts`
Expected: PASS, 2 + 6 = 8 tests total in this file.

### - [ ] Step 5.4: Type-check and full suite

Run: `npx tsc --noEmit && npm run test:run`
Expected: tsc clean. Full suite: previous 62 - 6 deleted + 6 added = 62 passing. (No net change in count because we deleted 6 and added 6.)

### - [ ] Step 5.5: Commit

```bash
git add src/utils/text-normalize.ts __tests__/unit/text-normalize.test.ts
git commit -m "Reduce normalizeForCompare to case-fold; prune redundant tests"
```

---

## Task 6: Delete `sortForDedup` and revert `handleRemoveDuplicates`

**Files:**
- Modify: `src/utils/duplicate-detection.ts`
- Modify: `__tests__/unit/duplicate-detection.test.ts`
- Modify: `src/hooks/useItemHandlers.ts`

### - [ ] Step 6.1: Delete `sortForDedup` and the noisy-chars regex

In `src/utils/duplicate-detection.ts`, delete the trailing comment block + constant + function (lines 19–33 in the current file). The file should end after the closing `}` of `computeDuplicateTexts`. Final shape:

```ts
import { normalizeForCompare } from "@/src/utils/text-normalize";

export function computeDuplicateTexts(
  items: { text: string; deleted_at: string | null }[]
): Set<string> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.deleted_at) continue;
    const key = normalizeForCompare(item.text);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const result = new Set<string>();
  for (const [key, n] of counts) {
    if (n > 1) result.add(key);
  }
  return result;
}
```

### - [ ] Step 6.2: Delete `sortForDedup` tests

In `__tests__/unit/duplicate-detection.test.ts`, delete the entire `describe("sortForDedup", ...)` block (all 5 tests inside it).

Also update the import at the top of the file from:

```ts
import { computeDuplicateTexts, sortForDedup } from "@/src/utils/duplicate-detection";
```

to:

```ts
import { computeDuplicateTexts } from "@/src/utils/duplicate-detection";
```

After this edit, the file should contain only the `describe("computeDuplicateTexts", ...)` block with 4 tests.

### - [ ] Step 6.3: Revert `handleRemoveDuplicates` to position sort

In `src/hooks/useItemHandlers.ts`, locate the `handleRemoveDuplicates` function. Find the block:

```ts
      // Find all non-deleted items matching text (normalized)
      const normalized = normalizeForCompare(text);
      const matches = sortForDedup(
        items.filter((i) => !i.deleted_at && normalizeForCompare(i.text) === normalized)
      );

      if (matches.length <= 1) return;

      // Keep matches[0] (clean text wins; tie-break by highest position), remove the rest
      const duplicatesToRemove = matches.slice(1);
```

Change it to:

```ts
      // Find all non-deleted items matching text (normalized)
      const normalized = normalizeForCompare(text);
      const matches = items
        .filter((i) => !i.deleted_at && normalizeForCompare(i.text) === normalized)
        .sort((a, b) => b.position - a.position);

      if (matches.length <= 1) return;

      // Keep the highest-position match, remove the rest
      const duplicatesToRemove = matches.slice(1);
```

Also remove the `import { sortForDedup } from "@/src/utils/duplicate-detection";` line from the top of the file.

### - [ ] Step 6.4: Type-check

Run: `npx tsc --noEmit`
Expected: no errors. (If you missed removing the `sortForDedup` import, tsc will complain about an unused import or a missing module.)

### - [ ] Step 6.5: Full test suite

Run: `npm run test:run`
Expected: 62 (previous) - 5 deleted sortForDedup tests = 57 passing.

### - [ ] Step 6.6: Commit

```bash
git add src/utils/duplicate-detection.ts __tests__/unit/duplicate-detection.test.ts src/hooks/useItemHandlers.ts
git commit -m "Remove sortForDedup; revert handleRemoveDuplicates to position sort"
```

---

## Task 7 (MANUAL — runs after deploy lands): Run the migration against production

**This task is not part of the PR commits.** It runs manually after the PR is merged and deployed.

### - [ ] Step 7.1: Push the branch and wait for deploy

Push all task commits. Vercel auto-deploys from main. Wait until the deploy is live.

### - [ ] Step 7.2: Dry-run against prod

```bash
npx tsx scripts/normalize-items.ts --dry-run
```

Read the output. Verify:
- The "Would update N of M rows" count is plausible (most rows unchanged; only ones with bidi/curly/whitespace noise should change).
- The sample diffs all look like correct canonicalization (no weird unexpected mutations).

If anything looks off, STOP and investigate before applying.

### - [ ] Step 7.3: Apply migration

```bash
npx tsx scripts/normalize-items.ts
```

Watch for errors. The script updates one row at a time and prints the final count.

### - [ ] Step 7.4: Verify no noisy characters remain

Write a tiny one-off script `scripts/verify-canonical.mjs` to check this, or inline via a temporary query. The check is:

```sql
SELECT id, text FROM items
WHERE text ~ '[‎‏‪-‮⁦-⁩“”‘’״׳]'
LIMIT 5;
```

Expected: zero rows. If any rows match, those characters slipped through — investigate.

### - [ ] Step 7.5: Smoke-test the live app

Open the Mini App. On the קניות בסופר list, the surviving gershayim row (`c8f653cc`) should now show as `קערות חד"פ` (ASCII straight quote) instead of `קערות חד״פ`. Add a new item with a curly quote — it should land in the DB as ASCII. The duplicate-detection badge should continue to work.

---

## Task 8 (MANUAL — after Task 7): Remove the migration script

**Runs after the migration has been applied and verified.**

### - [ ] Step 8.1: Delete the script and commit

```bash
git rm scripts/normalize-items.ts
git commit -m "Remove one-time normalize-items migration script after backfill"
git push
```

---

## Self-Review Notes

- **Spec coverage:**
  - Spec §1 (`normalizeForStorage` utility) → Task 1.
  - Spec §2 (4 write sites) → Task 2 (note: spec listed "line 183" but the actual batch path has trim calls at BOTH 183 and 187; Task 2 swaps both).
  - Spec §3 (2 search sites) → Task 3.
  - Spec §4 (migration script with --dry-run) → Tasks 4 and 7.
  - Spec §5 (compare-time simplification: normalizeForCompare body + delete sortForDedup + revert handleRemoveDuplicates) → Tasks 5 and 6.
  - Spec §6 (tests: add 6 normalizeForStorage cases; keep only 2 normalizeForCompare cases) → Task 1.5 and Task 5.2.
  - Spec §7 (rollout order) → Task order matches.
- **Placeholder scan:** None — every code-changing step shows the exact code.
- **Type consistency:** `normalizeForStorage(s: string): string` defined in Task 1.3 and referenced in Tasks 2.2–2.7, 3.2–3.3, 4.1. `normalizeForCompare` signature unchanged. `computeDuplicateTexts` signature unchanged.
- **Test-count arithmetic** in expected-output assertions has been computed assuming the suite started at 62 passing tests at the start of this plan. If a test was added/removed by an unrelated change since, adjust expected counts but the deltas (+6 add, -6 prune, -5 sortForDedup delete) remain valid.
