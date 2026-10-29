# Unchecked failures: design

**Date:** 2026-10-28
**Status:** approved 2026-10-29 (the owner said "decide yourself": all six picks are A)
**Background:** this follows the silent-catch sweep (`d1ff341`). That sweep made every thrown error get logged. This one covers failures that come back as a *value* and are then ignored:

- A Supabase call returns `{ data, error }` and nobody reads `error`.
- A browser `fetch` returns a response, and nobody checks `res.ok` (the "did the server say yes" flag).
- A request is fired without waiting for it, so its failure goes nowhere.
- A route reads the request body without guarding it, so a bad body crashes the route with a 500 instead of being rejected with a 400.

An inventory found **106 such places**:
- **62 mislead the user or leave data wrong.**
- **22 heal on the next refresh.**
- **22 only lack a log line.**

## Goal

- **Honest feedback:** when something fails, the user is told, or at least never told it worked.
- **Truthful screens:** the screen matches what the server holds.
- **Logged causes:** the cause is in the logs with enough context to debug.

Success means:
- No `{ error }` is ignored.
- No `res.ok` is unchecked.
- No request is left floating, and no body read can crash a route.
- Every change in user-visible behavior is listed below and tested.

## Product calls (my picks; reply with a letter to change one)

1. **Voice: one item fails to save.** Today the bot replies "added X" even when saving X failed.
   - **A (pick):** a new line for that item, while the other items keep their normal receipt. The text is "Couldn't update 'X' in List. Please try again." Hebrew and Russian follow the existing "couldn't find" line.
   - **B:** reuse "Sorry, I couldn't understand that". Rejected, because it isn't true: the bot did understand.
2. **Invite: the request is saved, but the bot can't message the owner** (for example, the owner blocked the bot).
   - **A (pick):** keep today's "Waiting for approval" and log a warning. The request still shows in the owner's Share screen.
   - **B:** roll the request back and show the invitee an error. Against an owner who blocked the bot, this can never succeed.
3. **Invite page: the server fails or the network drops.** Today the invitee sees the final "Invite not valid" screen, which is false.
   - **A (pick):** "Something went wrong. Please try again." with Retry and Go home. These are existing strings.
   - A genuinely dead link still shows "Invite not valid".
4. **Clear completed / Unmark all fail, including offline.** Today they look done, and the items quietly come back later.
   - **A (pick):** put the items back right away and show "Failed to sync change".
   - **B:** queue them for offline replay like single-item changes. That's a new feature with two new offline mutation types; it could be its own task.
5. **Home screen: one of the reads behind the list of lists fails.** Today it shows a partial screen: lists missing, every count at 0, or archived lists back in Active.
   - **A (pick):** show the existing "Couldn't load your lists" screen with Retry. Only the small "shared" badge stays best-effort.
   - **B:** keep showing whatever loaded.
6. **Saving the language fails.** A: keep the chosen language on screen and show "Something went wrong. Please try again." (pick).

## How it's built: one code path per kind of failure

- **`readJsonBody(request, tag)`** in `src/lib/api-validation.ts` reads the body. A bad body logs its error type only (never the body) and returns `null`. `parseBody` then turns that into a 400.
  - All 13 body reads use it, including the 4 that currently inline the same pattern.
- **`dbError(tag, what, error, ctx)`** in a new `src/lib/api-errors.ts` logs the failure and returns a 500 with a short message.
  - Every route database call destructures `error` and returns `dbError(...)` before its not-found branch.
  - The existing 500s that log nothing switch to it.
- **Missing rows versus failed reads.** Where "no row" is a normal answer, `.single()` becomes `.maybeSingle()`.
  - `.single()` reports "no row" as an error. `.maybeSingle()` returns `null` instead.
  - So `error` then always means a real failure, and a missing row keeps its 403/404.
- **Shared server helpers log where they fail, then throw.** This covers:
  - `verifyListPermission`
  - `resolveListRecipients`
  - the item recycler

  Their return shapes don't change, so no caller changes. A database failure becomes a 500, which the offline queue retries. Today it becomes a 403 or a "nobody to notify", which the queue drops or which misleads.
