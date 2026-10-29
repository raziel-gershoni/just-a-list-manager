# Sync engine repair: design

**Date:** 2026-10-29
**Status:** approved 2026-10-29 (the owner said "go" to the direction and all four picks)
**Background:** the owner sees "random strange behavior". Their own report:
- the "Syncing…" spinner turns after a tap, marking an item done does nothing, and reopening the app shows it done;
- the home screen or a list sometimes sits on grey placeholders after going back.

A six-area audit (`scratchpad/sync/audit.json`) found 23 holes, each reproduced against the real code and confirmed by a skeptic. This spec fixes them.

## Goal

- A change the user makes is never lost, reordered or silently undone.
- The screen shows the user's latest intent until the server confirms it, then the server's truth.
- Moving between screens, reloading, or a network blip never breaks the session.

## Owner decisions (2026-10-29)

1. **Typed adds reuse a completed item.** Typing an item whose text matches a completed item in the list (same normalized text) recycles that item, exactly like tapping the suggestion. No second copy.
2. **Last write wins.** An offline change replayed up to 24 hours later wins over a collaborator's newer edit of the same field.
3. **Bulk actions are scoped.** Clear completed and Unmark all act only on the items the screen showed, never on something a collaborator ticked a moment ago. This is the rule Restore all already uses.
4. **Home counts match the list.** A card's "to buy" count leaves out skipped items, and its "done" count leaves out parked recurring items, as the list itself does.

Settled earlier and unchanged:
- Clear completed and Unmark all are not queued for offline. On failure they revert and show "Failed to sync change" (spec 2026-10-28, call 4A).
- A received "On the way" item keeps its truck mark when unticked (spec 2026-06-26).

## What's wrong, by cause

