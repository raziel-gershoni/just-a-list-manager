# Text normalization for active-item duplicate detection

## Motivation

A real-world dupe slipped through on the production list "קניות בסופר":

| id | text | char that differs |
|---|---|---|
| `5c1c3328` | `קערות חד”פ` | U+201D (right curly double quote) |
| `c8f653cc` | `קערות חד״פ` | U+05F4 (Hebrew gershayim) |

Both items are active, byte-different, glyph-identical in most fonts. The user added them ~14 days apart. The client dedup check (`useItemHandlers.ts:109`) is a strict `toLowerCase()` equality and missed it.

Other glyph-equal-but-byte-different cases observed in the same list: items prefixed with U+200F (RTL mark) from copy-paste in Hebrew contexts (`‏בצל מיובש`, `‏כוסמין מלא`, etc.).

The server-side fuzzy RPC `find_fuzzy_items` only matches against completed / recently-deleted items, so it never sees active-vs-active.

## Goal

Catch active-vs-active duplicates that differ only in punctuation/bidi/whitespace/casing characters, so the user gets the existing "duplicate" warning toast instead of silently double-adding.

## Non-goals

- No historic cleanup of existing duplicates in the database.
- No normalization of the **stored** text — the user's original characters are preserved on disk.
- No changes to the voice-add path (`voice-handler.ts`) or edit-existing-item path.
- No server-side or RPC changes; no migration.
- No fuzzy / typo tolerance (`חלב` vs `חלבב` will still be treated as distinct).
- Behavior on match stays as today: warning toast for 2.5s, item still gets added. No hard block, no "add anyway" button.

## Design

### 1. New module: `src/utils/text-normalize.ts`

Exports one pure function:

```ts
export function normalizeForCompare(s: string): string;
```

Steps, in order:

1. **NFC normalize**: `s.normalize("NFC")`.
2. **Strip bidi marks**: remove codepoints `U+200E`, `U+200F`, `U+202A`–`U+202E`, `U+2066`–`U+2069`.
3. **Fold quote-family characters to a canonical ASCII form** (compare-only, storage untouched):
   - `”` (U+201D), `“` (U+201C), `״` (U+05F4 gershayim) → `"` (U+0022)
   - `’` (U+2019), `‘` (U+2018), `׳` (U+05F3 geresh) → `'` (U+0027)

   Universal fold (not context-aware). Acceptable because the compare key is invisible to the user, and the original text on disk is untouched. Avoids the complexity of detecting "Hebrew-adjacent" runs in mixed-script strings.
4. **Collapse whitespace**: replace runs of any Unicode whitespace with a single ASCII space.
5. **Trim**.
6. **Lowercase**: `toLocaleLowerCase()`.

The function returns the canonical form; it is **not** stored. It is used only for comparison.

### 2. Call site: `src/hooks/useItemHandlers.ts`

Replace lines 108–110:

```ts
// before
const existing = items.find(
  (i) => !i.completed && !i.deleted_at && !i.skipped_at && i.text.toLowerCase() === text.toLowerCase()
);

// after
const normalized = normalizeForCompare(text);
const existing = items.find(
  (i) => !i.completed && !i.deleted_at && !i.skipped_at && normalizeForCompare(i.text) === normalized
);
```

Cost is `O(n)` per add over current `n ≤ ~200` active items, with NFC and a small set of char replacements per item. Negligible.

### 3. Tests: `__tests__/text-normalize.test.ts`

Vitest unit tests covering:

| input A | input B | expected |
|---|---|---|
| `קערות חד”פ` | `קערות חד״פ` | equal (the production case) |
| `‏בצל מיובש` (U+200F prefix) | `בצל מיובש` | equal |
| `קמח  לחם` (double space) | `קמח לחם` | equal |
| `Milk` | `milk` | equal |
| `O'Brien` | `O’Brien` | equal (both apostrophes fold to U+0027) |
| `חלב` | `חלבב` | **not** equal |
| `שלום, world` | `שלום world` | not equal (comma is content, not whitespace) |

### 4. Verification on live data

The existing dupe `5c1c3328` ("קערות חד”פ", curly) is intentionally **not** being cleaned up. After the change ships:

- Open the קניות בסופר list.
- Type / voice-add `קערות חד״פ` (gershayim).
- The warning toast should fire because the normalized form matches the existing active item.

## Risk analysis

- **Latin typography in compare form** — folding curly quotes universally turns `"smart"` and `"dumb"` into the same key. Acceptable since the compare form is not user-visible and storage is untouched.
- **Performance** — `O(n)` over active items per add; `n` ≤ 500 by list cap. NFC + regex is sub-millisecond. No concern.
- **i18n** — `toLocaleLowerCase()` without a locale uses runtime default; in browser context this is fine. Hebrew has no case so no impact for the primary use case.

## Out of scope (explicit punt list for later)

- Cleanup of pre-existing dupes in current production data.
- Voice-add and edit-existing paths going through the same normalizer.
- A pg_trgm-based active-vs-active fuzzy check on the server (would require a new or extended RPC and a sensible threshold).
- A "we found a similar completed item — restore it?" prompt on the active-add path (currently only the find_fuzzy_items completed-window flow exists).
