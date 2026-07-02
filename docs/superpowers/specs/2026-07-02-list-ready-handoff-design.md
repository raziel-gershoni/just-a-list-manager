# "Ready for you" list hand-off signal — Design

**Date:** 2026-07-02
**Status:** Approved

## Problem

A shared grocery list is a two-person ping-pong: one person curates it during the week, the other acts on it (shops). The app already has one direction — a paper-plane button in the list header that sends *"{sender} is reminding you to update {list}"* to everyone with access. There is no signal for the reverse: *"I'm done — the list is ready, it's your turn."* Without it, the finishing partner has to switch to Telegram and type a message manually.

## Solution

Add a symmetric "Ready for you" signal, and consolidate both directions behind one entry point.

The existing paper-plane button (currently an instant one-tap remind) becomes a **menu opener**: tapping it opens a small bottom sheet with two labeled actions —

- **🔔 Remind to update** → the existing `handleRemind` (now finally labeled)
- **✅ Ready for you** → the new `handleReady`

### Scope gate

The whole paper-plane + sheet appears **only on shared grocery lists** (`isShared && listType === "grocery"`). This is a deliberate behavior change: the remind action, which today shows on *all* shared lists, is **removed from non-grocery shared lists**. The signaling workflow is grocery-centric, so it lives only there.

### Recipients

Identical to the existing remind: broadcast to the **list owner + all approved collaborators, except the sender**, each message rendered in the recipient's own language, skipping anyone without a linked `telegram_id`. There is no 1:1 "partner" concept in the data model; in a two-person household this broadcast *is* "my partner."

### The message (`bot.listReady`)

Short & casual, sent with the same "Open List" inline button as the remind message:

- **en:** `"{listName}" is ready! ✅ Over to you — {senderName}.`
- **he:** `»{listName}« מוכנה! ✅ תורך — {senderName}.`
- **ru:** `«{listName}» готов! ✅ Ваша очередь — {senderName}.`

(A neutral ✅ replaces a grocery-specific 🛒 so the copy is safe if the gate is ever relaxed to other list types.)

## Architecture

### Backend

**New route** `app/api/lists/[id]/ready/route.ts` — a near-clone of `remind/route.ts`:
- `verifyUserAuth(request, apiRateLimiter, "list-ready")`, `verifyListPermission(auth.userId, listId, "view")` (any collaborator can signal), shared 60/min rate limiter.
- Resolves recipients, loops sending via a new `sendListReady(...)`, returns `{ sent }`.

**New shared helper** `src/lib/list-notify.ts` — extracts the recipient logic that `remind` currently inlines (~40 lines), so both routes share one implementation and it becomes unit-testable:
- `buildRecipientList(candidates: (JoinedUser|null)[], senderUserId): Recipient[]` — **pure**: drops the sender, drops null `telegram_id`, **dedupes by user id**, maps `language` with an `"en"` fallback.
- `resolveListRecipients(supabase, listId, senderUserId): Promise<Recipient[]>` — runs the owner + approved-collaborator queries, normalizes the Supabase join shape (owner join → single object, collaborator join → array), and calls `buildRecipientList`.
- `remind/route.ts` is refactored to call `resolveListRecipients` (no behavior change).

**New bot helper** `sendListReady(...)` in `src/services/bot.ts` — mirrors `sendListReminder`, uses `bot.listReady` + the same Open-List button.

### Frontend

**`components/list/SignalSheet.tsx`** (new) — a bottom sheet mirroring `ReminderSheet`'s container (`fixed inset-0 z-50 flex items-end … bg-black/40 backdrop-blur-sm backdrop-enter` → `bg-tg-bg … rounded-t-3xl sheet-enter`, grab handle). Two full-width tappable rows (icon + label + one-line hint): `Bell` / "Remind to update", `CircleCheck` / "Ready for you". Each fires its callback then closes. Renders `null` when `!isOpen`.

**`components/list/ListHeader.tsx`** — the `Send` button is gated on `isShared && listType === "grocery"` and its `onRemind` prop is renamed **`onSignal`** (opens the sheet instead of sending directly). Page-owns-modals pattern, consistent with `onShare`/`onSettings`.

**`app/list/[id]/page.tsx`** — add `showSignals` state; pass `onSignal={() => setShowSignals(true)}`; render `<SignalSheet isOpen={showSignals} onClose={…} onRemind={handleRemind} onReady={handleReady} />`. Wire `handleReady` (and `setErrorToast`) through `useItemHandlers`.

**`src/hooks/useItemHandlers.ts`** — add `setErrorToast` to params. Extract a shared `sendSignal(endpoint, successKey)`:
- light haptic, `POST /api/lists/[id]/{endpoint}`.
- `!res.ok` → red **error toast** (`items.signalError`), fixing the existing bug where remind shows "sent!" even on a 403/429.
- `{ sent } === 0` → info toast (`items.signalNoRecipients`, "No one to notify yet") instead of a false success.
- else → success toast (`successKey`).
- `handleRemind = () => sendSignal("remind", "items.reminderSent")`; `handleReady = () => sendSignal("ready", "items.readySent")`. Both returned from the hook.

### i18n (`messages/{en,he,ru}.json`)
- `bot.listReady` — the message (above).
- `items.readySent` — success toast for ready.
- `items.signalError` — failure toast.
- `items.signalNoRecipients` — empty-recipients toast.
- `items.signal.{title,remind,remindHint,ready,readyHint}` — sheet UI strings.

### Data flow
tap ✈ → `setShowSignals(true)` → sheet → tap "Ready for you" → `handleReady()` → `POST /api/lists/[id]/ready` → `resolveListRecipients` → `sendListReady` per recipient → `{ sent }` → toast (success / empty / error).

## Not doing
- No schema/migration (zero new columns).
- No mutation-queue / executor-factory change (these are fire-and-forget POSTs, not optimistic item mutations — same as the existing remind).
- No 1:1 partner targeting (broadcast, mirroring remind).

## Testing
`__tests__/unit/list-notify.test.ts` — `buildRecipientList`: excludes sender, drops null `telegram_id`, dedupes owner/collaborator overlap by user id, applies `"en"` language fallback, tolerates `null` entries. (Repo convention: pure-function vitest only, no DOM.)