| # | Hole | Cause |
|---|---|---|
| H1 | One failed token refresh after 5 minutes kills the session; later changes go out as `Bearer null`, get 401 and are dropped | Reconnect clears the JWT on any failure, then falls back to initData that is older than the server's 5-minute limit |
| H2 | Home or a list stuck on placeholders after navigating, 5+ minutes after launch | Every page mounts its own `TelegramProvider`, so each navigation re-authenticates with stale initData |
| H3 | Opening a list deletes its queued offline changes | The mount flush runs before the JWT exists, finds no executor and dequeues everything |
| H4 | An older change lands after a newer one | The queue has no ordering between the immediate send and the flush, or between retries |
| H5 | Acting on a just-added item drops the action | It goes out with the `temp-` id (400). The temp-to-real map lives for one flush only |
| H6 | Undo of a delete is undone later | The restore bypasses the queue, so a queued or in-flight delete lands after it |
| H7 | Refresh and realtime overwrite unconfirmed changes (the owner's "done does nothing") | `refreshItems` replaces every synced row with the server snapshot; realtime UPDATE merges blindly |
| H8 | Re-add from suggestions creates a second row on replay or from two devices | Recycle is not idempotent |
| H9 | An item shows twice after adding text the server normalizes | The realtime INSERT is matched on raw text; the create response adds the row again |
| H10 | A failed first load never recovers | The page loads only on `isReady`, which is set even when no token was obtained |
| H11 | Clear completed / Unmark all hit rows the user never saw | They act on every matching row on the server |
| H12 | A collaborator's change during a brief socket drop never shows | supabase-js rejoins by itself and the app never catches up |
| H13 | Remove duplicates deletes the active copy | It keeps the highest position, not the active row |
| H14 | Typed adds create done + active duplicates | Only the suggestion tap recycles (decision 1) |
| H15 | Changes past 100 queued, or 24 h old, vanish silently; a list not reopened never syncs | Cap and expiry drop with no message; only the open list page flushes |
| H16 | Home Undo of archive/delete can be undone later | The Undo is not ordered after the original request |
| H17 | A dropped change keeps showing until the next refresh | Nothing resyncs the row after a 4xx drop |
| H18 | Reconnect claims success while the screen is stale | A failed resubscribe skips the refresh, and a failed refresh is not reported |
| H19 | Offline ticks get the sync time, not the tap time | The server stamps `now()` |
| H21 | Single-list auto-open fires on every refetch; a resume on a bad network shows the full error screen | Auto-open and the error state run on every fetch |
| H22 | An open list misses type/icon/color changes; a deleted or unshared list is a Retry dead end; grocery card counts differ from the list | Realtime applies only the name; 403/404 shows Retry; the count function predates skip and recurring |
| H23 | Each reconnect can leave two live channels; the provider leaks its socket on unmount | Channel and client lifecycle |

Out of scope:
- **H20, reorder ties:** prod has no position collisions, and the fix needs a locking RPC.
- **The duplicate badge:** it still counts a completed copy.

## Design

### 1. One session per app launch (H1, H2, H10, H23)

- **One provider:** `TelegramProvider` moves out of the pages into a route-group layout `app/(app)/layout.tsx` that wraps `/`, `/list/[id]` and `/invite/[token]`. The page files move into `app/(app)/`, and URLs don't change. `/login` and `/login/callback` stay outside the group, so they never run the Telegram bootstrap. The JWT, userId and user now survive navigation.
- **Mini App reload:** the Mini App JWT is kept in `sessionStorage` (key `tg_auth_token`). A Telegram "Reload page", which reuses the launch initData, takes the bearer path instead of the expired initData. The web app keeps its `localStorage` token as today.
- **Typed token result:** `fetchToken` returns `{ kind: "ok", token } | { kind: "unauthorized" } | { kind: "transient" }`.
  - The JWT is cleared, and the web token removed with a redirect to `/login`, only after `unauthorized` on the bearer path.
  - The initData fallback runs only when initData is younger than 5 minutes (`auth_date`). Otherwise the state is `auth_failed`, with the existing "Session expired" banner.
  - A transient failure keeps the JWT and retries with the existing backoff.
- **Reconnect does only what is needed.** On focus, visibilitychange, online and the 45-minute timer:
  - **Token:** refresh it only when it is older than 24 hours (JWTs live 7 days). On a new token, call `client.realtime.setAuth(token)` on the existing client; the browser client is realtime-only.
  - **Realtime client:** recreate it only when its socket is not connected.
  - **Every reconnect:** flush, rejoin channels only if they are not joined, and refresh.
  - **Effect:** a tap in a healthy session no longer tears down live sync. That removes the trigger of the owner's symptom.
- **Bootstrap failure:** a failed bootstrap token hands over to the reconnect retry, instead of reporting `idle` with no token. Pages load when a JWT exists (keyed on `jwt`, not only `isReady`). When there is no JWT after the retries, the page leaves its placeholders for its error state, and `OfflineIndicator` shows there too.
- **Cleanup:** the provider removes its channels and disconnects its socket on unmount. A rejoin never leaves a second live channel.

### 2. The queue never throws work away (H3, H15, H17)

The queue moves out of the React hook into a module-level engine, `src/sync/engine.ts`. There is one engine per list id, shared by every hook instance and the provider. `useMutationQueue` becomes a thin adapter with the same `addMutation` / `flushQueue` surface.
- **No JWT:** the flush leaves every entry untouched and returns. Nothing is sent with a null JWT.
- **401:** stops the flush, keeps the entry, and asks the provider for a reconnect.
- **Unknown type:** an entry is dropped only when it has no executor for its type, with a log and the "Failed to sync change" toast.
- **Cap and expiry:** the cap rises from 100 to 500. Any eviction or 24-hour expiry is reported through the existing `onMutationError` path (toast), never silently.
- **When replay runs:** once auth is ready, the provider flushes every `mutation_queue:*` list, so a list the user doesn't reopen still syncs. The list page also flushes on mount once a JWT exists. The hook's mount flush, which runs before auth, is removed.
- **After a drop:** a dropped (4xx) change triggers a list refresh, so the row shows the server's truth.

### 3. One ordered path for every change (H4, H5, H6, H16)

- **One executor per change:** every queued change runs through `executor-factory`, online and on replay. The inline `execute` closures in `useItemHandlers` and `useListDragDrop` are removed. UI follow-ups that ran inside them, such as swapping a created item's temp id, move to per-type success handlers in the page. This removes the replay-parity gotcha: there is one request builder per type.
- **Per-item chains:** each change has a key, its item id, and changes with the same key run strictly in order. A new change waits for the previous one with its key, whether it is in flight or queued for retry. A retry keeps its place. List-wide changes (reorder, restore all) are barriers: they wait for every earlier change in the list, and later changes wait for them.
- **Temp ids:** a change on a `temp-` item waits behind that item's create. When the create returns, the engine:
  - records temp → real in a persisted map,
  - rewrites stored payloads (`itemId`, ids inside `orderedIds`),
  - aliases the two chain keys, so a change made with the real id still waits behind the temp chain.
- **Undo of an item delete, and of Remove duplicates:** it is a queued `restore` change (PATCH `deleted_at: null`), so it lands after the delete. `restoreItemsOnServer` keeps its job for bulk undos that are not queued, following call 4A.
- **Home Undo of archive or delete:** it waits for the original request to settle before sending.

### 4. The screen merges instead of overwriting (H7, H9, H12, H18)

- **Pending fields:** the engine exposes `pendingFields(itemId): Set<string>`, the item fields touched by queued or in-flight changes. A fixed map from change type to fields drives it:
  - toggle → `completed`, `completed_at`
  - edit → `text`
  - skip → `skipped_at`
  - order → `ordered_at`
  - set category → `category_id`, `category_locked`
  - recurring → `recurring`
  - reorder → `position`
  - delete / restore → presence
- **Refresh and realtime UPDATE** build each row as the server row overlaid with the local values of its pending fields. A collaborator's change to another field still shows, and the user's unconfirmed change is never undone. A row with a pending delete is not brought back.
- **Duplicate rows:** the optimistic text goes through the same normalization the server uses, and a create response whose real id is already on screen drops the temp row. No duplicate row.
- **Catch-up:** when a channel reports `SUBSCRIBED` after `CHANNEL_ERROR`, `TIMED_OUT` or `CLOSED`, the page refreshes and catches up on missed events.
- **Reconnect steps:** the refresh runs even when the rejoin failed. A failed refresh throws (`throwIfNotOk`), so the orchestrator retries and the banner doesn't claim success.

### 5. Server (H8, H11, H19, decision 4)

- **Recycle is idempotent:** if `recycleId` names an item that is already active with the same text, the route returns that item and inserts nothing. The check lives in `src/services/item-recycler.ts`, so voice gets it too.
- **Bulk scope:** Clear completed and Unmark all send the ids the screen showed, `itemIds` (uuid, max 500), the way Restore all does. The routes act only on those ids that still match.
- **Tap time:** toggle, skip and order send `at` (ISO, the tap time). The server uses it, clamped to the last 24 hours and never in the future, for `completed_at` / `skipped_at` / `ordered_at`.
- **Counts:** a migration updates `get_list_item_counts`. Active leaves out skipped items, and completed leaves out parked recurring items, matching the list's own sections. The migration applies on deploy.

### 6. Smaller fixes (H13, H14, H21, H22)

- **Remove duplicates** keeps the active copy, then the newest.
- **Typed add** with an exact normalized match of a completed item recycles it (decision 1). This applies to a single typed item and to each item of a comma add.
- **Home:** auto-open of a single list runs only at launch. A reconnect refresh is silent, and clears the error screen when it succeeds.
- **List page:**
  - The type, icon and color are applied from realtime `lists` UPDATEs, not only the name.
  - A 403/404 on a list shows the existing `errors.notFound` text with only the existing `common.goHome` button, because Retry can never work there.
  - Other load errors keep `lists.loadError` with Retry, and also get `common.goHome`.

## Testing

- **Behavioral tests:** each hole gets a test through the real engine, hooks and routes, with fetch, localStorage, Supabase and timers mocked. The audit's repro scenarios are the starting set:
  - mount with a null JWT, then flush;
  - a 500 followed by a 200, then a flush;
  - a tick on a temp item;
  - an undo after a 503;
  - a reload with a temp id in storage;
  - a refresh during an in-flight toggle;
  - an echo arriving before the create response.
- **Each test bites:** with its fix removed, the test fails.
- **Parity:** `mutation-request-parity.test.ts` and `executor-factory.test.ts` are updated to the single-executor design. A new test guards that no inline `execute` closures remain.
- **Gate:** `npx vitest run && npx tsc --noEmit && npx eslint && npx next build` (never `npm run build`).
- **Reviews:** one per task, then a whole-branch review on Opus. One push at the end.
- **Manual check in prod after deploy:** Mini App deep links (bot buttons, invite `start_param`), Telegram "Reload page", and web login / logout / OAuth callback.

## Risks

- **The engine rewrite touches every change path.** It is built test-first, and the parity tests are kept.
- **Replays become live.** Fixing H3 turns on replays that silently failed before, so ordering (section 3) and recycle idempotency (section 5) ship in the same push.
- **Moving pages into a route group** changes file paths. Tests that import or read those files are updated. URLs stay the same.
- **Old queue entries:** entries persisted before this change (with temp ids or old shapes) must still replay or drop with a toast, never crash the page.
