# "Ready for you" List Hand-off Signal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a grocery-only "Ready for you" hand-off signal, entered via a bottom sheet that also hosts the existing "remind to update" action.

**Architecture:** New `POST /api/lists/[id]/ready` route clones `remind`, both sharing an extracted `resolveListRecipients` helper. A new `SignalSheet` bottom sheet (page-owned modal) replaces the header button's direct call. `useItemHandlers` gains a shared `sendSignal` with real success/empty/error toasts.

**Tech Stack:** Next.js 16 App Router, TypeScript, next-intl, Supabase, node-telegram-bot-api, vitest (pure-function tests only), lucide-react, Tailwind 4.

## Global Constraints

- Recipients = list owner + approved collaborators, **excluding sender**, skip null `telegram_id`, each in own `language` (fallback `"en"`), **dedupe by user id**.
- Message copy (verbatim), `bot.listReady`:
  - en: `"{listName}" is ready! ✅ Over to you — {senderName}.`
  - he: `»{listName}« מוכנה! ✅ תורך — {senderName}.`
  - ru: `«{listName}» готов! ✅ Ваша очередь — {senderName}.`
- Placeholders substituted via raw `.replace("{senderName}", …)` / `.replace("{listName}", …)` server-side (not next-intl), matching `sendListReminder`.
- Signal button gate: `isShared && listType === "grocery"`.
- No schema/migration. No mutation-queue/executor-factory change (fire-and-forget POST).
- Tests: pure-function vitest, files `__tests__/unit/*.test.ts`, no DOM.

---

### Task 1: Shared recipient helper (`src/lib/list-notify.ts`)

**Files:**
- Create: `src/lib/list-notify.ts`
- Test: `__tests__/unit/list-notify.test.ts`

**Interfaces:**
- Produces: `type JoinedUser = { id: string; telegram_id: number | null; language: string | null }`, `type Recipient = { telegramId: number; language: string }`, `buildRecipientList(candidates: (JoinedUser | null)[], senderUserId: string): Recipient[]`, `resolveListRecipients(supabase, listId: string, senderUserId: string): Promise<Recipient[]>`.

- [ ] **Step 1: Write the failing test** — `__tests__/unit/list-notify.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { buildRecipientList, type JoinedUser } from "@/src/lib/list-notify";

const u = (id: string, tg: number | null, lang: string | null = "en"): JoinedUser => ({ id, telegram_id: tg, language: lang });

describe("buildRecipientList", () => {
  it("excludes the sender", () => {
    const out = buildRecipientList([u("owner", 1), u("me", 2)], "me");
    expect(out).toEqual([{ telegramId: 1, language: "en" }]);
  });
  it("drops null telegram_id and null entries", () => {
    const out = buildRecipientList([u("a", null), null, u("b", 3)], "me");
    expect(out).toEqual([{ telegramId: 3, language: "en" }]);
  });
  it("dedupes by user id (owner also a collaborator)", () => {
    const out = buildRecipientList([u("owner", 1), u("owner", 1)], "me");
    expect(out).toEqual([{ telegramId: 1, language: "en" }]);
  });
  it("falls back to en when language is null", () => {
    const out = buildRecipientList([u("a", 5, null)], "me");
    expect(out).toEqual([{ telegramId: 5, language: "en" }]);
  });
  it("preserves a non-null language", () => {
    const out = buildRecipientList([u("a", 5, "he")], "me");
    expect(out).toEqual([{ telegramId: 5, language: "he" }]);
  });
});
```