- **`throwIfNotOk(res, verb)`** in a new `src/utils/http.ts` is for browser requests. It throws `"<Verb> failed: <status>"`, the format the offline queue already parses.
  - It is not used inside the offline-replay executors, so the replay-parity rule is untouched.
- **`restoreItemsOnServer(...)`** in a new `src/utils/item-restore.ts` sends the item PATCHes for an Undo, checks each one, and returns the ids that failed.
- **Realtime cleanup helpers** in a new `src/lib/realtime-cleanup.ts` remove a channel and log when Supabase answers "error" or "timed out".
- **Bot command handlers.** The webhook waits for `/start` and `/help` to finish before its background step ends, through an in-flight set in `logFailures` (`src/services/bot.ts`).
  - Today Vercel can freeze the function mid-handler. The library runs these handlers without waiting; I checked this in its source.

## Changes by area

### Request bodies (13 places)

A malformed body now gets a 400 with a tagged log, where today it's an untagged 500.
- **Normal use:** nothing changes, since the app always sends valid JSON.
- **Bad queued changes:** a permanently bad queued change is dropped once with the existing "Failed to sync change". Today it retries for 24 hours.
- **`POST /api/share`** gets a small schema in place of its hand-rolled check.

### Server reads and writes (36 places)

- **`GET /api/lists`:** if any core read fails, the route returns a 500, and the home page shows its Retry screen (call 5).
- **Caps fail closed:** if the count behind the 50-list cap or the 10-pending-request cap can't be read, the create is refused.
- **Owner checks** for edit, delete and undo-delete return a 500 on a database error. They return a 403 only when the row is really missing or the user isn't the owner.
- **Adding items:** the duplicate check and the position reads return a 500 before anything is inserted, so a new item can no longer land at position 1 because a read failed.
- **Remind and Ready:** if the sender's name can't be read, nothing is sent. Today the message goes out signed "Someone". The user sees the existing "couldn't send" toast.
- **User routes:**
  - The routes tell a failed read apart from a missing user.
  - `POST /api/user` no longer falls through to an insert when its lookup failed.
- **Share settings:** a failed read returns a 500 instead of an empty list.

### Item changes are never silently lost (2 places)

Today a database error on an item update returns a 404, so the offline queue drops the change. That covers toggle, edit, skip, order, restore and category move.
- **After the fix:** a database error returns a 500 and the queue retries the change. Only a truly missing item returns 404.
- **Category reset:** a failed category reset after a text edit returns a 500, so the retry redoes it.

### Shared helpers (14 places)

- **Permission errors:** a database error during a permission check is a 500, not "Access denied".
- **Nudges:** a nudge whose recipient lookup fails says "couldn't send", not "no one to notify".
- **Recycler:** failures never create a duplicate item. In a batch add, the affected item is skipped and logged, the same rule the batch already uses for an insert error.

### Voice (19 places)

- **Whole-message failures:** if the user, lists, collaborators or archived state can't be read, or the audio download from Telegram fails, the bot sends the existing "Sorry, I couldn't understand that" and stops.
  - Working from a partial set of lists could add items to the wrong list.
  - A failed lookup no longer tells a registered user to "open the app first".
- **The download:** checked before Gemini is called, and the file URL is never logged, because it contains the bot token.
- **Per-item failures:** each failure gets the new line (call 1), and the rest of the receipt stays accurate. The bot never claims an add, remove or recycle that didn't happen.
- **Empty lists:** a list where nothing changed gets no empty "Updated List:" message.

### Join requests (16 places)

- **Invite link:**
  - A database error returns a 500, not "invalid link" (404) or "list deleted" (410).
  - The invite token is never logged.
  - An approved member can no longer hit a duplicate-row crash.
  - A declined user reusing a link is no longer shown "waiting" when the owner was never asked.
- **Approve and Decline in the bot:**
  - If the update fails, the owner gets "Something went wrong. Please try again." and the buttons stay.
  - The requester is not told "approved" for access that was never granted.
