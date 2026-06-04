# Normalize text on add (storage-layer canonicalization)

## Motivation

Today the DB holds whatever bytes the user typed. We added compare-time normalization (`normalizeForCompare`) so duplicate detection sees `קערות חד”פ` (U+201D) and `קערות חד״פ` (U+05F4) as equivalent, plus a `sortForDedup` heuristic that prefers "clean" rows over "noisy" rows when collapsing duplicates. This solution works, but every read-side comparison must remember to normalize, and a missed site silently breaks detection (already happened once with the per-item badge).

If we canonicalize at write time, the DB itself becomes the canonical store. Read-side normalization simplifies to plain case-folding. Future features (search, export, share, voice) inherit the canonical property without per-feature plumbing.

## Goals

- All `items.text` rows are stored in canonical form.
- All server-side write paths apply the same canonicalization.
- All search inputs that ILIKE/fuzzy-match against `items.text` apply the same canonicalization to the query side.
- Compare-time normalization collapses to plain case-folding.
- Migration is auditable (dry-run preview) and one-way.

## Non-goals

- Client-side normalization. The server is the single source of truth; the client can be optimistic with raw input and the round-trip will canonicalize.
- Storing the user's original codepoints anywhere (no shadow column). One-way migration is accepted.
- Normalizing list names, user names, or any column other than `items.text`. Out of scope.
- Migrating `items.text` rows that already differ in case (case is preserved; only punctuation/bidi/whitespace gets folded).

## Design

### 1. New utility: `normalizeForStorage`

In `src/utils/text-normalize.ts`, alongside the existing `normalizeForCompare`:

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

Reuses the existing `BIDI_MARKS`, `QUOTE_FOLD`, `QUOTE_FOLD_RE`, `WHITESPACE_RUN` constants from the same file. The single difference from `normalizeForCompare` is that **`.toLocaleLowerCase()` is omitted** — storage preserves the user's case.

Quote-fold target is universal ASCII (`"` U+0022, `'` U+0027). In this Hebrew-dominant app, mobile Hebrew keyboards already emit ASCII straight quotes by default, so ASCII is the form the majority of users already type. Aligning storage with the dominant keyboard output minimizes surprise.

### 2. Write-path application

Four server-side write sites switch from `.trim()` to `normalizeForStorage()`:

| File | Line | Path |
|---|---|---|
| `app/api/lists/[id]/items/route.ts` | 86 | POST idempotent single-item create |
| `app/api/lists/[id]/items/route.ts` | 183 | POST batch create (comma-separated) |
| `app/api/lists/[id]/items/route.ts` | 298–299 | PATCH text update |
| `src/services/voice-handler.ts` | 417 | Voice direct insert via Supabase |

All four sites currently call `.trim()`; they will call `normalizeForStorage()` (which includes `.trim()` plus the rest of the chain).

### 3. Search-input normalization

Two server-side read sites in `src/services/item-recycler.ts` normalize their search input before issuing the SQL:

- `findRecyclableItems(listId, searchText)` — normalize `searchText` before the `escapeIlike()` call.
- `findFuzzyMatch(listId, text)` — normalize `text` before passing to the `find_fuzzy_items` RPC.

Without this, a user typing `קערות חד”פ` (curly) would fail to match the stored `קערות חד"פ` (ASCII).

### 4. One-time migration

New file `scripts/normalize-items.ts`, run via `tsx` so it imports `normalizeForStorage` directly from `src/utils/text-normalize.ts` (guarantees identical logic between runtime and migration). The `.ts` extension is intentional — using `tsx` lets us reuse the runtime function rather than reimplementing the chain in JavaScript.

Two modes:

```bash
# Preview: count + sample, no writes.
npx tsx scripts/normalize-items.ts --dry-run

# Apply: row-by-row UPDATE only where text !== normalizeForStorage(text).
npx tsx scripts/normalize-items.ts
```

Migration query shape:

```sql
SELECT id, text FROM items;
-- For each row where canonical = normalizeForStorage(text) and canonical !== text:
UPDATE items SET text = $canonical, updated_at = now() WHERE id = $id;
```

Each UPDATE fires a standard Realtime event; subscribers re-render with the canonical text. Row count is low enough (a few thousand) that throttling is unnecessary.

The migration script is committed in the same PR for review, run once after the deploy is live, then removed in a follow-up commit.

### 5. Compare-time simplification (same PR)