- [ ] **Step 2: Run test, verify it fails** — `npx vitest run __tests__/unit/list-notify.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/list-notify.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

export type JoinedUser = { id: string; telegram_id: number | null; language: string | null };
export type Recipient = { telegramId: number; language: string };

/**
 * Pure: turn a flat candidate list into send targets.
 * Drops the sender, null entries, and users without a telegram_id; dedupes by user id.
 */
export function buildRecipientList(
  candidates: (JoinedUser | null)[],
  senderUserId: string
): Recipient[] {
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const u of candidates) {
    if (!u || u.id === senderUserId || !u.telegram_id) continue;
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    out.push({ telegramId: u.telegram_id, language: u.language || "en" });
  }
  return out;
}

/** Fetch owner + approved collaborators for a list and build the recipient list (sender excluded). */
export async function resolveListRecipients(
  supabase: SupabaseClient,
  listId: string,
  senderUserId: string
): Promise<Recipient[]> {
  const { data: listWithOwner } = await supabase
    .from("lists")
    .select("owner_id, users!lists_owner_id_fkey(id, telegram_id, language)")
    .eq("id", listId)
    .single();

  const { data: collaborators } = await supabase
    .from("collaborators")
    .select("user_id, users!collaborators_user_id_fkey(id, telegram_id, language)")
    .eq("list_id", listId)
    .eq("status", "approved");

  const owner = (listWithOwner as { users: JoinedUser | null } | null)?.users ?? null;
  const collabUsers = (collaborators ?? []).map(
    (c) => (c as unknown as { users: JoinedUser[] | null }).users?.[0] ?? null
  );

  return buildRecipientList([owner, ...collabUsers], senderUserId);
}
```

- [ ] **Step 4: Run test, verify it passes** — `npx vitest run __tests__/unit/list-notify.test.ts` → PASS (5 tests).

- [ ] **Step 5: Commit** — `git add src/lib/list-notify.ts __tests__/unit/list-notify.test.ts && git commit -m "Add shared list-recipient resolver + unit test"`

---

### Task 2: Refactor `remind` route to use the helper

**Files:**
- Modify: `app/api/lists/[id]/remind/route.ts:44-101` (replace inline recipient block + keep send loop)

**Interfaces:**
- Consumes: `resolveListRecipients` from Task 1.

- [ ] **Step 1: Replace lines 44-84 (the `Get all users with access …` block through the collaborator loop) with:**

```ts
  const recipients = await resolveListRecipients(supabase, listId, auth.userId);
```

and add the import at top: `import { resolveListRecipients } from "@/src/lib/list-notify";`. The send loop (lines 86-101) and everything else stay unchanged.

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` → clean.

- [ ] **Step 3: Commit** — `git add app/api/lists/[id]/remind/route.ts && git commit -m "Refactor remind route onto shared recipient resolver"`

---

### Task 3: `sendListReady` bot helper + `bot.listReady` message

**Files:**
- Modify: `src/services/bot.ts` (add `sendListReady` after `sendListReminder`, ~line 220)
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json` (add `bot.listReady`)

- [ ] **Step 1: Add i18n `bot.listReady`** next to `bot.listReminder` in each file:
  - en: `"listReady": "\"{listName}\" is ready! ✅ Over to you — {senderName}.",`
  - he: `"listReady": "»{listName}« מוכנה! ✅ תורך — {senderName}.",`
  - ru: `"listReady": "«{listName}» готов! ✅ Ваша очередь — {senderName}.",`

- [ ] **Step 2: Add `sendListReady` to `src/services/bot.ts`** (clone of `sendListReminder`):

```ts
export async function sendListReady(
  telegramId: number,
  language: string,
  senderName: string,
  listName: string,
  listId: string
) {
  try {
    await bot.sendMessage(
      telegramId,
      getMsg(language, "bot.listReady")
        .replace("{senderName}", senderName)
        .replace("{listName}", listName),
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: getMsg(language, "bot.openList"),
                web_app: { url: `${getAppUrl()}/list/${listId}` },
              },
            ],
          ],
        },
      }
    );
  } catch (error) {
    console.error("[Bot] Failed to send list ready:", error);
    throw error;
  }
}
```

- [ ] **Step 3: Typecheck** — `npx tsc --noEmit` → clean.

- [ ] **Step 4: Commit** — `git add src/services/bot.ts messages/ && git commit -m "Add sendListReady bot helper + listReady message"`

---

### Task 4: `POST /api/lists/[id]/ready` route

**Files:**
- Create: `app/api/lists/[id]/ready/route.ts`

**Interfaces:**
- Consumes: `resolveListRecipients` (Task 1), `sendListReady` (Task 3).

