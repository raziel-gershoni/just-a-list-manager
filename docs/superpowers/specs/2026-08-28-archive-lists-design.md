# Archive lists — Design

**Date:** 2026-08-28
**Status:** Approved (design)

## Problem

There is no archive. A repo-wide search for "archiv" across `app/`, `components/`, `src/`, `supabase/`, and `messages/` returns nothing, and the `lists` table has only `id, name, owner_id, deleted_at, created_at, updated_at, type, icon, color`.

The only way to get a list off the home screen is to delete it. Delete is a soft delete (`app/api/lists/route.ts:296-300` sets `deleted_at`) and `PATCH /api/lists { id, restore: true }` (`route.ts:186-214`) can bring it back — but `restore` is reachable *only* from the 4-second undo toast (`app/page.tsx:275`). After that the row is recoverable for 30 days by database query and by nothing else, until `002_cleanup_cron.sql:13` purges it.

So the app already has hide-and-restore plumbing with a 30-day window and no user-facing door on it. A list you have finished with — last year's camping trip, a completed project — has to be destroyed or left cluttering the home screen.

Collaborators have it worse: a list shared with you cannot be removed from your home screen at all. Edit and delete are owner-only (`app/page.tsx:461-462`).

## Solution

Archive is a **per-user view filter**, not a state change on the list. Archiving a shared list removes it from *your* home screen and leaves everyone else's untouched — the same shape as the per-user ordering in `024_list_order.sql`. This also gives collaborators their first way to clear a shared list from their own home screen.

Because archive is per-user, an archived list stays fully functional: no read-only mode, no permission changes, no invite-link handling. It simply is not shown, and it stops notifying the person who archived it.

Confirmed scope decisions:

- **Who it hides for:** just the person who archived it.
- **Reminders:** archiving mutes that list's reminders **for that user**. Reminder rows are left intact. On a shared list, other collaborators still receive theirs.
- **Delete leak:** fixed in the same change (see "Reminders" below) — deleting a list currently does not stop its reminders.
- **UI:** an always-visible **Active / Archived** toggle in the home header. No new route.

## Architecture / edit points

### 1. Migration — `supabase/migrations/025_user_list_state.sql` (new)

`024_list_order.sql` created `list_order(user_id, list_id, position)` — already deployed with real rows. Rather than add a second table with the same key, rename it into a general per-user list-state table:

```sql
-- Archive is per-user, like list order. Fold both into one per-user state table
-- rather than carry two tables keyed (user_id, list_id) that must be read together.
ALTER TABLE list_order RENAME TO user_list_state;

-- A list can be archived without ever having been dragged.
ALTER TABLE user_list_state ALTER COLUMN position DROP NOT NULL;

ALTER TABLE user_list_state ADD COLUMN archived_at TIMESTAMPTZ;

-- Serves the archived-list lookups; the PK already serves (user_id, list_id).
CREATE INDEX IF NOT EXISTS idx_user_list_state_archived
  ON user_list_state(user_id) WHERE archived_at IS NOT NULL;

ALTER POLICY "list_order_select_own" ON user_list_state RENAME TO "user_list_state_select_own";
```

Notes:

- A table rename carries its RLS policies, indexes, and constraints with it; only the names go stale, which the `ALTER POLICY ... RENAME` fixes.
- The rename is data-preserving, so every existing manual ordering survives.
- **Must verify during implementation:** the reorder upsert sends only `{user_id, list_id, position}`. PostgREST should generate `ON CONFLICT DO UPDATE SET` for supplied columns only, leaving `archived_at` untouched. If it instead nulls unsupplied columns, the reorder route must read-modify-write or use an explicit RPC.
- **Alternative considered and rejected:** a separate additive `list_archive(user_id, list_id, archived_at)` table. Zero risk to the working reorder feature, but leaves two tables with an identical key that every read must join together, and a third would follow the next time per-user state is needed.

### 2. Rename fallout

`list_order` is referenced in exactly two places, both of which become `user_list_state`:

- `app/api/lists/route.ts` — the `positions` lookup added by the reordering feature.
- `app/api/lists/reorder/route.ts` — the bulk upsert.