- **Cancel on the invite page:** the page goes home only after the server confirms. On failure the waiting screen stays, with the error under the Cancel button.
- **`/start`:** a failed user save is logged, and the welcome is still sent.

### Webhook (2 places)

`/start` and `/help` finish reliably on a cold function (see "Bot command handlers" above).

### Browser background saves (18 places)

Each failed save shows a short toast and puts the screen back to the server's truth:
- **Home, delete a list:** on failure the card returns, the undo toast clears, and a new "Couldn't delete the list" toast shows.
- **Home, Undo of a delete or archive:** on failure it shows the generic error and refreshes quietly.
- **Home, edit sheet:** on failure it shows the generic error and stays open with the user's input.
- **Home, create a list:** the English `alert()` becomes the generic error toast.
- **List page, type switch:** the type reverts on failure.
- **List page, Undo of a delete, duplicates, clear or unmark:**
  - Only the items that failed to restore go back to where they were.
  - One "Failed to sync change" toast shows.
- **List page, clear completed and unmark all:** these revert and show the toast (call 4).
- **Language:** see call 6.
- **Share dialog:**
  - **Loading collaborators:** on failure the dialog shows the generic error inline.
  - **Generating a link:** on failure the dialog shows the generic error inline.

### Browser reads and cleanup (15 places)

- **Opening a list when its details can't be loaded:** the app shows the existing Retry screen. Today it shows a list with no header, and a grocery list opens as a regular one.
- **Everything else only gains a log line:**
  - list refreshes
  - category loads
  - token fetches
  - user registration
  - realtime cleanup

## New strings

| Key | en | he | ru |
|---|---|---|---|
| `voice.itemFailed` | Couldn't update '{item}' in {listName}. Please try again. | לא הצלחתי לעדכן את '{item}' ב{listName}. נסה שוב. | Не получилось обновить '{item}' в {listName}. Попробуйте ещё раз. |
| `lists.deleteFailed` | Couldn't delete the list | לא הצלחנו למחוק את הרשימה | Не удалось удалить список |

Everything else reuses existing keys:
- `errors.generic`
- `items.syncError`
- `items.signalError`
- `common.retry`
- `common.goHome`
- `lists.loadError`

## Out of scope

- **Web logout on a server hiccup:** a temporary failure of the token endpoint still logs a web user out. Telling that apart from a real expiry changes the login flow, so this pass only logs it.
- **Failed refresh during reconnect:** it still counts as a successful step. Changing that touches the retry counters and banner for every caller, so this pass only logs it.
- **Offline replay for bulk actions:** clear completed and unmark all aren't replayed offline (call 4, option B).
- **Bot strings:** the remaining hard-coded English strings in the bot are a separate cleanup.
- **Sentry:** the repo has none.

## Risks

- **More Retry screens:** during flaky database periods users see the Retry screen more often. That replaces a wrong screen with an honest one.
- **Retries instead of drops:** about 15 routes answer a database error with a 500 instead of a 403. Queued changes then retry for up to 24 hours instead of being dropped, which is intended.
- **Visible reverts:** clear completed, unmark all and Undo now visibly revert when they fail, including offline. The merge-back must not duplicate items that realtime already brought back.
- **Toast stacking:** toasts must sit above the sheets they're raised from, the home edit sheet and the list settings sheet. I check this visually.
- **Stale test mocks:** many existing test mocks return `{ data }` without `error`, or mock `.single()`. They get updated, and the new checks are never loosened to make them pass.

## Testing

- **Behavioral tests:**
  - Mocked Supabase chains that return `{ data: null, error }`, and mocked `fetch` responses with status 500 or a rejection.
  - Real handlers and hooks, with no live services.
- **Each new check:** a test proves it, and I delete the check once to see the test fail.
- **Guards:**
  - The no-silent-catches guard stays green.
  - New `.catch` handlers log the error object.
- **Gate:**
  - `npx vitest run`
  - `npx tsc --noEmit`
  - `npx eslint`
  - `npx next build` (never `npm run build`)
- **Review:** an independent review of each task, then a final whole-branch review on Opus.