- [ ] **Step 1: Create `app/api/lists/[id]/ready/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";
import { sendListReady } from "@/src/services/bot";
import { resolveListRecipients } from "@/src/lib/list-notify";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: listId } = await params;
  const auth = await verifyUserAuth(request, apiRateLimiter, "list-ready");
  if (!auth.success) return auth.response;

  const perm = await verifyListPermission(auth.userId, listId, "view");
  if (!perm.allowed) {
    return NextResponse.json(
      { error: "You don't have permission to view this list" },
      { status: 403 }
    );
  }

  const supabase = createServerClient();

  const { data: list } = await supabase
    .from("lists")
    .select("name")
    .eq("id", listId)
    .single();

  if (!list) {
    return NextResponse.json({ error: "List not found" }, { status: 404 });
  }

  const { data: sender } = await supabase
    .from("users")
    .select("name")
    .eq("id", auth.userId)
    .single();

  const senderName = sender?.name || "Someone";

  const recipients = await resolveListRecipients(supabase, listId, auth.userId);

  let sent = 0;
  for (const recipient of recipients) {
    try {
      await sendListReady(
        recipient.telegramId,
        recipient.language,
        senderName,
        list.name,
        listId
      );
      sent++;
    } catch (e) {
      console.error("[Ready] Failed to send to", recipient.telegramId, e);
    }
  }

  return NextResponse.json({ sent });
}
```

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` → clean.

- [ ] **Step 3: Commit** — `git add app/api/lists/[id]/ready/route.ts && git commit -m "Add POST /api/lists/[id]/ready route"`

---

### Task 5: i18n UI strings (toasts + sheet)

**Files:**
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json` (add to `items`)

- [ ] **Step 1: Add keys to the `items` object in each locale.**

en:
```json
"readySent": "They know it's ready!",
"signalError": "Couldn't send — try again.",
"signalNoRecipients": "No one to notify yet.",
"signal": {
  "title": "Notify partner",
  "remind": "Remind to update",
  "remindHint": "Ask them to go over the list",
  "ready": "Ready for you",
  "readyHint": "Tell them the list is done"
},
```
he:
```json
"readySent": "הם יודעים שהרשימה מוכנה!",
"signalError": "השליחה נכשלה — נסה שוב.",
"signalNoRecipients": "אין עדיין את מי לעדכן.",
"signal": {
  "title": "עדכון שותף",
  "remind": "תזכורת לעדכן",
  "remindHint": "בקש לעבור על הרשימה",
  "ready": "מוכן בשבילך",
  "readyHint": "עדכן שהרשימה מוכנה"
},
```
ru:
```json
"readySent": "Они знают, что список готов!",
"signalError": "Не удалось отправить — попробуйте снова.",
"signalNoRecipients": "Пока некого уведомлять.",
"signal": {
  "title": "Уведомить партнёра",
  "remind": "Напомнить обновить",
  "remindHint": "Попросить проверить список",
  "ready": "Готово для вас",
  "readyHint": "Сообщить, что список готов"
},
```

- [ ] **Step 2: Validate JSON** — `node -e "['en','he','ru'].forEach(l=>require('./messages/'+l+'.json'))"` → no error.

- [ ] **Step 3: Commit** — `git add messages/ && git commit -m "Add signal-sheet + hand-off toast i18n strings"`

---

### Task 6: `SignalSheet` component

**Files:**
- Create: `components/list/SignalSheet.tsx`

**Interfaces:**
- Produces: `SignalSheet` props `{ isOpen: boolean; onClose: () => void; onRemind: () => void; onReady: () => void }`.

- [ ] **Step 1: Create `components/list/SignalSheet.tsx`** (mirrors ReminderSheet container):