`src/utils/list-order.ts` and `__tests__/unit/list-order.test.ts` are pure and reference no table name; they keep their filenames.

### 3. `GET /api/lists` — filter by archive state

The existing `user_list_state` query already runs for `position`. Extend its select to `list_id, position, archived_at` and build a second map:

```ts
const archived = new Set<string>();
// ... alongside the existing positions.set(...)
if (row.archived_at) archived.add(row.list_id);
```

Then filter `listsWithCounts` before sorting:

- default: keep lists **not** in `archived`
- `?archived=1`: keep **only** lists in `archived`

The response stays a plain array. `src/hooks/useListData.ts:44-58` fetches this endpoint to find one list's metadata and must keep working — so the detail page passes `?archived=1` as a fallback when the default response does not contain its list id, or simply always requests both. Simplest correct approach: `useListData` retries with `?archived=1` when the list is not found in the default response.

Sorting is unchanged — `sortListsByUserOrder` runs on whichever set survives the filter.

### 4. Endpoint — `app/api/lists/archive/route.ts` (new)

```
POST /api/lists/archive   { listId: string, archived: boolean }  ->  { archived: boolean }
```

Modelled on `app/api/lists/reorder/route.ts`:

1. `verifyUserAuth(request, apiRateLimiter, "lists-archive")`.
2. `parseBody(archiveListSchema, body)`.
3. **Authorization by visibility, not permission.** Deliberately *not* `verifyListPermission(..., "edit")` and deliberately not folded into the owner-only `PATCH /api/lists`: archiving is per-user, so a view-only collaborator must be able to archive. Reuse the owned + approved-collaborator lookup, and 404 if the list is not visible to this caller.
4. Upsert `{ user_id, list_id, archived_at: archived ? new Date().toISOString() : null }` on conflict `user_id,list_id`. Setting `archived_at` to `null` is the unarchive path; the row is kept so any `position` survives.

Both visibility queries must have their `error` checked and 500 on failure — postgrest-js resolves rather than rejects, so an unchecked error is indistinguishable from "this user can see nothing" (the same defect the reorder review caught).

### 5. Validation — `src/schemas/lists.ts`

```ts
// POST /api/lists/archive
export const archiveListSchema = z.object({
  listId: z.string().uuid(),
  archived: z.boolean(),
});
```

### 6. Reminders — mute archived, and close the delete leak

Two crons are the only autonomous senders. Both currently ignore list state entirely.

**`app/api/cron/reminders/route.ts`.** The loop already has the pattern to extend — item completed → stamp `sent_at` and skip; item deleted → stamp `cancelled_at` and skip (`route.ts:46-59`). Add the list-level equivalents:

- Add `deleted_at` to the joined list select (currently `lists!inner(name)`).
- **List soft-deleted** → stamp `cancelled_at`, skip. Mirrors item-deleted.
- **Recipient has archived the list** → stamp `sent_at`, skip that recipient. Mirrors item-completed.

Stamping matters beyond correctness: the query is `.limit(50)` over all due, unstamped reminders (`route.ts:24-27`). A suppressed reminder that is never stamped stays in that window forever and would eventually crowd out real ones.

For a shared reminder (`is_shared`), recipients are resolved at `route.ts:76-90`; drop the ones with an `archived_at` row for that list, and stamp `sent_at` only when no recipient remains.

**`app/api/cron/digest/route.ts`.** The per-user query at `route.ts:54-63` selects `lists!inner(name)`; add `id, deleted_at` and extend the existing JS filter at `route.ts:66-69` to drop reminders whose list is deleted or archived by this user (one `user_list_state` lookup per user, inside the loop that already runs per user).

**Deviation from the option as offered:** `cancelItemReminders` is *not* called on list delete. Its signature is `(supabase, itemIds)` — item ids, not a list id — and more importantly, cancelling at delete time would break the 4-second undo, since `restore` does not un-cancel. The cron branch closes the leak completely because the crons are the only autonomous senders, and it leaves undo intact.

### 7. Voice handler — `src/services/voice-handler.ts:105-134`