Once storage is canonical, the compare-time machinery collapses:

- `normalizeForCompare(s)` body reduces to `s.toLocaleLowerCase()`. Name, callers, and tests stay; the body shrinks. Only case-fold remains because storage now handles everything else.
- `sortForDedup` is deleted — "clean vs noisy" is never different post-migration. `handleRemoveDuplicates` reverts to pure position sort.
- `computeDuplicateTexts` is unchanged in shape; internally it calls the simplified `normalizeForCompare`.
- The four `duplicateTexts.has(normalizeForCompare(item.text))` lookup sites stay as-is — they continue to work, just with the now-trivial normalizer.

The corresponding `sortForDedup` tests in `__tests__/unit/duplicate-detection.test.ts` are removed; the existing `computeDuplicateTexts` tests still pass because the behavior they exercise is preserved.

### 6. Tests

In `__tests__/unit/text-normalize.test.ts`, add a `describe("normalizeForStorage")` block with cases that mirror `normalizeForCompare` minus case-fold:

| input A | input B | expected |
|---|---|---|
| `קערות חד”פ` (U+201D) | `קערות חד״פ` (U+05F4) | both produce `קערות חד"פ` (U+0022) |
| `‏בצל מיובש` (RLM-prefixed) | `בצל מיובש` | both produce `בצל מיובש` |
| `  קמח   לחם  ` | `קמח לחם` | both produce `קמח לחם` |
| `Milk` | — | output is `Milk` (case preserved — key difference from `normalizeForCompare`) |
| `O’Brien` (U+2019) | `O'Brien` (U+0027) | both produce `O'Brien` |
| `חלב` | `חלבב` | different outputs (negative case) |

For the existing `normalizeForCompare` tests: after the body simplifies to `s.toLocaleLowerCase()`, only the case-insensitivity test (`Milk` vs `milk`) still passes against raw inputs. The other seven tests exercise behavior that has moved from compare-time to storage-time, and would now fail because `.toLocaleLowerCase()` alone doesn't fold quotes or strip bidi marks. They are deleted in this PR — the equivalent properties are asserted in the new `normalizeForStorage` test block. Two tests remain in the compare-time block: case-insensitivity, and a negative regression case (`חלב` vs `חלבב`).

### 7. Rollout (single PR)

The PR contains, in order:

1. Add `normalizeForStorage` + tests.
2. Apply at the 4 write sites + 2 search sites.
3. Add `scripts/normalize-items.ts` (committed but not yet run).
4. Simplify `normalizeForCompare` body to `s.toLocaleLowerCase()`.
5. Delete `sortForDedup` + its tests; revert `handleRemoveDuplicates` to position-only sort.

Deploy lands. Run `npx tsx scripts/normalize-items.ts --dry-run` against prod; review the count and samples. Run without `--dry-run`. Verify with a query that no `items.text` row contains any character in the noisy set (`[‎‏‪-‮⁦-⁩“”‘’״׳]`). Follow-up commit deletes `scripts/normalize-items.ts`.

## Risks

- **One-way data migration.** Original codepoints are not recoverable. Mitigation: dry-run mode shows the exact diff; PR review can sanity-check the normalizer's output against a sample before applying.
- **Single-PR blast radius.** Bugs in any of the normalizer / write-sites / migration / compare-simplification surface together. Mitigation: unit tests cover the normalizer; the write-path swaps are mechanical; the migration runs only after the new code is live, so the runtime normalizer is exercised on new writes before any historic data is touched.
- **Realtime UPDATE storm during migration.** Every row update fires an event. Row count is small enough that this is a non-issue in practice; worth doing during a low-traffic window.
- **External or future writers.** Any code that writes directly to `items.text` without going through `normalizeForStorage` re-introduces noise. Acceptable today (only API handlers and voice-handler write); revisit if a new write path is added.
- **ILIKE/fuzzy search input.** Already covered in §3, but worth flagging: if either site is missed, search silently misses matches.

## Out of scope (explicit punt list)

- Backfilling other text columns (`lists.name`, `users.name`).
- Normalizing list names / collaborator names.
- Adding a shadow `text_original` column for audit purposes.
- Context-aware quote folding (e.g. preserving Hebrew gershayim in Hebrew strings while keeping ASCII elsewhere) — universal ASCII fold is chosen for simplicity.
- Migrating the dedup-survivor heuristic from "clean vs noisy" to a different tie-breaker (post-migration, position is sufficient).