```tsx
"use client";

import { useTranslations } from "next-intl";
import { Bell, CircleCheck, X } from "lucide-react";

interface SignalSheetProps {
  isOpen: boolean;
  onClose: () => void;
  onRemind: () => void;
  onReady: () => void;
}

export default function SignalSheet({ isOpen, onClose, onRemind, onReady }: SignalSheetProps) {
  const t = useTranslations("items.signal");
  if (!isOpen) return null;

  const fire = (fn: () => void) => {
    fn();
    onClose();
  };

  const rowBase =
    "w-full flex items-center gap-3.5 px-5 py-4 rounded-2xl bg-tg-secondary-bg active:scale-[0.99] transition-transform text-start";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm backdrop-enter"
      onClick={onClose}
    >
      <div
        className="bg-tg-bg w-full max-w-lg rounded-t-3xl pt-3 pb-6 sheet-enter"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 rounded-full bg-tg-hint/30 mx-auto mb-3" />

        <div className="flex items-center gap-2 px-5 mb-3">
          <p className="flex-1 text-sm font-medium text-tg-text">{t("title")}</p>
          <button onClick={onClose} className="p-1.5 -m-1.5 rounded-full active:bg-tg-secondary-bg shrink-0">
            <X className="w-5 h-5 text-tg-hint" />
          </button>
        </div>

        <div className="flex flex-col gap-2 px-4">
          <button onClick={() => fire(onRemind)} className={rowBase}>
            <span className="shrink-0 w-9 h-9 rounded-full bg-tg-button/10 flex items-center justify-center">
              <Bell className="w-[18px] h-[18px] text-tg-button" strokeWidth={2.25} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[15px] font-medium text-tg-text">{t("remind")}</span>
              <span className="block text-[12px] text-tg-hint truncate">{t("remindHint")}</span>
            </span>
          </button>

          <button onClick={() => fire(onReady)} className={rowBase}>
            <span className="shrink-0 w-9 h-9 rounded-full bg-emerald-500/10 flex items-center justify-center">
              <CircleCheck className="w-[18px] h-[18px] text-emerald-500" strokeWidth={2.25} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[15px] font-medium text-tg-text">{t("ready")}</span>
              <span className="block text-[12px] text-tg-hint truncate">{t("readyHint")}</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` → clean.

- [ ] **Step 3: Commit** — `git add components/list/SignalSheet.tsx && git commit -m "Add SignalSheet bottom sheet"`

---

### Task 7: `useItemHandlers` — `sendSignal` + `handleReady` + `setErrorToast`

**Files:**
- Modify: `src/hooks/useItemHandlers.ts:9-25` (params), `:36` (destructure), `:601-614` (replace handleRemind), `:710` (return)

**Interfaces:**
- Produces: `handleReady: () => Promise<void>`; existing `handleRemind` now routes through `sendSignal`.
- Consumes (from caller): new `setErrorToast: React.Dispatch<React.SetStateAction<string | null>>` param.

- [ ] **Step 1: Add param to interface** (after `setReminderToast` line in `UseItemHandlersParams`):

```ts
  setErrorToast: React.Dispatch<React.SetStateAction<string | null>>;
```

- [ ] **Step 2: Add `setErrorToast` to the destructured params** (after `setReminderToast,`).

- [ ] **Step 3: Replace the `handleRemind` block (lines 601-614) with `sendSignal` + both handlers:**

```ts
  const sendSignal = useCallback(
    async (endpoint: "remind" | "ready", successKey: string) => {
      const jwt = jwtRef.current;
      if (!jwt) return;
      const tg = getTelegramWebApp();
      tg?.HapticFeedback?.impactOccurred("light");
      try {
        const res = await fetch(`/api/lists/${listId}/${endpoint}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${jwt}` },
        });
        if (!res.ok) {
          setErrorToast(t("items.signalError"));
          setTimeout(() => setErrorToast(null), 3000);
          return;
        }
        const data = await res.json().catch(() => ({ sent: 0 }));
        setReminderToast(t(data.sent === 0 ? "items.signalNoRecipients" : successKey));
        setTimeout(() => setReminderToast(null), 2500);
      } catch (e) {
        console.error(`[List] ${endpoint} error:`, e);
        setErrorToast(t("items.signalError"));
        setTimeout(() => setErrorToast(null), 3000);
      }
    },
    [jwtRef, listId, t, setReminderToast, setErrorToast]
  );

  const handleRemind = useCallback(
    () => sendSignal("remind", "items.reminderSent"),
    [sendSignal]
  );

  const handleReady = useCallback(
    () => sendSignal("ready", "items.readySent"),
    [sendSignal]
  );
```