The voice pipeline enumerates lists itself to pick a target for "add milk to X". Exclude lists the speaking user has archived, so archived list names never reach Gemini. Note this makes the single-list default (`voice-handler.ts:244-247`) more likely to fire as lists get archived.

### 8. Frontend

**`app/page.tsx`:**

- **Mode state** `view: "active" | "archived"`, default `"active"`. Switching refetches with the appropriate query param.
- **Toggle** rendered under the `<h1>{t('lists.title')}</h1>` header (`page.tsx:387`), always visible — a two-segment control styled with the existing `bg-tg-secondary-bg` / `bg-tg-button` tokens rather than a new palette.
- **Drag reorder is not rendered in Archived mode.** `DragDropProvider` and `SortableListCard` are used only in Active mode; Archived mode maps plain `ListCard`s. This mirrors how the item screen handles non-draggable sections — it does not disable the provider, it simply does not render one.
- **Archive/unarchive** is optimistic: remove the card from the current view, show the existing toast with Undo, and `POST /api/lists/archive`. On failure, restore the card and show a failure toast — the same shape as the reorder failure path, including the `{ silent: true }` refetch so a failure never swaps in the full-page error view.
- **Empty states:** Archived mode with nothing in it shows a short message, not the first-run `EmptyState` with its "create your first list" call to action.

**`components/ListCard.tsx`:** add an optional `onArchive` and `onUnarchive`. In Active mode the card shows an `Archive` icon for **all roles** (archiving is your own view, not an edit). In Archived mode it shows only `ArchiveRestore` — no edit, no delete.

### 9. i18n

New keys in the `lists` namespace, added to `en`, `he`, and `ru` at the same position (enforced by `__tests__/unit/locale-parity.test.ts`):

```
"archive": "Archive"
"unarchive": "Unarchive"
"archived": "Archived"
"active": "Active"
"listArchived": "List archived"
"listUnarchived": "List unarchived"
"archiveFailed": "Couldn't archive the list"
"emptyArchived": "No archived lists"
```

Russian plural rules do not apply to any of these (no counts).

### 10. Testing

Repo convention: no jsdom, no component tests, `__tests__/**/*.test.ts` only. Pure logic is extracted and unit-tested.

- **`src/utils/list-archive.ts`** (new) — `partitionListsByArchiveState(lists, archivedIds, view)` returning the visible set. Tested for: active view excludes archived; archived view includes only archived; a list with a `user_list_state` row but `archived_at: null` counts as active; empty archive set.
- **`src/utils/reminder-suppression.ts`** (new) — the pure decision the crons make: given a list's `deleted_at` and the set of user ids that archived it, return `{ action: "cancel" | "send" | "stamp-sent", recipients: string[] }`. This is the highest-risk logic in the change and is otherwise untestable, since the crons cannot be run without Supabase.
- **`__tests__/unit/locale-parity.test.ts`** already guards the new keys across all three locales.
- A guard test asserting no source file still references the old `list_order` table name.

## Known consequences

- **Recurring reminders on an archived list stall.** A series advances when the user taps Done on the Telegram message (`bot.ts:405-468` → `src/services/recurring.ts:19-74`); suppressed means never tapped. Unarchiving does not resurrect past-due ones — the user re-arms.
- **Archived lists still count toward the 50-list cap** (`app/api/lists/route.ts:134-149`, unchanged). The list is fully alive for collaborators; letting a personal view filter free a global slot would allow unbounded owned lists.
- **Auto-open-single-list is unchanged** (`app/page.tsx:98-109`), so archiving down to one active list can drop the user into it — once per session, via the existing `sessionStorage` guard.
- **Archived lists keep their `position`.** Unarchiving returns a list to its old slot. Positions may collide after an unarchive, which `sortListsByUserOrder` already resolves by owned-first then `updated_at`.
- **The archive is unbounded.** Nothing purges archived lists, and they are excluded from no cap. Acceptable given the 50-list ceiling still applies.

## Out of scope

- Read-only or frozen archived lists (meaningless for a per-user filter).
- Bulk archive, auto-archive by inactivity, or an archive retention policy.
- Archiving individual items.
- Realtime sync of archive state across a user's devices — it propagates on the next focus/refetch, like ordering.