- [ ] **Step 4: Add `handleReady` to the return object** (line 710), after `handleRemind`.

- [ ] **Step 5: Typecheck** — `npx tsc --noEmit` → clean (page.tsx will error until Task 9 passes `setErrorToast`; that's expected — verify at Task 9).

- [ ] **Step 6: Commit** — `git add src/hooks/useItemHandlers.ts && git commit -m "Add sendSignal + handleReady with real error/empty toasts"`

---

### Task 8: `ListHeader` — grocery gate + `onSignal`

**Files:**
- Modify: `components/list/ListHeader.tsx:20` (prop), `:31` (destructure), `:65-69` (button)

- [ ] **Step 1: Rename prop** `onRemind: () => void;` → `onSignal: () => void;` (interface + destructure).

- [ ] **Step 2: Replace the button block (lines 65-69):**

```tsx
      {isShared && listType === "grocery" && (
        <button onClick={onSignal} className="p-2 rounded-full active:bg-tg-secondary-bg">
          <Send className="w-5 h-5 text-tg-hint/80" />
        </button>
      )}
```

- [ ] **Step 3: Commit** — `git add components/list/ListHeader.tsx && git commit -m "Gate signal button to grocery + rename to onSignal"`

---

### Task 9: Page wiring

**Files:**
- Modify: `app/list/[id]/page.tsx` (import, `showSignals` state, `useItemHandlers` args, `ListHeader` prop, render `SignalSheet`)

- [ ] **Step 1: Import** near the other list-component imports: `import SignalSheet from "@/components/list/SignalSheet";`

- [ ] **Step 2: Add state** after `const [showShare, setShowShare] = useState(false);`:

```tsx
  const [showSignals, setShowSignals] = useState(false);
```

- [ ] **Step 3: Pass `setErrorToast` into `useItemHandlers`** (add to the args object) and destructure `handleReady`:

```tsx
  const { handleAddItem, handleToggle, handleDelete, handleEditItem, handleSkip, handleOrder, handleSetRecurring, handleRestoreRecurring, handleRemoveDuplicates, handleClearCompleted, handleRemind, handleReady, handleSetReminder, handleUpdateReminder, handleCancelReminder } =
    useItemHandlers({
      listId, jwtRef, userId, items, setItems, addMutation, setUndoAction,
      setDuplicateWarning, setReminderToast, setErrorToast, listType,
      t: t as (key: string, values?: Record<string, unknown>) => string,
    });
```

(Keep the existing formatting; the only additions are `handleReady` in the destructure and `setErrorToast` in the args.)

- [ ] **Step 4: Change ListHeader prop** `onRemind={handleRemind}` → `onSignal={() => setShowSignals(true)}`.

- [ ] **Step 5: Render `SignalSheet`** next to `ShareDialog` (after it):

```tsx
      <SignalSheet
        isOpen={showSignals}
        onClose={() => setShowSignals(false)}
        onRemind={handleRemind}
        onReady={handleReady}
      />
```

- [ ] **Step 6: Full verify** — `npx tsc --noEmit` → clean; `npx vitest run` → all pass; `npm run build` → succeeds (ignore pre-existing `ENVIRONMENT_FALLBACK`).

- [ ] **Step 7: Commit** — `git add app/list/[id]/page.tsx && git commit -m "Wire SignalSheet + ready hand-off into list page"`

---

## Self-Review

- **Spec coverage:** gate (T8/T9), recipients+dedupe (T1), remind refactor (T2), message (T3), route (T4), toasts incl. error/empty fix (T5/T7), sheet (T6), UI strings (T5), no migration/queue (constraints). ✓
- **Type consistency:** `Recipient`/`JoinedUser` (T1) consumed by T2/T4; `sendSignal(endpoint, successKey)`, `handleReady` (T7) consumed by T9; `onSignal` (T8) consumed by T9; `SignalSheet` props (T6) consumed by T9. ✓
- **Placeholders:** none. ✓
