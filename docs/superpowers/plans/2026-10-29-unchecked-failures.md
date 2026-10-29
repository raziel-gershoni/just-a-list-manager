# Unchecked Failures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every failure that comes back as a value (a Supabase `{ error }`, a non-ok `fetch` response, a floating request, a bad request body) is checked, logged, and turned into honest feedback, so the screen and the bot never claim something worked when it didn't.

**Architecture:** One code path per kind of failure. Server routes use `readJsonBody` and `dbError` (new `src/lib/api-errors.ts`) and `.maybeSingle()` where zero rows is normal. Shared server helpers log and throw, so a database failure becomes a retryable 500 instead of a 403/404 the offline queue drops. Browser saves check `res.ok` through `throwIfNotOk` (new `src/utils/http.ts`), show an existing toast, and put the screen back to the server's truth.

**Tech Stack:** Next.js 16 App Router, React 19, Supabase JS v2, node-telegram-bot-api 0.66, next-intl (en/he/ru), Vitest 3, zod 4.

**Spec:** `docs/superpowers/specs/2026-10-28-unchecked-failures-design.md` (approved 2026-10-29; all six product calls are A).

## Global Constraints

- Logging: `console.error("[Tag] What failed:", ctx, err)` for real failures, `console.warn` for expected ones, always with the error object.
- Never log tokens, JWTs, initData, hashes, the bot token, invite tokens, Telegram file URLs, raw request bodies, item text or list names. IDs are fine.
- `__tests__/unit/no-silent-catches.test.ts` stays green; a `request.json()` catch logs only `describeBodyParseError(err)`.
- Use `.maybeSingle()` where zero rows is a normal answer; then `error` always means a real failure.
- The offline queue drops 4xx and retries 5xx; client error messages use the form `"<Verb> failed: <status>"`, and verbs never contain "fetch" or "network".
- `throwIfNotOk` is not used inside `src/utils/executor-factory.ts` or the inline `execute` closures; replay parity stays untouched.
- New strings, exactly:
  - `voice.itemFailed`: en "Couldn't update '{item}' in {listName}. Please try again." / he "לא הצלחתי לעדכן את '{item}' ב{listName}. נסה שוב." / ru "Не получилось обновить '{item}' в {listName}. Попробуйте ещё раз."
  - `lists.deleteFailed`: en "Couldn't delete the list" / he "לא הצלחנו למחוק את הרשימה" / ru "Не удалось удалить список"
- Everything else reuses `errors.generic`, `items.syncError`, `items.signalError`, `common.retry`, `common.goHome`, `lists.loadError`.
- No artificial timeouts. No Sentry (the repo has none).
- Tests mock Supabase, Telegram, Gemini and fetch; nothing reaches a live service. Each new check is removed once to confirm its test goes red.
- Never run `npm run build` (it migrates prod). Gate: `npx vitest run && npx tsc --noEmit && npx eslint && npx next build`.
- Commits end with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y`

## Review Focus

1. **A tap on a still-pending item** sends a `temp-…` id. Expect the same 4xx drop as today, never a 24-hour retry (ruling R1; the test lives in Task 4).
2. **A realtime event arriving while clear completed, unmark all or Undo is being reverted.** Expect no duplicate rows after the merge-back. Task 7a adds a test: the reverted items are put back, then a realtime INSERT/UPDATE for one of the same ids arrives, and the list holds each id once.
3. **A replayed queued create after the idempotency lookup failed.** Expect a 500 with no insert, so the replay inserts exactly once. Task 3b's items POST test asserts that no insert call was made when the lookup errored.
4. **A non-uuid list id from a deep link.** Expect the same 403 as today, not a Retry loop (ruling R2; the test lives in Task 2a).
5. **The invite page's Retry and Cancel wiring.** There is no DOM test environment, so Task 6c tests the request helpers. The final review reads the page wiring line by line: Retry re-runs accept, a failed cancel stays on "waiting", and the inline error clears on the next tap.

## Shared interfaces

```ts
// src/lib/api-validation.ts (Task 1)
export async function readJsonBody(request: Request, tag: string): Promise<unknown>;
// src/lib/api-errors.ts (Task 1)
export function dbError(tag: string, what: string, error: unknown, ctx?: Record<string, unknown>): NextResponse;
// src/utils/http.ts (Task 7)
export function throwIfNotOk(res: Response, verb: string): void;
// src/services/bot.ts (Task 6)
export function waitForBotHandlers(): Promise<void>;
```

Tasks run in order on one tree. Several files are edited by more than one task (`app/api/lists/[id]/items/route.ts` by Tasks 1-4); each task re-reads the file as the earlier tasks left it.

## Controller rulings (amend the task sections below; they win over the task text)

- **R1, temp ids stay a dropped 4xx (Task 4).** A pending item still carries a `temp-…` id. PostgREST rejects it against the uuid column with 22P02. Today that is a 404 the queue drops; after `dbError` it would be a 500 retried for 24 hours that can never succeed. So `updateItemSchema.itemId` becomes `z.string().uuid()` (`src/schemas/items.ts`), giving a 400 before any database call. The items DELETE route gets the same check on its item id, returning 400 `{ error: "Invalid item id" }` with a `console.warn` naming listId only. Test: a PATCH and a DELETE with `itemId: "temp-1-0.5"` answer 4xx and make no Supabase call.
- **R2, garbage list ids stay a 403 (Task 2a).** `verifyListPermission` returns `{ allowed: false, role: null }` without a database call when `listId` is not a uuid (use `z.string().uuid().safeParse`), so a deep link to `/list/garbage` keeps today's answer instead of a 500 Retry loop. Test: a non-uuid listId makes no Supabase call and is not allowed.
- **R3, ready/remind sender and list reads belong to Task 3b.** Task 2 does not touch them. Task 3b's "If T2 has already added a sender-read check" paragraph is void.
- **R4, test-helper edits have one owner each.** Task 2b adds `.ilike` to `__tests__/helpers/fake-supabase.ts`; Task 5 skips that sub-step and leaves the file out of its `git add`. Task 6b adds `upsert` and `count?`; no earlier task adds them. Task 3b adds `import { dbError }` to the items route; Task 4 does not add it again.
- **R5, the 50-list cap keeps its reason (Task 7b).** Converting the create `alert()` to `errors.generic` would hide why the create failed. The cap 400 in `app/api/lists/route.ts` gains `code: "maxLists"` in its JSON body. On a 400 with that code the home page shows the existing `lists.maxLists` key; every other failure shows `errors.generic`. Test both in Task 7b.
- **R6, a message-only toast never blocks the sheet buttons (Task 7).** Toasts that move to `z-[60]` get `pointer-events-none` when they have no action button (the error toasts). A toast with an Undo button keeps pointer events. After Task 8, the controller checks the toasts visually above the home edit/create sheets and the list settings sheet.
- **R7, no push before every task is in.** Task 2 makes voice recycler failures abort the whole message until Task 5 lands. Work is pushed once, after the final review and gate.
- **R8, kept as the planners proposed:** 429 counts as "try again" on the invite page; the items PATCH 404 body becomes "Item not found" with a warn naming listId and itemId; voice uses a local `dbFailure` helper that logs only the PostgREST code and message; log levels for self-healing reads are `console.warn`.

## Final steps (after Task 8, controller)

1. Whole-branch review on Opus (correctness + security lens), fix every valid finding, scoped re-review.
2. Visual check of the toasts over the sheets (R6).
3. Gate: `npx vitest run && npx tsc --noEmit && npx eslint && npx next build`. Never `npm run build`.
4. Push to main, check the Vercel deploy, ping the owner.
5. Update the memory note on silent catches with the new conventions (`dbError`, `readJsonBody`, `throwIfNotOk`, `realtime-cleanup`, `.maybeSingle()` for zero rows), then delete this plan file in a follow-up commit.

---

### Task 1: Server helpers readJsonBody + dbError, and request bodies

**Files:**
- Create: `src/lib/api-errors.ts` (the `dbError` helper; no caller in this task, T3 and later consume it)
- Modify: `src/lib/api-validation.ts` (add `readJsonBody` after `describeBodyParseError`)
- Modify: `src/schemas/share.ts` (add `createInviteSchema`)
- Modify (switch to `readJsonBody`):
  - `app/api/lists/route.ts` (POST and PATCH)
  - `app/api/lists/archive/route.ts`
  - `app/api/lists/reorder/route.ts`
  - `app/api/lists/[id]/items/reorder/route.ts`
  - `app/api/lists/[id]/items/route.ts` (POST, plus the not-an-object 400, and PATCH)
  - `app/api/user/route.ts` (PATCH)
  - `app/api/share/route.ts` (POST, plus `createInviteSchema`)
  - migrate the inline pattern: `app/api/lists/[id]/categories/order/route.ts`, `app/api/lists/[id]/categories/route.ts`, `app/api/lists/[id]/categories/[categoryId]/route.ts`, `app/api/lists/[id]/items/unskip-all/route.ts`
- Test (create): `__tests__/unit/api-helpers.test.ts`, `__tests__/unit/request-body-routes.test.ts`
- Test (modify): `__tests__/unit/no-silent-catches.test.ts` (the body-parse rule now also flags an unguarded `request.json()`, and its "checker scans" sample moves from the categories route to `src/lib/api-validation.ts`, because that route no longer calls `request.json()` itself)

**Interfaces:**
- Consumes: nothing (first task).
- Produces (exact, as fixed in shared-context.md):
  - `export async function readJsonBody(request: Request, tag: string): Promise<unknown>` in `src/lib/api-validation.ts`
  - `export function dbError(tag: string, what: string, error: unknown, ctx?: Record<string, unknown>): NextResponse` in `src/lib/api-errors.ts`. Logs `console.error("[<tag>] <what> failed:", ctx, error)` (or without `ctx`), answers `500 { error: "<what> failed" }`.
  - `export const createInviteSchema = z.object({ listId: z.string().min(1), permission: z.string().optional() })` in `src/schemas/share.ts`
  - Log tags this task uses for the body reads (later tasks that add `dbError` calls in the same handlers should reuse them so one grep finds a route): `lists/POST`, `lists/PATCH`, `lists-archive`, `lists-reorder` (both already used by those routes' existing logs), `items/reorder/POST`, `items/POST`, `items/PATCH`, `user/PATCH`, `share/POST`, and the unchanged `categories/POST`, `categories/PATCH`, `categories/order/PUT`, `items/unskip-all/POST`.
  - In `items` POST the body is `unknown` now; the handler narrows it to an object and reads `fields.idempotencyKey` / `fields.text` (`const fields = body as Record<string, unknown>`). T2/T3/T4 edits in that handler come after this block and do not touch it.

**Sites:**

| site (today) | today on failure | change | user-visible result |
|---|---|---|---|
| app/api/lists/route.ts:132 (POST) | `request.json()` throws, untagged Next 500 | `readJsonBody(request, "lists/POST")` | none in normal use; bad body is a 400 with a tagged warn |
| app/api/lists/route.ts:191 (PATCH) | same | `readJsonBody(request, "lists/PATCH")` | same |
| app/api/lists/archive/route.ts:12 | same | `readJsonBody(request, "lists-archive")` | same (client already reverts on !ok) |
| app/api/lists/reorder/route.ts:13 | same | `readJsonBody(request, "lists-reorder")` | same (reorderFailed toast already shows) |
| app/api/lists/[id]/items/reorder/route.ts:24 | same; queue retries the 500 for 24h | `readJsonBody(request, "items/reorder/POST")` | a permanently bad queued reorder is now a 400, dropped once with items.syncError |
| app/api/lists/[id]/items/route.ts:98 (POST) | SyntaxError 500; a JSON `null` throws a TypeError at `body.idempotencyKey` (500); queue retries 24h | `readJsonBody(request, "items/POST")`, then an explicit 400 for anything that is not an object, before any field is read | a permanently bad queued create is a 400, dropped with items.syncError and its temp item removed |
| app/api/lists/[id]/items/route.ts:316 (PATCH) | SyntaxError 500, queue retries 24h | `readJsonBody(request, "items/PATCH")` | bad queued edit is a 400, dropped once with items.syncError |
| app/api/user/route.ts:113 (PATCH) | untagged 500 | `readJsonBody(request, "user/PATCH")` | none (client always sends JSON) |
| app/api/share/route.ts:60 (POST) | untagged 500; a non-string `listId` reached `verifyListPermission` | `readJsonBody(request, "share/POST")` + `parseBody(createInviteSchema, …)`; the hand-rolled "Missing listId" check is removed (the schema covers it); the `"view"`/`"edit"` coercion is kept | none (ShareDialog only reads `res.ok`); a missing listId still gets a 400, now with the standard "Validation error" body |
| migrate app/api/lists/[id]/categories/order/route.ts:17 | already 400 + tagged warn | inline `.catch` replaced by `readJsonBody(request, "categories/order/PUT")` | none (same tag, same 400) |
| migrate app/api/lists/[id]/categories/route.ts:38 | already handled | `readJsonBody(request, "categories/POST")` | none |
| migrate app/api/lists/[id]/categories/[categoryId]/route.ts:33 | already handled | `readJsonBody(request, "categories/PATCH")` | none |
| migrate app/api/lists/[id]/items/unskip-all/route.ts:24 | already handled | `readJsonBody(request, "items/unskip-all/POST")` | none |

Audit of the same class: `grep -rn "\.json()" app/api src` finds 15 body reads. The 13 above plus two that already guard with try/catch and `describeBodyParseError` and stay as they are: `app/api/webhook/route.ts:33` and `app/api/auth/telegram-login/route.ts:30`. No route reads `request.text()` / `formData()`. The guard change in Step 1 keeps this class closed: any future unguarded `request.json()` fails `no-silent-catches.test.ts`.

- [ ] **Step 1: write the failing tests**

Create `__tests__/unit/api-helpers.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { readJsonBody } from "@/src/lib/api-validation";
import { dbError } from "@/src/lib/api-errors";

const post = (body: string) => new NextRequest("https://app.test/x", { method: "POST", body });

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("readJsonBody", () => {
  it("returns null for a body that is not JSON and logs only the error type, tagged", async () => {
    expect(await readJsonBody(post('SECRET_TEXT{"a":'), "t/POST")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[t/POST] Could not parse request body:", "SyntaxError");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET");
  });

  it("returns null for an empty body", async () => {
    expect(await readJsonBody(post(""), "t/POST")).toBeNull();
    expect(warn).toHaveBeenCalledWith("[t/POST] Could not parse request body:", "SyntaxError");
  });

  it("returns a JSON body as parsed, without logging", async () => {
    expect(await readJsonBody(post('{"name":"Groceries","n":[1,2]}'), "t/POST")).toEqual({ name: "Groceries", n: [1, 2] });
    expect(await readJsonBody(post("null"), "t/POST")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("dbError", () => {
  it("logs the tag, the operation, the context and the error, and answers 500", async () => {
    const err = { message: "connection reset", code: "08006" };
    const res = dbError("lists/GET", "Owned lists read", err, { userId: "u1" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Owned lists read failed" });
    expect(error).toHaveBeenCalledWith("[lists/GET] Owned lists read failed:", { userId: "u1" }, err);
  });

  it("logs just the error when there is no context", async () => {
    const err = new Error("boom");
    const res = dbError("user/PATCH", "User update", err);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "User update failed" });
    expect(error).toHaveBeenCalledWith("[user/PATCH] User update failed:", err);
    expect(error.mock.calls[0]).toHaveLength(2);
  });
});
```

Create `__tests__/unit/request-body-routes.test.ts`. It runs the 13 real handlers. Every database call is faked to fail, so a valid body stops at its first read with no AI or network call; the "still accepts a JSON body" cases only assert that a database call happened, which stays true after T2-T4 change what those handlers do on a failed read.

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

// Runs the real route handlers; auth, the rate limiter, Supabase and the AI services are faked.
const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
  permCalls: [] as unknown[][],
  after: [] as (() => unknown)[],
}));
vi.mock("@/src/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/src/lib/rate-limit")>()),
  apiRateLimiter: {},
}));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async (...a: unknown[]) => { h.permCalls.push(a); return { allowed: true, role: "owner" }; },
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));
vi.mock("@/src/lib/env", async (orig) => ({
  ...(await orig<typeof import("@/src/lib/env")>()),
  serverEnv: () => ({ NEXT_PUBLIC_BOT_USERNAME: "test_bot" }),
}));
vi.mock("@/src/services/categorize-list", () => ({ categorizeList: vi.fn(async () => {}) }));
vi.mock("@/src/services/item-recycler", () => ({ findRecyclableItems: async () => [], recycleItem: async () => null }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => { h.after.push(fn); },
}));

import { POST as listsPOST, PATCH as listsPATCH } from "@/app/api/lists/route";
import { POST as archivePOST } from "@/app/api/lists/archive/route";
import { POST as listsReorderPOST } from "@/app/api/lists/reorder/route";
import { POST as itemsReorderPOST } from "@/app/api/lists/[id]/items/reorder/route";
import { POST as itemsPOST, PATCH as itemsPATCH } from "@/app/api/lists/[id]/items/route";
import { POST as unskipAllPOST } from "@/app/api/lists/[id]/items/unskip-all/route";
import { POST as categoriesPOST } from "@/app/api/lists/[id]/categories/route";
import { PATCH as categoryPATCH } from "@/app/api/lists/[id]/categories/[categoryId]/route";
import { PUT as categoryOrderPUT } from "@/app/api/lists/[id]/categories/order/route";
import { PATCH as userPATCH } from "@/app/api/user/route";
import { POST as sharePOST } from "@/app/api/share/route";

const LIST = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e01";
const ITEM = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e02";
const CAT = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e03";
const listCtx = { params: Promise.resolve({ id: LIST }) };
const catCtx = { params: Promise.resolve({ id: LIST, categoryId: CAT }) };
const BAD_BODY = 'SECRET_TEXT{"name":';

const raw = (method: string, body: string) =>
  new NextRequest("https://app.test/api/x", { method, headers: { "Content-Type": "application/json" }, body });

// [label, method, log tag, handler, a body that passes validation]
const ROUTES: [string, string, string, (r: NextRequest) => Promise<Response>, unknown][] = [
  ["POST /api/lists", "POST", "lists/POST", (r) => listsPOST(r), { name: "Groceries" }],
  ["PATCH /api/lists", "PATCH", "lists/PATCH", (r) => listsPATCH(r), { id: LIST, name: "Groceries" }],
  ["POST /api/lists/archive", "POST", "lists-archive", (r) => archivePOST(r), { listId: LIST, archived: true }],
  ["POST /api/lists/reorder", "POST", "lists-reorder", (r) => listsReorderPOST(r), { orderedIds: [LIST] }],
  ["POST items/reorder", "POST", "items/reorder/POST", (r) => itemsReorderPOST(r, listCtx), { orderedIds: [ITEM] }],
  ["POST items", "POST", "items/POST", (r) => itemsPOST(r, listCtx), { text: "milk" }],
  ["PATCH items", "PATCH", "items/PATCH", (r) => itemsPATCH(r, listCtx), { itemId: ITEM, completed: true }],
  ["POST items/unskip-all", "POST", "items/unskip-all/POST", (r) => unskipAllPOST(r, listCtx), { itemIds: [ITEM] }],
  ["POST categories", "POST", "categories/POST", (r) => categoriesPOST(r, listCtx), { name: "Pets", locale: "en" }],
  ["PATCH categories/[categoryId]", "PATCH", "categories/PATCH", (r) => categoryPATCH(r, catCtx), { name: "Pets", locale: "en" }],
  ["PUT categories/order", "PUT", "categories/order/PUT", (r) => categoryOrderPUT(r, listCtx), { orderedIds: [CAT] }],
  ["PATCH /api/user", "PATCH", "user/PATCH", (r) => userPATCH(r), { language: "he" }],
  ["POST /api/share", "POST", "share/POST", (r) => sharePOST(r), { listId: LIST }],
];

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
function use(resolve: (c: FakeCall) => FakeResult) { h.fake = fakeSupabase(resolve) as typeof h.fake; }
const logged = () => JSON.stringify([...warn.mock.calls, ...error.mock.calls]);

beforeEach(() => {
  h.permCalls = [];
  h.after = [];
  // Every database call fails, so a valid body stops at its first read without any AI call.
  use(() => ({ data: null, error: { message: "db down" } }));
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("a request body that is not JSON gets a 400, never a 500", () => {
  it.each(ROUTES)("%s", async (_label, method, tag, handler) => {
    const res = await handler(raw(method, BAD_BODY));

    expect(res.status).toBe(400);
    expect(warn).toHaveBeenCalledWith(`[${tag}] Could not parse request body:`, "SyntaxError");
    expect(h.fake.calls).toEqual([]);
    expect(logged()).not.toContain("SECRET");
  });

  it.each(ROUTES)("%s still accepts a JSON body", async (_label, method, _tag, handler, body) => {
    await handler(raw(method, JSON.stringify(body)));

    expect(h.fake.calls.length).toBeGreaterThan(0);
    expect(logged()).not.toContain("Could not parse request body");
  });
});

describe("POST items reads fields only off a JSON object", () => {
  it.each([
    ["a literal null", "null", "null"],
    ["a number", "42", "number"],
    ["a string", '"milk"', "string"],
  ])("answers 400 for %s", async (_label, body, kind) => {
    const res = await itemsPOST(raw("POST", body), listCtx);

    expect(res.status).toBe(400);
    expect(warn).toHaveBeenCalledWith("[items/POST] Request body is not a JSON object:", kind);
    expect(h.fake.calls).toEqual([]);
  });
});

describe("POST /api/share validates its body", () => {
  beforeEach(() => use(() => ({ data: null, error: null })));
  const share = (body: unknown) => sharePOST(raw("POST", JSON.stringify(body)));
  const inserted = () => h.fake.calls.filter((c) => c.table === "invite_links" && c.op === "insert").map((c) => c.values);

  it.each([
    ["no listId", {}],
    ["an empty listId", { listId: "" }],
    ["a listId that is not a string", { listId: 7 }],
    ["a permission that is not a string", { listId: LIST, permission: 1 }],
  ])("answers 400 for %s, before the permission check", async (_label, body) => {
    const res = await share(body);

    expect(res.status).toBe(400);
    expect(h.permCalls).toEqual([]);
    expect(h.fake.calls).toEqual([]);
  });

  it.each([
    ["no permission", {}, "edit"],
    ["view", { permission: "view" }, "view"],
    ["edit", { permission: "edit" }, "edit"],
    ["an unknown permission", { permission: "admin" }, "edit"],
  ])("creates the invite for %s", async (_label, extra, stored) => {
    const res = await share({ listId: LIST, ...extra });

    expect(res.status).toBe(201);
    expect(h.permCalls).toEqual([["u1", LIST, "edit"]]);
    expect(inserted()).toEqual([expect.objectContaining({ list_id: LIST, permission: stored, created_by: "u1" })]);
    const json = await res.json();
    expect(json.link).toBe(`https://t.me/test_bot?start=invite_${json.token}`);
  });
});
```

Edit `__tests__/unit/no-silent-catches.test.ts` (three edits, all in the body-parse rule):

1. In `findRawBodyParseLogs`, replace the `else` branch:

```ts
      } else {
        for (let a: ts.Node = node; a.parent; a = a.parent) {
          if (ts.isFunctionLike(a)) break;
          if (ts.isTryStatement(a.parent) && a.parent.tryBlock === a && a.parent.catchClause) {
            const c = a.parent.catchClause;
            const decl = c.variableDeclaration;
            judge(node, c.block, decl && ts.isIdentifier(decl.name) ? decl.name.text : undefined);
            break;
          }
        }
      }
```

with:

```ts
      } else {
        let guarded = false;
        for (let a: ts.Node = node; a.parent; a = a.parent) {
          if (ts.isFunctionLike(a)) break;
          if (ts.isTryStatement(a.parent) && a.parent.tryBlock === a && a.parent.catchClause) {
            const c = a.parent.catchClause;
            const decl = c.variableDeclaration;
            judge(node, c.block, decl && ts.isIdentifier(decl.name) ? decl.name.text : undefined);
            guarded = true;
            break;
          }
        }
        // An unguarded body parse throws on a bad body, which the route answers with an untagged 500.
        if (!guarded) raw.push(at(node));
      }
```

2. Rename the describe and swap the scanned-file sample (the categories route no longer calls `request.json()`; the shared helper does):

```ts
describe("a failed request.json() is logged without the body", () => {
```
becomes
```ts
describe("every request.json() is guarded, and a failure is logged without the body", () => {
```
and
```ts
    expect(checked).toContain("app/api/lists/[id]/categories/route.ts");
```
becomes
```ts
    expect(checked).toContain("src/lib/api-validation.ts");
```

3. In "the rule flags a raw error and accepts the wrapped one", after the line `expect(check('request.json().catch(() => null)')).toHaveLength(1);` add:

```ts
    expect(check('const b = await request.json();')).toHaveLength(1);
```

- [ ] **Step 2: run them, expect FAIL**

```bash
npx vitest run __tests__/unit/api-helpers.test.ts __tests__/unit/request-body-routes.test.ts __tests__/unit/no-silent-catches.test.ts
```

Expected (verified on a copy of today's tree):
- `api-helpers.test.ts` fails to load: `Cannot find module '@/src/lib/api-errors'`.
- `request-body-routes.test.ts`: 14 failures. The "not JSON" case fails for the 9 unguarded routes (POST/PATCH /api/lists, archive, lists reorder, items reorder, POST/PATCH items, PATCH /api/user, POST /api/share): the handler rejects with the SyntaxError instead of answering 400. The 4 migrate routes already pass (they are regression cover for the switch). The three "POST items reads fields only off a JSON object" cases fail (a literal null throws a TypeError; a number or string reaches `parseBody` and logs `[parseBody]`, not the tagged warn). Two share cases fail: `{ listId: 7 }` and `{ permission: 1 }` answer 201 today.
- `no-silent-catches.test.ts`: "every caught body-parse error…" fails with the 9 unguarded `request.json()` sites listed.

- [ ] **Step 3: implementation**

**3a. `src/lib/api-errors.ts` (new file, whole content):**

```ts
import { NextResponse } from "next/server";

/** Logs a failed database call with its context and returns the route's 500. `what` names the operation, e.g. "Owned lists read". */
export function dbError(tag: string, what: string, error: unknown, ctx?: Record<string, unknown>): NextResponse {
  if (ctx) console.error(`[${tag}] ${what} failed:`, ctx, error);
  else console.error(`[${tag}] ${what} failed:`, error);
  return NextResponse.json({ error: `${what} failed` }, { status: 500 });
}
```

**3b. `src/lib/api-validation.ts`.** Current:

```ts
export function describeBodyParseError(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
```

Replace with:

```ts
export function describeBodyParseError(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** Reads a JSON body. A body that is not JSON logs its error type (never the body) and returns null, which parseBody turns into a 400. */
export async function readJsonBody(request: Request, tag: string): Promise<unknown> {
  return request.json().catch((err) => {
    console.warn(`[${tag}] Could not parse request body:`, describeBodyParseError(err));
    return null;
  });
}
```

**3c. `src/schemas/share.ts`.** Current (whole file):

```ts
import { z } from "zod";

export const approveCollaboratorSchema = z.object({
  listId: z.string().uuid(),
  collaboratorId: z.string().uuid(),
});
```

Replace with:

```ts
import { z } from "zod";

export const approveCollaboratorSchema = z.object({
  listId: z.string().uuid(),
  collaboratorId: z.string().uuid(),
});

// POST /api/share. permission stays a free string: the route stores "view" as view and
// anything else as edit.
export const createInviteSchema = z.object({
  listId: z.string().min(1),
  permission: z.string().optional(),
});
```

**3d. `app/api/lists/route.ts`.** Import line 6:

```ts
import { parseBody } from "@/src/lib/api-validation";
```
→
```ts
import { parseBody, readJsonBody } from "@/src/lib/api-validation";
```

POST (line 132):
```ts
  const body = await request.json();
  const parsed = parseBody(createListSchema, body);
```
→
```ts
  const body = await readJsonBody(request, "lists/POST");
  const parsed = parseBody(createListSchema, body);
```

PATCH (line 191):
```ts
  const body = await request.json();
  const parsed = parseBody(updateListSchema, body);
```
→
```ts
  const body = await readJsonBody(request, "lists/PATCH");
  const parsed = parseBody(updateListSchema, body);
```

**3e. `app/api/lists/archive/route.ts`.** Import line 6 `import { parseBody } from "@/src/lib/api-validation";` → `import { parseBody, readJsonBody } from "@/src/lib/api-validation";`. Line 12:
```ts
  const body = await request.json();
```
→
```ts
  const body = await readJsonBody(request, "lists-archive");
```

**3f. `app/api/lists/reorder/route.ts`.** Import line 6 same swap as 3e. Line 13:
```ts
  const body = await request.json();
```
→
```ts
  const body = await readJsonBody(request, "lists-reorder");
```

**3g. `app/api/lists/[id]/items/reorder/route.ts`.** Import line 6 same swap as 3e. Line 24:
```ts
  const body = await request.json();
```
→
```ts
  const body = await readJsonBody(request, "items/reorder/POST");
```

**3h. `app/api/lists/[id]/items/route.ts`.** Import line 7 `import { parseBody } from "@/src/lib/api-validation";` → `import { parseBody, readJsonBody } from "@/src/lib/api-validation";`.

POST (lines 98-102), current:
```ts
  const body = await request.json();
  const supabase = createServerClient();

  // Idempotent single-item create (from mutation queue replay)
  if (body.idempotencyKey && typeof body.text === "string") {
```
Replace with:
```ts
  const body = await readJsonBody(request, "items/POST");
  // Both create paths read fields off the body before validating it, so anything that is not
  // a JSON object (unparseable, a literal null, a number) is refused here instead of throwing
  // a TypeError that the route would answer with an untagged 500.
  if (typeof body !== "object" || body === null) {
    console.warn("[items/POST] Request body is not a JSON object:", body === null ? "null" : typeof body);
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const fields = body as Record<string, unknown>;
  const supabase = createServerClient();

  // Idempotent single-item create (from mutation queue replay)
  if (fields.idempotencyKey && typeof fields.text === "string") {
```
The two later `parseBody(createItemIdempotentSchema, body)` and `parseBody(createItemSchema, body)` calls stay unchanged (they take `unknown`). An array body passes the object check and is rejected by `createItemSchema` with a 400, as today. The warn logs only `"null"` or the `typeof` name, never the body.

PATCH (line 316):
```ts
  const body = await request.json();
  const parsed = parseBody(updateItemSchema, body);
```
→
```ts
  const body = await readJsonBody(request, "items/PATCH");
  const parsed = parseBody(updateItemSchema, body);
```

**3i. `app/api/user/route.ts`.** Import line 8 `import { parseBody } from "@/src/lib/api-validation";` → `import { parseBody, readJsonBody } from "@/src/lib/api-validation";`. Line 113 (PATCH):
```ts
  const body = await request.json();
```
→
```ts
  const body = await readJsonBody(request, "user/PATCH");
```
(POST /api/user reads no body; nothing to change there.)

**3j. `app/api/share/route.ts`.** Imports, current line 6:
```ts
import { serverEnv } from "@/src/lib/env";
```
→
```ts
import { serverEnv } from "@/src/lib/env";
import { parseBody, readJsonBody } from "@/src/lib/api-validation";
import { createInviteSchema } from "@/src/schemas/share";
```

POST lines 60-65, current:
```ts
  const body = await request.json();
  const { listId, permission = "edit" } = body;

  if (!listId) {
    return NextResponse.json({ error: "Missing listId" }, { status: 400 });
  }
```
Replace with:
```ts
  const body = await readJsonBody(request, "share/POST");
  const parsed = parseBody(createInviteSchema, body);
  if (!parsed.success) return parsed.response;
  const { listId, permission = "edit" } = parsed.data;
```
The rest of POST (`verifyListPermission`, `permission: permission === "view" ? "view" : "edit"`, the insert) is unchanged.

**3k. The four migrated routes.** In each, swap the import and replace the inline catch. The tag strings stay exactly as today.

`app/api/lists/[id]/categories/order/route.ts`, line 5:
```ts
import { describeBodyParseError, parseBody } from "@/src/lib/api-validation";
```
→
```ts
import { parseBody, readJsonBody } from "@/src/lib/api-validation";
```
lines 17-20:
```ts
  const body = await request.json().catch((err) => {
    console.warn("[categories/order/PUT] Could not parse request body:", describeBodyParseError(err));
    return null;
  });
```
→
```ts
  const body = await readJsonBody(request, "categories/order/PUT");
```

`app/api/lists/[id]/categories/route.ts`, same import swap on line 5; lines 38-41:
```ts
  const body = await request.json().catch((err) => {
    console.warn("[categories/POST] Could not parse request body:", describeBodyParseError(err));
    return null;
  });
```
→
```ts
  const body = await readJsonBody(request, "categories/POST");
```

`app/api/lists/[id]/categories/[categoryId]/route.ts`, same import swap on line 5; lines 33-36:
```ts
  const body = await request.json().catch((err) => {
    console.warn("[categories/PATCH] Could not parse request body:", describeBodyParseError(err));
    return null;
  });
```
→
```ts
  const body = await readJsonBody(request, "categories/PATCH");
```

`app/api/lists/[id]/items/unskip-all/route.ts`, line 6:
```ts
import { describeBodyParseError, parseBody } from "@/src/lib/api-validation";
```
→
```ts
import { parseBody, readJsonBody } from "@/src/lib/api-validation";
```
lines 24-27:
```ts
  const body = await request.json().catch((err) => {
    console.warn("[items/unskip-all/POST] Could not parse request body:", describeBodyParseError(err));
    return null;
  });
```
→
```ts
  const body = await readJsonBody(request, "items/unskip-all/POST");
```

After 3k, `describeBodyParseError` is imported only by `src/lib/api-validation.ts` (its own use), `app/api/webhook/route.ts` and `app/api/auth/telegram-login/route.ts`. Check: `grep -rn "describeBodyParseError" app src` lists exactly those three files.

- [ ] **Step 4: update existing tests and mocks**

None. Verified on a copy of the tree with all of Step 3 applied: the full suite (74 files, 602 tests) passes with no change to any existing test other than the `no-silent-catches.test.ts` edits in Step 1. The existing route tests (`categories-routes`, `unskip-all-route`, `user-update`, `lists-route-categorize`, `items-route-categorize`, `items-get-columns`, `items-completion-no-reminders`) all send valid JSON.

- [ ] **Step 5: run tests, expect PASS**

```bash
npx vitest run __tests__/unit/api-helpers.test.ts __tests__/unit/request-body-routes.test.ts __tests__/unit/no-silent-catches.test.ts
npx vitest run
npx tsc --noEmit
npx eslint src/lib/api-validation.ts src/lib/api-errors.ts src/schemas/share.ts app/api/lists/route.ts app/api/lists/archive/route.ts app/api/lists/reorder/route.ts "app/api/lists/[id]/items/reorder/route.ts" "app/api/lists/[id]/items/route.ts" "app/api/lists/[id]/items/unskip-all/route.ts" "app/api/lists/[id]/categories/route.ts" "app/api/lists/[id]/categories/[categoryId]/route.ts" "app/api/lists/[id]/categories/order/route.ts" app/api/user/route.ts app/api/share/route.ts __tests__/unit/api-helpers.test.ts __tests__/unit/request-body-routes.test.ts __tests__/unit/no-silent-catches.test.ts
```

Expected: the three files 52/52 pass; full suite green; tsc and eslint print nothing. (`tsc` would flag a missed `body.` read in items POST, since `body` is now `unknown`.)

- [ ] **Step 6: make it bite**

Each mutation was run on a copy of the tree; restore the line after each run and re-run Step 5's first command to see green.

1. `src/lib/api-validation.ts`: replace the body of `readJsonBody` with `return request.json();`. Red: "readJsonBody > returns null for a body that is not JSON…", "…returns null for an empty body", and every "a request body that is not JSON gets a 400" route case.
2. `src/lib/api-errors.ts`: change `{ status: 500 }` to `{ status: 200 }`. Red: both `dbError` tests. Separately, drop `ctx, ` from the first `console.error`. Red: "dbError > logs the tag, the operation, the context and the error, and answers 500".
3. `app/api/lists/route.ts`: put back `const body = await request.json();` in POST. Red: "a request body that is not JSON gets a 400, never a 500 > POST /api/lists" and the no-silent-catches "every caught body-parse error…" test (it lists the unguarded site).
4. `app/api/lists/[id]/items/route.ts`: change `if (typeof body !== "object" || body === null) {` to `if (false) {`. Red: "POST items reads fields only off a JSON object" (all 3) and the POST items "not JSON" case.
5. `src/schemas/share.ts`: change `listId: z.string().min(1),` to `listId: z.any(),`. Red: the three share "answers 400 for … listId …" cases.
6. `__tests__/unit/no-silent-catches.test.ts`: delete `if (!guarded) raw.push(at(node));`. Red: "the rule flags a raw error and accepts the wrapped one" (the new `const b = await request.json();` case).

- [ ] **Step 7: commit**

```bash
git add src/lib/api-errors.ts src/lib/api-validation.ts src/schemas/share.ts app/api/lists/route.ts app/api/lists/archive/route.ts app/api/lists/reorder/route.ts "app/api/lists/[id]/items/reorder/route.ts" "app/api/lists/[id]/items/route.ts" "app/api/lists/[id]/items/unskip-all/route.ts" "app/api/lists/[id]/categories/route.ts" "app/api/lists/[id]/categories/[categoryId]/route.ts" "app/api/lists/[id]/categories/order/route.ts" app/api/user/route.ts app/api/share/route.ts __tests__/unit/api-helpers.test.ts __tests__/unit/request-body-routes.test.ts __tests__/unit/no-silent-catches.test.ts
git commit -F - <<'EOF'
fix(api): answer a malformed request body with a 400, not a 500

Every route now reads its JSON body through readJsonBody, which logs only
the error type and lets parseBody answer 400. Items POST refuses a body
that is not an object before reading fields off it, and POST /api/share
validates its body with a schema. The no-silent-catches guard now also
flags an unguarded request.json(). Adds the dbError helper for the
database-failure work that follows.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
```

### Task 2a: Permission and recipient lookups fail loudly

**Files:**
- Modify: `src/lib/api-auth.ts` (verifyUserAuth initData user lookup, verifyListPermission both reads)
- Modify: `src/lib/list-notify.ts` (resolveListRecipients both reads)
- Modify (tests): `__tests__/unit/list-notify.test.ts` (append a `resolveListRecipients` describe)
- Create (tests): `__tests__/unit/api-auth.test.ts`
- Create (tests): `__tests__/unit/signal-recipients.test.ts` (ready + remind routes through the real `resolveListRecipients`)
- No change: `app/api/lists/[id]/ready/route.ts`, `app/api/lists/[id]/remind/route.ts`. Their call to `resolveListRecipients` stays as is: the helper now throws, the throw leaves the route before any send, and Next answers 500. The client (`sendSignal` in `src/hooks/useItemHandlers.ts:665`) already shows `items.signalError` on any non-ok response.

**Interfaces:**
- Consumes (from T1, `src/lib/api-errors.ts`): `dbError(tag: string, what: string, error: unknown, ctx?: Record<string, unknown>): NextResponse`. It logs `` `[${tag}] ${what} failed:` ``, ctx, error and returns `{ error: "<what> failed" }` with status 500.
- Produces (behavior contracts; no new exports and no signature changes):
  - `verifyListPermission(userId, listId, requiredPermission)` keeps returning `Promise<{ allowed: boolean; role: "owner" | "editor" | "viewer" | null }>`. On a DB error in either read it logs `[Permission] List read failed:` or `[Permission] Collaborator read failed:` with `{ userId, listId }` and the error, then throws `Error("Permission check failed", { cause })`. Every list route then answers Next's 500 instead of 403. A missing row still returns `{ allowed: false, role: null }`.
  - `verifyUserAuth` (initData path): a failed user read returns `{ success: false, response }`, where the response is dbError's 500 `{ error: "User lookup failed" }`. A missing row keeps the warning and the 404.
  - `resolveListRecipients(supabase, listId, senderUserId): Promise<Recipient[]>` (signature unchanged) logs `[ListNotify] Owner read failed:` or `[ListNotify] Collaborators read failed:` with `{ listId }` and the error, then throws `Error("Recipient lookup failed", { cause })`.

**Sites:**

| site (as of today) | today on failure | change | user-visible result |
|---|---|---|---|
| `src/lib/api-auth.ts:124` (verifyUserAuth initData user read) | The error is folded into "not found". It warns `User not found` with no error object and returns 404 "Please open the app first" | `.maybeSingle()`. `if (error)` returns `dbError(endpointName, "User lookup", error, { telegramUserId })`. A missing row keeps the warning and the 404 | During a DB blip, initData callers get a retryable 500 instead of "open the app first". The cause is logged |
| `src/lib/api-auth.ts:160` (verifyListPermission list read) | The error is ignored, so the read gives `!list`, `allowed:false` and a 403 from every list route. The queue drops that 403 | `.maybeSingle()`, then log and throw on `error` | The owner is never told "Access denied" because of a blip. Queued changes retry (5xx) instead of being dropped |
| `src/lib/api-auth.ts:176` (verifyListPermission collaborator read) | The error is ignored, so a collaborator gets a 403 as if they had been removed | `.maybeSingle()`, then log and throw on `error` | Same as above, for collaborators |
| `src/lib/list-notify.ts:47` (owner + embed read) | The error is ignored and the owner is silently left out. The route answers 200 with a low `sent` | `.maybeSingle()`, then log and throw on `error` | Remind/Ready show `items.signalError` instead of a false success |
| `src/lib/list-notify.ts:53` (approved collaborators read) | The error is ignored, so there are 0 collaborators and the route answers 200 `{ sent: 0 }` | Log and throw on `error` | `items.signalError` instead of the false "no one to notify" |
| `app/api/lists/[id]/ready/route.ts:45` | Gets [] or a partial list, then a false 200 | No code change: the helper's throw gives a 500 before any send. Covered by the new route test | `items.signalError` toast |
| `app/api/lists/[id]/remind/route.ts:47` | Same | Same | Same |

- [ ] **Step 1: write the failing tests**

Create `__tests__/unit/api-auth.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; filters: string[] }[] },
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));
// The initData path: a valid signature for Telegram user 42, never rate limited.
vi.mock("@/src/lib/telegram-auth", () => ({ validateInitData: () => ({ id: 42, first_name: "Dana" }) }));
vi.mock("@/src/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ success: true, remaining: 59, reset: 0 }),
  getRateLimitHeaders: () => ({}),
}));
vi.mock("@/src/lib/jwt", () => ({ getJwtSecret: () => new TextEncoder().encode("test-secret") }));

import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";

// PostgREST answers .single() on zero rows with PGRST116, while .maybeSingle() answers null.
// The fake mimics that, so a missing row is only "normal" through .maybeSingle().
const NO_ROW = { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" };
const answer = (call: FakeCall, row: unknown): FakeResult =>
  row == null && call.filters.includes("single") ? { data: null, error: NO_ROW } : { data: row ?? null, error: null };
const dbErr = { message: "canceling statement due to statement timeout", code: "57014" };

function use(resolve: (c: FakeCall) => FakeResult) {
  h.fake = fakeSupabase(resolve) as typeof h.fake;
}
const initDataReq = () =>
  new NextRequest("https://app.test/api/lists", { headers: { "x-telegram-init-data": "signed" } });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("verifyUserAuth (initData path) user lookup", () => {
  it("answers 500 and logs the error when the user read fails, not 'open the app first'", async () => {
    use(() => ({ data: null, error: dbErr }));
    const auth = await verifyUserAuth(initDataReq(), {} as never, "items-create");
    expect(auth.success).toBe(false);
    if (auth.success) return;
    expect(auth.response.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[items-create] User lookup failed:", { telegramUserId: 42 }, dbErr);
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("User not found"));
  });

  it("keeps the 404 and the warning for a user who has no row", async () => {
    use((c) => answer(c, null));
    const auth = await verifyUserAuth(initDataReq(), {} as never, "items-create");
    expect(auth.success).toBe(false);
    if (auth.success) return;
    expect(auth.response.status).toBe(404);
    expect(console.warn).toHaveBeenCalledWith("[items-create] User not found: 42");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("returns the user when the row is found", async () => {
    const user = { id: "u1", telegram_id: 42, name: "Dana", username: null, language: "he" };
    use((c) => answer(c, user));
    const auth = await verifyUserAuth(initDataReq(), {} as never, "items-create");
    expect(auth).toEqual({ success: true, userId: "u1", telegramUserId: 42, user });
  });
});

describe("verifyListPermission", () => {
  // The owner read (lists) and the collaborator read (collaborators), told apart by table.
  function db(opts: { list?: unknown; listError?: unknown; collab?: unknown; collabError?: unknown }) {
    use((c) => {
      if (c.table === "lists") return opts.listError ? { data: null, error: opts.listError } : answer(c, opts.list);
      if (c.table === "collaborators") return opts.collabError ? { data: null, error: opts.collabError } : answer(c, opts.collab);
      return { data: null, error: null };
    });
  }

  it("allows the owner", async () => {
    db({ list: { owner_id: "u1" } });
    expect(await verifyListPermission("u1", "L", "edit")).toEqual({ allowed: true, role: "owner" });
  });

  it("throws and logs when the list read fails, so the route answers 500 instead of a false 403", async () => {
    db({ listError: dbErr });
    await expect(verifyListPermission("u1", "L", "edit")).rejects.toThrow("Permission check failed");
    expect(console.error).toHaveBeenCalledWith("[Permission] List read failed:", { userId: "u1", listId: "L" }, dbErr);
    expect(h.fake.calls.some((c) => c.table === "collaborators")).toBe(false);
  });

  it("denies, without logging an error, when the list does not exist or was deleted", async () => {
    db({ list: null });
    expect(await verifyListPermission("u1", "L", "view")).toEqual({ allowed: false, role: null });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("throws and logs when the collaborator read fails", async () => {
    db({ list: { owner_id: "owner" }, collabError: dbErr });
    await expect(verifyListPermission("u1", "L", "view")).rejects.toThrow("Permission check failed");
    expect(console.error).toHaveBeenCalledWith("[Permission] Collaborator read failed:", { userId: "u1", listId: "L" }, dbErr);
  });

  it("denies, without logging an error, a user who is not an approved collaborator", async () => {
    db({ list: { owner_id: "owner" }, collab: null });
    expect(await verifyListPermission("u1", "L", "view")).toEqual({ allowed: false, role: null });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("lets an edit collaborator edit, and a view collaborator only view", async () => {
    db({ list: { owner_id: "owner" }, collab: { permission: "edit", status: "approved" } });
    expect(await verifyListPermission("u1", "L", "edit")).toEqual({ allowed: true, role: "editor" });
    db({ list: { owner_id: "owner" }, collab: { permission: "view", status: "approved" } });
    expect(await verifyListPermission("u1", "L", "edit")).toEqual({ allowed: false, role: "viewer" });
    expect(await verifyListPermission("u1", "L", "view")).toEqual({ allowed: true, role: "viewer" });
  });
});
```

In `__tests__/unit/list-notify.test.ts`, replace the first two import lines:

```ts
import { describe, it, expect } from "vitest";
import { buildRecipientList, candidatesFromRows, type JoinedUser } from "@/src/lib/list-notify";
```

with:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildRecipientList, candidatesFromRows, resolveListRecipients, type JoinedUser } from "@/src/lib/list-notify";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";
```

and append at the end of the file:

```ts
describe("resolveListRecipients", () => {
  // PostgREST answers .single() on zero rows with PGRST116; .maybeSingle() answers null.
  const NO_ROW = { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" };
  const dbErr = { message: "canceling statement due to statement timeout", code: "57014" };
  const ownerRow = { owner_id: "owner", users: u("owner", 1, "he") };

  function db(opts: { owner?: unknown; ownerError?: unknown; collabs?: unknown[]; collabError?: unknown }) {
    return fakeSupabase((c: FakeCall): FakeResult => {
      if (c.table === "lists") {
        if (opts.ownerError) return { data: null, error: opts.ownerError };
        if (opts.owner == null && c.filters.includes("single")) return { data: null, error: NO_ROW };
        return { data: opts.owner ?? null, error: null };
      }
      if (c.table === "collaborators") {
        return opts.collabError ? { data: null, error: opts.collabError } : { data: opts.collabs ?? [], error: null };
      }
      return { data: null, error: null };
    }).client;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("notifies the owner and the approved collaborators, never the sender", async () => {
    const supabase = db({
      owner: ownerRow,
      collabs: [{ user_id: "me", users: u("me", 2) }, { user_id: "c1", users: u("c1", 3, "ru") }],
    });
    expect(await resolveListRecipients(supabase, "L", "me")).toEqual([
      { telegramId: 1, language: "he" },
      { telegramId: 3, language: "ru" },
    ]);
  });

  it("rejects and logs when the owner read fails, instead of silently leaving the owner out", async () => {
    await expect(resolveListRecipients(db({ ownerError: dbErr }), "L", "me")).rejects.toThrow("Recipient lookup failed");
    expect(console.error).toHaveBeenCalledWith("[ListNotify] Owner read failed:", { listId: "L" }, dbErr);
  });

  it("rejects and logs when the collaborators read fails, instead of answering 'nobody to notify'", async () => {
    await expect(resolveListRecipients(db({ owner: ownerRow, collabError: dbErr }), "L", "owner")).rejects.toThrow(
      "Recipient lookup failed"
    );
    expect(console.error).toHaveBeenCalledWith("[ListNotify] Collaborators read failed:", { listId: "L" }, dbErr);
  });

  it("resolves [] when the owner sends and the list has no collaborators", async () => {
    expect(await resolveListRecipients(db({ owner: ownerRow, collabs: [] }), "L", "owner")).toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("still notifies the collaborators when the list row is gone", async () => {
    const supabase = db({ owner: null, collabs: [{ user_id: "c1", users: u("c1", 3) }] });
    expect(await resolveListRecipients(supabase, "L", "me")).toEqual([{ telegramId: 3, language: "en" }]);
    expect(console.error).not.toHaveBeenCalled();
  });
});
```

Create `__tests__/unit/signal-recipients.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown },
  ready: vi.fn(async (..._args: unknown[]) => {}),
  remind: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "editor" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));
vi.mock("@/src/services/bot", () => ({ sendListReady: h.ready, sendListReminder: h.remind }));

import { POST as readyPOST } from "@/app/api/lists/[id]/ready/route";
import { POST as remindPOST } from "@/app/api/lists/[id]/remind/route";

const dbErr = { message: "canceling statement due to statement timeout", code: "57014" };
const params = () => ({ params: Promise.resolve({ id: "L" }) });
const req = (path: string) => new NextRequest(`https://app.test/api/lists/L/${path}`, { method: "POST" });

// u1 (the sender) is an approved collaborator. The owner is the one to notify.
function db(collabError?: unknown) {
  h.fake = fakeSupabase((c: FakeCall): FakeResult => {
    if (c.table === "lists" && c.cols === "name") return { data: { name: "Groceries" }, error: null };
    if (c.table === "lists") {
      return { data: { owner_id: "owner", users: { id: "owner", telegram_id: 1, language: "he" } }, error: null };
    }
    if (c.table === "users") return { data: { name: "Dana" }, error: null };
    if (c.table === "collaborators") {
      return collabError
        ? { data: null, error: collabError }
        : { data: [{ user_id: "u1", users: { id: "u1", telegram_id: 2, language: "en" } }], error: null };
    }
    return { data: null, error: null };
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.ready.mockClear();
  h.remind.mockClear();
});

describe.each([
  { name: "ready", POST: readyPOST, send: h.ready },
  { name: "remind", POST: remindPOST, send: h.remind },
])("$name route", ({ name, POST, send }) => {
  it("fails (Next answers 500) and sends nothing when the recipient lookup fails, instead of a false 200 { sent: 0 }", async () => {
    db(dbErr);
    await expect(POST(req(name), params())).rejects.toThrow("Recipient lookup failed");
    expect(send).not.toHaveBeenCalled();
  });

  it("notifies the owner when the lookup works", async () => {
    db();
    const res = await POST(req(name), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1 });
    expect(send).toHaveBeenCalledWith(1, "he", "Dana", "Groceries", "L");
  });
});
```

- [ ] **Step 2: run them, expect FAIL**

```bash
npx vitest run __tests__/unit/api-auth.test.ts __tests__/unit/list-notify.test.ts __tests__/unit/signal-recipients.test.ts
```

Expected failures, and why:
- api-auth: "answers 500 ... user read fails". Today it returns 404 with a warning.
- api-auth: "throws and logs when the list read fails" and "throws and logs when the collaborator read fails". Today both resolve `{ allowed: false, role: null }`.
- list-notify: "rejects ... owner read fails" and "rejects ... collaborators read fails". Today both resolve.
- signal-recipients: "fails ... when the recipient lookup fails", for both routes. Today the owner is still found, so the route answers 200 `{ sent: 1 }`.

The "no row" and happy-path tests pass today. They are regression guards, and the bite step uses them for `.maybeSingle()`.

- [ ] **Step 3: implementation**

`src/lib/api-auth.ts`: add the import under `import { getJwtSecret } from "./jwt";`:

```ts
import { dbError } from "./api-errors";
```

Current (lines 122-139):

```ts
  // Look up user in DB
  const supabase = createServerClient();
  const { data: user, error } = await supabase
    .from("users")
    .select("id, telegram_id, name, username, language")
    .eq("telegram_id", telegramUser.id)
    .single();

  if (error || !user) {
    console.warn(`[${endpointName}] User not found: ${telegramUser.id}`);
    return {
      success: false,
      response: NextResponse.json(
        { error: "User not found. Please open the app first." },
        { status: 404 }
      ),
    };
  }
```

Replacement:

```ts
  // Look up user in DB. maybeSingle: no row is a user who never opened the app (404);
  // an error is a failed read, answered 500 so it is never mistaken for a missing user.
  const supabase = createServerClient();
  const { data: user, error } = await supabase
    .from("users")
    .select("id, telegram_id, name, username, language")
    .eq("telegram_id", telegramUser.id)
    .maybeSingle();

  if (error) {
    return {
      success: false,
      response: dbError(endpointName, "User lookup", error, { telegramUserId: telegramUser.id }),
    };
  }

  if (!user) {
    console.warn(`[${endpointName}] User not found: ${telegramUser.id}`);
    return {
      success: false,
      response: NextResponse.json(
        { error: "User not found. Please open the app first." },
        { status: 404 }
      ),
    };
  }
```

Current (lines 149-186):

```ts
/**
 * Check if a user has the required permission level on a list.
 */
export async function verifyListPermission(
  userId: string,
  listId: string,
  requiredPermission: "view" | "edit"
): Promise<{ allowed: boolean; role: "owner" | "editor" | "viewer" | null }> {
  const supabase = createServerClient();

  // Check if user is owner
  const { data: list } = await supabase
    .from("lists")
    .select("owner_id")
    .eq("id", listId)
    .is("deleted_at", null)
    .single();

  if (!list) {
    return { allowed: false, role: null };
  }

  if (list.owner_id === userId) {
    return { allowed: true, role: "owner" };
  }

  // Check collaborator status
  const { data: collab } = await supabase
    .from("collaborators")
    .select("permission, status")
    .eq("list_id", listId)
    .eq("user_id", userId)
    .eq("status", "approved")
    .single();

  if (!collab) {
    return { allowed: false, role: null };
  }
```

Replacement:

```ts
/**
 * Check if a user has the required permission level on a list.
 * A failed read is logged and thrown, so the route answers 500 (which the offline queue
 * retries) instead of a false 403 (which it drops). A missing row is a plain "not allowed".
 */
export async function verifyListPermission(
  userId: string,
  listId: string,
  requiredPermission: "view" | "edit"
): Promise<{ allowed: boolean; role: "owner" | "editor" | "viewer" | null }> {
  const supabase = createServerClient();

  // Check if user is owner
  const { data: list, error: listError } = await supabase
    .from("lists")
    .select("owner_id")
    .eq("id", listId)
    .is("deleted_at", null)
    .maybeSingle();

  if (listError) {
    console.error("[Permission] List read failed:", { userId, listId }, listError);
    throw new Error("Permission check failed", { cause: listError });
  }

  if (!list) {
    return { allowed: false, role: null };
  }

  if (list.owner_id === userId) {
    return { allowed: true, role: "owner" };
  }

  // Check collaborator status
  const { data: collab, error: collabError } = await supabase
    .from("collaborators")
    .select("permission, status")
    .eq("list_id", listId)
    .eq("user_id", userId)
    .eq("status", "approved")
    .maybeSingle();

  if (collabError) {
    console.error("[Permission] Collaborator read failed:", { userId, listId }, collabError);
    throw new Error("Permission check failed", { cause: collabError });
  }

  if (!collab) {
    return { allowed: false, role: null };
  }
```

The rest of the function (lines 188-194) is unchanged. `.maybeSingle()` on collaborators is safe because `collaborators` has `UNIQUE(list_id, user_id)` (migration 001), so it can never see two rows.

`src/lib/list-notify.ts`. Current (lines 41-57):

```ts
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
```

Replacement:

```ts
/**
 * Fetch owner + approved collaborators for a list and build the recipient list (sender excluded).
 * A failed read is logged and thrown: an empty answer would tell the sender "no one to notify"
 * while the members were never told.
 */
export async function resolveListRecipients(
  supabase: SupabaseClient,
  listId: string,
  senderUserId: string
): Promise<Recipient[]> {
  // maybeSingle: a list row that is gone only means there is no owner to notify.
  const { data: listWithOwner, error: ownerError } = await supabase
    .from("lists")
    .select("owner_id, users!lists_owner_id_fkey(id, telegram_id, language)")
    .eq("id", listId)
    .maybeSingle();
  if (ownerError) {
    console.error("[ListNotify] Owner read failed:", { listId }, ownerError);
    throw new Error("Recipient lookup failed", { cause: ownerError });
  }

  const { data: collaborators, error: collabError } = await supabase
    .from("collaborators")
    .select("user_id, users!collaborators_user_id_fkey(id, telegram_id, language)")
    .eq("list_id", listId)
    .eq("status", "approved");
  if (collabError) {
    console.error("[ListNotify] Collaborators read failed:", { listId }, collabError);
    throw new Error("Recipient lookup failed", { cause: collabError });
  }
```

Lines 59-64 (`candidatesFromRows` / `buildRecipientList`) are unchanged. `new Error(msg, { cause })` type-checks because tsconfig `lib` includes `esnext`.

- [ ] **Step 4: update existing tests and mocks that break**

None. Every route test (items-route-categorize, items-get-columns, items-completion-no-reminders, categories-routes, unskip-all-route, unmark-completed-route, user-update, lists-route-categorize) mocks `@/src/lib/api-auth` whole, so the real helper never runs there. `list-notify.test.ts` only gains tests. Do not loosen any new check.

- [ ] **Step 5: run tests, expect PASS**

```bash
npx vitest run __tests__/unit/api-auth.test.ts __tests__/unit/list-notify.test.ts __tests__/unit/signal-recipients.test.ts __tests__/unit/no-silent-catches.test.ts
npx tsc --noEmit
npx eslint src/lib/api-auth.ts src/lib/list-notify.ts __tests__/unit/api-auth.test.ts __tests__/unit/list-notify.test.ts __tests__/unit/signal-recipients.test.ts
```

- [ ] **Step 6: make it bite.** Make each change below by itself, run the test named, confirm it goes red, then restore.
1. In `verifyUserAuth`, delete the `if (error) { return { ... dbError(...) } }` block. "answers 500 ... user read fails" goes red: it gets 404.
2. In `verifyUserAuth`, change `.maybeSingle()` back to `.single()`. "keeps the 404 and the warning for a user who has no row" goes red: the fake's PGRST116 now gives 500.
3. In `verifyListPermission`, delete the `if (listError) { ... throw ... }` block. "throws and logs when the list read fails" goes red.
4. In the lists read of `verifyListPermission`, change `.maybeSingle()` to `.single()`. "denies, without logging an error, when the list does not exist" goes red: it throws.
5. Delete the `if (collabError) { ... throw ... }` block. "throws and logs when the collaborator read fails" goes red.
6. In the collaborators read, change `.maybeSingle()` to `.single()`. "denies, without logging an error, a user who is not an approved collaborator" goes red.
7. In `resolveListRecipients`, delete the `if (ownerError)` block. "rejects and logs when the owner read fails" goes red.
8. In `resolveListRecipients`, change `.maybeSingle()` to `.single()`. "still notifies the collaborators when the list row is gone" goes red.
9. Delete the `if (collabError)` block in `resolveListRecipients`. Both "rejects ... collaborators read fails" (list-notify) and "fails ... when the recipient lookup fails" (signal-recipients, for both routes) go red.

- [ ] **Step 7: commit**

```bash
git add src/lib/api-auth.ts src/lib/list-notify.ts __tests__/unit/api-auth.test.ts __tests__/unit/list-notify.test.ts __tests__/unit/signal-recipients.test.ts
git commit -m "$(cat <<'EOF'
fix(api): permission and recipient lookups fail loudly on a DB error

verifyListPermission and resolveListRecipients now log and throw when a
read fails, so list routes answer a retryable 500 instead of a false 403,
and remind/ready no longer answer a false 200 { sent: 0 }. The initData
user lookup answers 500 instead of "open the app first". Zero-row reads
use maybeSingle so a missing row keeps its normal answer.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
)"
```

### Task 2b: Recycler, batch add and categorizer fail loudly

**Files:**
- Modify: `src/services/item-recycler.ts` (findRecyclableItems, recycleItem)
- Modify: `app/api/lists/[id]/items/route.ts` (POST non-idempotent batch loop only, plus the import line)
- Modify: `src/services/categorize-list.ts` (list-type read in `categorizeList`)
- Modify: `src/utils/categorize-lock.ts` (`release`)
- Modify (test helper): `__tests__/helpers/fake-supabase.ts` (add `.ilike`)
- Modify (tests): `__tests__/unit/categorize-list.test.ts`, `__tests__/unit/categorize-lock.test.ts`
- Create (tests): `__tests__/unit/item-recycler.test.ts`, `__tests__/unit/items-post-recycle-failure.test.ts`

**Interfaces:**
- Consumes: nothing new. T1 will already have replaced `const body = await request.json();` in items POST with `readJsonBody`. That does not touch the loop.
- Produces (behavior contracts; signatures unchanged):
  - `findRecyclableItems(listId: string, searchText: string): Promise<RecyclableItem[]>` logs `[ItemRecycler] Recyclable items read failed:` with `{ listId }` and the error, then throws `Error("Recyclable items read failed", { cause })`.
  - `findFuzzyMatch(listId, text)`: when the RPC fails, its ILIKE fallback now rejects instead of returning `[]` if that read fails too. T5 (voice) must expect a rejection.
  - `recycleItem(itemId: string, userId: string, listId: string): Promise<RecyclableItem | null>` throws (after logging) `Error("Recycle item lookup failed")`, `Error("Max position read failed")` or `Error("Recycle update failed")`. It resolves `null` only when the row is genuinely not in this list, or is gone by the time of the update. T5 (voice) must stop treating "no throw" as success without checking for `null`.
  - `fakeSupabase` chains gain `.ilike(k, v)`, recorded as the filter `` `ilike:${k}=${v}` ``.

**Sites:**

| site (as of today) | today on failure | change | user-visible result |
|---|---|---|---|
| `src/services/item-recycler.ts:36` (findRecyclableItems ILIKE read) | The error is ignored and it returns `[]`. The batch add then creates a duplicate instead of recycling | Log and throw | No duplicate item. The item is skipped and logged |
| `src/services/item-recycler.ts:66` (recycleItem lookup) | The error is ignored and it returns null, so the caller inserts a duplicate | `.maybeSingle()`, then log and throw on error. null only for a missing row | No duplicate |
| `src/services/item-recycler.ts:76` (recycleItem max-position read) | The error is ignored and position falls back to 1 (bottom of the list) | Log and throw before the update | The item is never recycled to the bottom |
| `src/services/item-recycler.ts:85` (recycleItem update) | `error` is folded into `return null` with no log, so the caller inserts a duplicate | `.maybeSingle()`. On error, log and throw. null only when the row matched nothing | No duplicate, and the cause is logged |
| `app/api/lists/[id]/items/route.ts:247-263` (batch loop) | Uncaught today (it never throws), so with the new throws the whole request would 500 midway | Wrap the recyclable lookup and the recycle in try/catch. On a throw, log and `continue` (skip the item), the loop's existing rule for an RPC error | The other items are still added. The failed one is not duplicated |
| `src/services/categorize-list.ts:245` (list-type read) | The error reads as "not grocery" and it returns with no log | On `error`, log `[Categorizer] could not read the list type` and return | None (self-heals on the next trigger). Now traceable |
| `src/utils/categorize-lock.ts:36` (release eval result) | A 0 result (the lock expired mid-run) is discarded | When eval returns 0, `console.warn` that the lock expired before release | None. Overlapping runs now leave a trace |

Extra site found in these files: `findFuzzyMatch` (`item-recycler.ts:127`) falls back to `findRecyclableItems`, so it inherits the throw. No code change there, and a test is added. Already handled, so not changed: `findFuzzyMatch`'s own RPC error (`:124`, logged) and `categorize-list.ts:75/86/96/107/173/200` (all checked). In `categorize-lock.ts`, the lock's other calls (`acquire`, `requestRerun`, `takeRerun`) return values that are already used or are catch-logged.

- [ ] **Step 1: write the failing tests**

`__tests__/helpers/fake-supabase.ts`: add one filter method after the `c.in = ...` line:

```ts
    c.ilike = (k: string, v: unknown) => add(`ilike:${k}=${v}`);
```

Create `__tests__/unit/item-recycler.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

const h = vi.hoisted(() => ({
  fake: null as unknown as {
    client: unknown;
    calls: { table: string; op: string; values?: unknown; cols?: string; filters: string[] }[];
  },
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));

import { findRecyclableItems, recycleItem, findFuzzyMatch } from "@/src/services/item-recycler";

// PostgREST answers .single() on zero rows with PGRST116; .maybeSingle() answers null.
const NO_ROW = { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" };
const dbErr = { message: "canceling statement due to statement timeout", code: "57014" };
const milk = { id: "i1", text: "milk", completed: true, completed_at: "2026-10-01T00:00:00Z", deleted_at: null, position: 3 };
const ok = (data: unknown): FakeResult => ({ data, error: null });
const err = (): FakeResult => ({ data: null, error: dbErr });

// What each read or write of the recycler answers; a key left out answers like an empty table.
type World = { search?: FakeResult; lookup?: FakeResult; maxPos?: FakeResult; update?: FakeResult; fuzzy?: FakeResult };
function use(w: World) {
  h.fake = fakeSupabase((c: FakeCall): FakeResult => {
    const pick = (r: FakeResult | undefined, empty: unknown): FakeResult => {
      const res = r ?? { data: empty, error: null };
      return res.data == null && !res.error && c.filters.includes("single") ? { data: null, error: NO_ROW } : res;
    };
    if (c.op === "rpc") return pick(w.fuzzy, []);
    if (c.op === "update") return pick(w.update, null);
    if (c.filters.some((f) => f.startsWith("ilike:"))) return pick(w.search, []);
    if (c.cols === "list_id") return pick(w.lookup, null);
    if (c.cols === "position") return pick(w.maxPos, []);
    return { data: null, error: null };
  }) as typeof h.fake;
}
const updates = () => h.fake.calls.filter((c) => c.op === "update");

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("findRecyclableItems", () => {
  it("returns the completed matches", async () => {
    use({ search: ok([milk]) });
    expect(await findRecyclableItems("L", "milk")).toEqual([milk]);
  });

  it("rejects and logs on a failed read, instead of answering 'no match' (which creates a duplicate)", async () => {
    use({ search: err() });
    await expect(findRecyclableItems("L", "milk")).rejects.toThrow("Recyclable items read failed");
    expect(console.error).toHaveBeenCalledWith("[ItemRecycler] Recyclable items read failed:", { listId: "L" }, dbErr);
  });
});

describe("findFuzzyMatch", () => {
  it("rejects when the fuzzy RPC fails and its ILIKE fallback fails too", async () => {
    use({ fuzzy: err(), search: err() });
    await expect(findFuzzyMatch("L", "milk")).rejects.toThrow("Recyclable items read failed");
  });
});

describe("recycleItem", () => {
  it("moves the item to the top and returns it", async () => {
    use({
      lookup: ok({ list_id: "L" }),
      maxPos: ok([{ position: 7 }]),
      update: ok({ ...milk, completed: false, completed_at: null, position: 8 }),
    });
    expect(await recycleItem("i1", "u1", "L")).toMatchObject({ id: "i1", position: 8 });
    expect(updates()[0].values).toMatchObject({ completed: false, position: 8, created_by: "u1" });
    expect(updates()[0].filters).toEqual(expect.arrayContaining(["eq:id=i1", "eq:list_id=L"]));
  });

  it("returns null, without logging, for an item that is not in this list", async () => {
    use({ lookup: ok(null) });
    expect(await recycleItem("i1", "u1", "L")).toBeNull();
    expect(updates()).toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("rejects and logs when the lookup fails, and writes nothing", async () => {
    use({ lookup: err() });
    await expect(recycleItem("i1", "u1", "L")).rejects.toThrow("Recycle item lookup failed");
    expect(console.error).toHaveBeenCalledWith("[ItemRecycler] Item lookup failed:", { listId: "L", itemId: "i1" }, dbErr);
    expect(updates()).toEqual([]);
  });

  it("rejects when the max-position read fails, instead of recycling to position 1", async () => {
    use({ lookup: ok({ list_id: "L" }), maxPos: err() });
    await expect(recycleItem("i1", "u1", "L")).rejects.toThrow("Max position read failed");
    expect(console.error).toHaveBeenCalledWith("[ItemRecycler] Max position read failed:", { listId: "L" }, dbErr);
    expect(updates()).toEqual([]);
  });

  it("rejects and logs when the update fails", async () => {
    use({ lookup: ok({ list_id: "L" }), maxPos: ok([{ position: 7 }]), update: err() });
    await expect(recycleItem("i1", "u1", "L")).rejects.toThrow("Recycle update failed");
    expect(console.error).toHaveBeenCalledWith("[ItemRecycler] Recycle update failed:", { listId: "L", itemId: "i1" }, dbErr);
  });

  it("returns null, without logging, when the row is gone by the time of the update", async () => {
    use({ lookup: ok({ list_id: "L" }), maxPos: ok([{ position: 7 }]), update: ok(null) });
    expect(await recycleItem("i1", "u1", "L")).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });
});
```

Create `__tests__/unit/items-post-recycle-failure.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
  find: vi.fn(),
  recycle: vi.fn(),
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "owner" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));
vi.mock("@/src/services/categorize-list", () => ({ categorizeList: async () => {} }));
vi.mock("@/src/services/item-recycler", () => ({ findRecyclableItems: h.find, recycleItem: h.recycle }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: () => {},
}));

import { POST } from "@/app/api/lists/[id]/items/route";

const OLD = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e01";
const params = { params: Promise.resolve({ id: "L" }) };
const req = (body: unknown) =>
  new NextRequest("https://app.test/api/lists/L/items", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
const completedMilk = { id: OLD, text: "milk", completed: true, completed_at: "2026-10-01T00:00:00Z", deleted_at: null, position: 2 };
const inserted = () => h.fake.calls.filter((c) => c.op === "rpc").map((c) => (c.values as { p_text: string }).p_text);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.find.mockReset().mockResolvedValue([]);
  h.recycle.mockReset().mockResolvedValue(null);
  // The max-position read finds an empty list; the insert RPC echoes the row it was asked for.
  h.fake = fakeSupabase((c: FakeCall): FakeResult => {
    if (c.op === "rpc") {
      const v = c.values as { p_text: string; p_position: number };
      return { data: [{ id: `new-${v.p_text}`, text: v.p_text, position: v.p_position }], error: null };
    }
    return { data: [], error: null };
  }) as typeof h.fake;
});

describe("POST items (batch): a failed recycle check skips the item and never inserts a duplicate", () => {
  it("skips an item whose recyclable lookup fails, logs it, and still adds the rest", async () => {
    const boom = new Error("Recyclable items read failed");
    h.find.mockImplementation(async (_listId: string, text: string) => {
      if (text === "milk") throw boom;
      return [];
    });
    const res = await POST(req({ text: "milk, eggs" }), params);
    expect(res.status).toBe(201);
    expect(inserted()).toEqual(["eggs"]);
    expect((await res.json()).items.map((i: { text: string }) => i.text)).toEqual(["eggs"]);
    expect(console.error).toHaveBeenCalledWith("[items/POST] Recycle check failed, skipping item (batch):", { listId: "L" }, boom);
  });

  it("skips the item when the recycle itself fails, instead of inserting a new copy", async () => {
    const boom = new Error("Recycle update failed");
    h.find.mockResolvedValue([completedMilk]);
    h.recycle.mockRejectedValue(boom);
    const res = await POST(req({ text: "milk", recycleId: OLD }), params);
    expect(res.status).toBe(201);
    expect(h.recycle).toHaveBeenCalledWith(OLD, "u1", "L");
    expect(inserted()).toEqual([]);
    expect((await res.json()).items).toEqual([]);
    expect(console.error).toHaveBeenCalledWith("[items/POST] Recycle check failed, skipping item (batch):", { listId: "L" }, boom);
  });

  it("returns the recycled row when the recycle succeeds", async () => {
    h.find.mockResolvedValue([completedMilk]);
    h.recycle.mockResolvedValue({ ...completedMilk, completed: false, completed_at: null, position: 9 });
    const res = await POST(req({ text: "milk", recycleId: OLD }), params);
    expect(inserted()).toEqual([]);
    expect((await res.json()).items).toEqual([expect.objectContaining({ id: OLD, recycled: true })]);
  });

  it("inserts a new item when the item to recycle is genuinely gone (recycleItem answers null)", async () => {
    h.find.mockResolvedValue([completedMilk]);
    h.recycle.mockResolvedValue(null);
    const res = await POST(req({ text: "milk", recycleId: OLD }), params);
    expect(res.status).toBe(201);
    expect(inserted()).toEqual(["milk"]);
  });
});
```

`__tests__/unit/categorize-list.test.ts`:
- In the `world(opts: { ... })` option type, add after `listDeleted?: boolean;`:

```ts
  failListRead?: boolean; // the list-type read that opens categorizeList
```

- In the `fakeSupabase((call: FakeCall) => { ... })` resolver, add this line immediately before `if (call.table === "lists" && opts.listDeleted)`:

```ts
    if (call.table === "lists" && call.cols === "type" && opts.failListRead) return { data: null, error: dbError };
```

- Add this test right after the existing `it("does nothing for a deleted grocery list", ...)`:

```ts
  it("logs and stops when the list-type read fails", async () => {
    const w = world({ failListRead: true, items: [row({ id: "a", text: "milk" })] });
    await categorizeList(w.deps, "L", "pending");
    expect(w.lock.acquire).not.toHaveBeenCalled();
    expect(w.categorizer.categorize).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "[Categorizer] could not read the list type",
      expect.objectContaining({ listId: "L", mode: "pending", error: expect.objectContaining({ message: "fetch failed" }) })
    );
  });
```

`__tests__/unit/categorize-lock.test.ts`:
- In `beforeEach`, add after the `console.error` spy:

```ts
  vi.spyOn(console, "warn").mockImplementation(() => {});
```

- Append inside `describe("redisListLock", ...)`, after the last `it`:

```ts
  it("release warns when the lock expired during the run, so overlapping runs leave a trace", async () => {
    const first = (await redisListLock.acquire("L"))!;
    h.store.delete(KEY); // expired during a slow round
    await redisListLock.acquire("L"); // another run takes it
    await redisListLock.release("L", first);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("expired before release"), { listId: "L" });
  });

  it("release of a lock it still holds does not warn", async () => {
    const token = (await redisListLock.acquire("L"))!;
    await redisListLock.release("L", token);
    expect(console.warn).not.toHaveBeenCalled();
  });
```

(The existing eval mock already returns 0 or 1, so it needs no change.)

- [ ] **Step 2: run them, expect FAIL**

```bash
npx vitest run __tests__/unit/item-recycler.test.ts __tests__/unit/items-post-recycle-failure.test.ts __tests__/unit/categorize-list.test.ts __tests__/unit/categorize-lock.test.ts
```

Expected failures, and why:
- item-recycler, "rejects and logs on a failed read" and findFuzzyMatch "rejects": today they resolve `[]`.
- item-recycler, "rejects ... lookup fails" and "rejects and logs when the update fails": today they resolve `null`.
- item-recycler, "rejects when the max-position read fails": today the recycle goes on to position 1. The fake's update default (no row with `.single()`, so PGRST116) makes it resolve `null`.
- items-post-recycle-failure, the two "skips ..." tests: with the recycler mock throwing, POST rejects, because today's loop has no catch.
- categorize-list, "logs and stops when the list-type read fails": today it returns silently and nothing is logged.
- categorize-lock, "release warns when the lock expired": today the eval result is discarded.

The other new tests pass today as regression guards.

- [ ] **Step 3: implementation**

`src/services/item-recycler.ts`. Current (lines 35-46):

```ts
  // Search completed items (not deleted)
  const { data: completedItems } = await supabase
    .from("items")
    .select("id, text, completed, completed_at, deleted_at, position")
    .eq("list_id", listId)
    .ilike("text", `%${escapeIlike(canonical)}%`)
    .eq("completed", true)
    .is("deleted_at", null)
    .order("completed_at", { ascending: false, nullsFirst: false })
    .limit(10);

  return (completedItems || []) as RecyclableItem[];
```

Replacement:

```ts
  // Search completed items (not deleted)
  const { data: completedItems, error } = await supabase
    .from("items")
    .select("id, text, completed, completed_at, deleted_at, position")
    .eq("list_id", listId)
    .ilike("text", `%${escapeIlike(canonical)}%`)
    .eq("completed", true)
    .is("deleted_at", null)
    .order("completed_at", { ascending: false, nullsFirst: false })
    .limit(10);

  // Throw rather than answer []: "no match" makes callers create a duplicate.
  if (error) {
    console.error("[ItemRecycler] Recyclable items read failed:", { listId }, error);
    throw new Error("Recyclable items read failed", { cause: error });
  }

  return (completedItems || []) as RecyclableItem[];
```

Current (lines 49-103, the whole `recycleItem`):

```ts
/**
 * Recycle an item — restore it to active state.
 * Sets completed=false, completed_at=null, deleted_at=null,
 * and position to MAX(position)+1 (top of list).
 */
export async function recycleItem(
  itemId: string,
  userId: string,
  listId: string
): Promise<RecyclableItem | null> {
  const supabase = createServerClient();

  // Get the item's list to find max position. Scoped to listId (defence in depth):
  // callers are expected to have already validated itemId against a list-scoped
  // lookup (see pickRecyclable), but this guard means a cross-list id can never
  // reach the update below even if that validation is skipped or forgotten by a
  // future caller.
  const { data: item } = await supabase
    .from("items")
    .select("list_id")
    .eq("id", itemId)
    .eq("list_id", listId)
    .single();

  if (!item) return null;

  // Get max position
  const { data: maxPosResult } = await supabase
    .from("items")
    .select("position")
    .eq("list_id", item.list_id)
    .order("position", { ascending: false })
    .limit(1);

  const nextPosition = (maxPosResult?.[0]?.position || 0) + 1;

  const { data: recycled, error } = await supabase
    .from("items")
    .update({
      completed: false,
      completed_at: null,
      deleted_at: null,
      skipped_at: null,
      ordered_at: null,
      position: nextPosition,
      created_by: userId,
    })
    .eq("id", itemId)
    .eq("list_id", listId)
    .select("id, text, completed, completed_at, deleted_at, position")
    .single();

  if (error || !recycled) return null;
  return recycled as RecyclableItem;
}
```

Replacement:

```ts
/**
 * Recycle an item — restore it to active state.
 * Sets completed=false, completed_at=null, deleted_at=null,
 * and position to MAX(position)+1 (top of list).
 * Returns null only when the item is not (or no longer) in this list. A failed read or
 * write is logged and thrown, so a caller never mistakes it for "nothing to recycle".
 */
export async function recycleItem(
  itemId: string,
  userId: string,
  listId: string
): Promise<RecyclableItem | null> {
  const supabase = createServerClient();

  // Get the item's list to find max position. Scoped to listId (defence in depth):
  // callers are expected to have already validated itemId against a list-scoped
  // lookup (see pickRecyclable), but this guard means a cross-list id can never
  // reach the update below even if that validation is skipped or forgotten by a
  // future caller.
  const { data: item, error: lookupError } = await supabase
    .from("items")
    .select("list_id")
    .eq("id", itemId)
    .eq("list_id", listId)
    .maybeSingle();

  if (lookupError) {
    console.error("[ItemRecycler] Item lookup failed:", { listId, itemId }, lookupError);
    throw new Error("Recycle item lookup failed", { cause: lookupError });
  }
  if (!item) return null;

  // Get max position
  const { data: maxPosResult, error: maxPosError } = await supabase
    .from("items")
    .select("position")
    .eq("list_id", item.list_id)
    .order("position", { ascending: false })
    .limit(1);

  if (maxPosError) {
    console.error("[ItemRecycler] Max position read failed:", { listId }, maxPosError);
    throw new Error("Max position read failed", { cause: maxPosError });
  }

  const nextPosition = (maxPosResult?.[0]?.position || 0) + 1;

  const { data: recycled, error } = await supabase
    .from("items")
    .update({
      completed: false,
      completed_at: null,
      deleted_at: null,
      skipped_at: null,
      ordered_at: null,
      position: nextPosition,
      created_by: userId,
    })
    .eq("id", itemId)
    .eq("list_id", listId)
    .select("id, text, completed, completed_at, deleted_at, position")
    .maybeSingle();

  if (error) {
    console.error("[ItemRecycler] Recycle update failed:", { listId, itemId }, error);
    throw new Error("Recycle update failed", { cause: error });
  }
  // The row went away between the lookup and the update.
  if (!recycled) return null;
  return recycled as RecyclableItem;
}
```

(Both `.eq("list_id", listId)` scopes stay, so `recycle-scoping.test.ts` stays green.)

`app/api/lists/[id]/items/route.ts`. Import line, current:

```ts
import { findRecyclableItems, recycleItem } from "@/src/services/item-recycler";
```

Replacement:

```ts
import { findRecyclableItems, recycleItem, type RecyclableItem } from "@/src/services/item-recycler";
```

Batch loop, current (inside `for (const text of itemTexts) {`, after the `limitReached` guard):

```ts
    // Check for recyclable items
    const recyclable = await findRecyclableItems(listId, text);
    const exactMatch = recyclable.find(
      (r) => normalizeForCompare(r.text) === normalizeForCompare(text)
    );

    // Explicit recycle request from UI autocomplete. The client-supplied recycleId is
    // never trusted directly — it must resolve against `recyclable`, the set the server
    // itself just looked up for this list (list-scoped, completed-only). Otherwise a
    // client could pass any uuid and recycleItem would resurrect/re-attribute an
    // arbitrary row in someone else's list.
    const toRecycle = exactMatch && pickRecyclable(recyclable, parsedCreate.data.recycleId);
    if (toRecycle) {
      const recycled = await recycleItem(toRecycle.id, auth.userId, listId);
      if (recycled) {
        results.push({ ...recycled, recycled: true });
        continue;
      }
    }
```

Replacement:

```ts
    // Check for recyclable items. The recycler logs and throws on a DB error. Skip the
    // item then, the loop's rule for an insert error, so a failed check never adds a duplicate.
    let recycled: RecyclableItem | null = null;
    try {
      const recyclable = await findRecyclableItems(listId, text);
      const exactMatch = recyclable.find(
        (r) => normalizeForCompare(r.text) === normalizeForCompare(text)
      );

      // Explicit recycle request from UI autocomplete. The client-supplied recycleId is
      // never trusted directly — it must resolve against `recyclable`, the set the server
      // itself just looked up for this list (list-scoped, completed-only). Otherwise a
      // client could pass any uuid and recycleItem would resurrect/re-attribute an
      // arbitrary row in someone else's list.
      const toRecycle = exactMatch && pickRecyclable(recyclable, parsedCreate.data.recycleId);
      if (toRecycle) recycled = await recycleItem(toRecycle.id, auth.userId, listId);
    } catch (err) {
      console.error("[items/POST] Recycle check failed, skipping item (batch):", { listId }, err);
      continue;
    }
    if (recycled) {
      results.push({ ...recycled, recycled: true });
      continue;
    }
```

Everything after it (the `insert_item_if_under_limit` RPC and its error handling) is unchanged. There is exactly one `recycleItem(` call and its first argument is still `toRecycle.id`, so `recycle-scoping.test.ts` stays green. Item text is never logged.

`src/services/categorize-list.ts`. Current (inside `categorizeList`):

```ts
    const { data: list } = await full.supabase
      .from("lists")
      .select("type")
      .eq("id", listId)
      .is("deleted_at", null)
      .maybeSingle();
    if ((list as { type?: string } | null)?.type !== "grocery") return;
```

Replacement:

```ts
    const { data: list, error } = await full.supabase
      .from("lists")
      .select("type")
      .eq("id", listId)
      .is("deleted_at", null)
      .maybeSingle();
    // A failed read is not "not a grocery list": log it. The next trigger or GET sweep retries.
    if (error) {
      console.error("[Categorizer] could not read the list type", { listId, mode, error });
      return;
    }
    if ((list as { type?: string } | null)?.type !== "grocery") return;
```

(`error` does not clash with the outer `catch (error)`, which is a separate scope.)

`src/utils/categorize-lock.ts`. Current:

```ts
  async release(listId, token) {
    try { await getRedis().eval(RELEASE_SCRIPT, [lockKey(listId)], [token]); } catch (error) {
      console.error("[Categorizer] lock release error, it will expire on its own:", { listId }, error);
    }
  },
```

Replacement:

```ts
  async release(listId, token) {
    try {
      // 0: the key no longer holds our token, so the lock expired mid-run and another run may have taken it.
      const released = await getRedis().eval(RELEASE_SCRIPT, [lockKey(listId)], [token]);
      if (released === 0) {
        console.warn("[Categorizer] lock expired before release, another run may have overlapped:", { listId });
      }
    } catch (error) {
      console.error("[Categorizer] lock release error, it will expire on its own:", { listId }, error);
    }
  },
```

- [ ] **Step 4: update existing tests and mocks that break**

- `__tests__/helpers/fake-supabase.ts`: the `.ilike` addition from Step 1. Without it, the real `findRecyclableItems` crashes on the fake.
- `__tests__/unit/categorize-lock.test.ts`: the `console.warn` spy from Step 1. The existing "a holder whose lock expired cannot release ..." test now warns, and the spy keeps output clean. Its assertions are unchanged.
- No other test reaches the real recycler or the real list-type read. `items-route-categorize.test.ts` and `items-completion-no-reminders.test.ts` mock `@/src/services/item-recycler` with `recycleItem: async () => null` and `findRecyclableItems: async () => []`. Those still match the contract (null is a missing row), so they need no edit. The categorize-list `world()` lists branch already returns `error: null`.

- [ ] **Step 5: run tests, expect PASS**

```bash
npx vitest run __tests__/unit/item-recycler.test.ts __tests__/unit/items-post-recycle-failure.test.ts __tests__/unit/categorize-list.test.ts __tests__/unit/categorize-lock.test.ts __tests__/unit/items-route-categorize.test.ts __tests__/unit/items-completion-no-reminders.test.ts __tests__/unit/recycle-scoping.test.ts __tests__/unit/no-silent-catches.test.ts
npx tsc --noEmit
npx eslint src/services/item-recycler.ts "app/api/lists/[id]/items/route.ts" src/services/categorize-list.ts src/utils/categorize-lock.ts __tests__/helpers/fake-supabase.ts __tests__/unit/item-recycler.test.ts __tests__/unit/items-post-recycle-failure.test.ts __tests__/unit/categorize-list.test.ts __tests__/unit/categorize-lock.test.ts
```

- [ ] **Step 6: make it bite.** Make each change below by itself, run the test named, confirm it goes red, then restore.
1. Delete the `if (error) { ... throw ... }` block in `findRecyclableItems`. Both "rejects and logs on a failed read" and findFuzzyMatch "rejects when ... fallback fails too" go red.
2. Delete the `if (lookupError)` block in `recycleItem`. "rejects and logs when the lookup fails" goes red.
3. In the lookup, change `.maybeSingle()` to `.single()`. "returns null, without logging, for an item that is not in this list" goes red: it throws.
4. Delete the `if (maxPosError)` block. "rejects when the max-position read fails" goes red.
5. Delete the `if (error)` block after the update. "rejects and logs when the update fails" goes red.
6. In the update, change `.maybeSingle()` to `.single()`. "returns null, without logging, when the row is gone by the time of the update" goes red.
7. In the items route, remove the `try { ... } catch (err) { ...; continue; }` wrapper, keeping its body. Both "skips ..." tests in items-post-recycle-failure go red: POST rejects.
8. In the catch, replace `continue;` with nothing, so the code falls through to the insert. "skips the item when the recycle itself fails" goes red: `inserted()` is `["milk"]`.
9. Delete the `if (error) { console.error(...); return; }` block in `categorizeList`. "logs and stops when the list-type read fails" goes red.
10. Delete the `if (released === 0) { console.warn(...) }` block. "release warns when the lock expired during the run" goes red.

- [ ] **Step 7: commit**

```bash
git add src/services/item-recycler.ts "app/api/lists/[id]/items/route.ts" src/services/categorize-list.ts src/utils/categorize-lock.ts __tests__/helpers/fake-supabase.ts __tests__/unit/item-recycler.test.ts __tests__/unit/items-post-recycle-failure.test.ts __tests__/unit/categorize-list.test.ts __tests__/unit/categorize-lock.test.ts
git commit -m "$(cat <<'EOF'
fix(items): recycler failures never pass as "no match"

findRecyclableItems and recycleItem log and throw on a failed read or
write instead of answering []/null, so a DB blip can no longer create a
duplicate or recycle an item to position 1. The batch add skips and logs
an item whose recycle check fails, the rule it already uses for an insert
error. categorizeList logs a failed list-type read, and the categorize
lock warns when it expired before release.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
)"
```

### Task 3a: Home-screen, user and share route reads and writes

Group 2, part 1: `GET/POST/PATCH/DELETE /api/lists`, `/api/user`, `GET /api/share`. Each database call reads its `error`. A real failure returns a logged `dbError(...)` 500, checked before any not-found branch. Where "no row" is a normal answer, `.single()` becomes `.maybeSingle()`, so `error` only ever means a real failure.

**Runs after T1 and T2.** T1 has already created `src/lib/api-errors.ts`. In these files it has also replaced `await request.json()` with `await readJsonBody(request, "<tag>")` and changed the `api-validation` import. In `app/api/share/route.ts`, T1 has also given POST a schema. None of the snippets below touch those lines. Anchor every edit on the code shown, not on line numbers.

**Files:**
- Modify: `app/api/lists/route.ts`
- Modify: `app/api/user/route.ts`
- Modify: `app/api/share/route.ts`
- Create (test): `__tests__/unit/lists-route-db-errors.test.ts`
- Create (test): `__tests__/unit/user-route-db-errors.test.ts`
- Create (test): `__tests__/unit/share-route-db-errors.test.ts`
- Re-run, unchanged: `__tests__/unit/lists-route-categorize.test.ts`, `__tests__/unit/user-update.test.ts`, `__tests__/unit/no-silent-catches.test.ts`

**Interfaces:**
- Consumes (T1, `src/lib/api-errors.ts`): `export function dbError(tag: string, what: string, error: unknown, ctx?: Record<string, unknown>): NextResponse`. It logs `console.error(\`[${tag}] ${what} failed:\`, ctx, error)` and returns `NextResponse.json({ error: \`${what} failed\` }, { status: 500 })`.
- Produces: nothing new. Route response shapes are unchanged except that a failure now returns 500. Log tags used: `lists/GET`, `lists/POST`, `lists/PATCH`, `lists/DELETE`, `user/GET`, `user/POST`, `user/PATCH`, `share/GET`.

**Sites:**

| site (as of f441470) | today on failure | change | user-visible result |
|---|---|---|---|
| app/api/lists/route.ts:21 owned lists | error ignored; 200 without the user's own lists | `error: ownedError`, `dbError("lists/GET","Owned lists read",…,{userId})` | home shows the existing "Couldn't load your lists" + Retry instead of missing lists |
| app/api/lists/route.ts:29 collaborator rows | error ignored; shared lists vanish | `dbError("lists/GET","Collaborator rows read",…)` | Retry screen |
| app/api/lists/route.ts:39 shared lists | error ignored; shared lists vanish | `dbError("lists/GET","Shared lists read",…)` | Retry screen |
| app/api/lists/route.ts:59 item counts RPC | error ignored; every count 0 | `dbError("lists/GET","Item counts read",…)` | Retry screen |
| app/api/lists/route.ts:75 is_shared rows | error ignored; badges missing | `console.warn("[lists/GET] Shared badges read failed, showing none:", {userId}, err)` and continue | unchanged (badge missing for one load), now logged |
| app/api/lists/route.ts:90 user_list_state | error ignored; archived lists back in Active, order lost | `dbError("lists/GET","List state read",…)` | Retry screen |
| app/api/lists/route.ts:148 50-list count | error ignored; cap bypassed | `dbError("lists/POST","List count read",…)` before the insert | create is refused (500) instead of skipping the cap |
| app/api/lists/route.ts:201 restore owner check | `.single()`, error ignored → 403 | `.maybeSingle()` + `dbError("lists/PATCH","Owner check",…,{listId,userId})` | 500 on DB error; 403 only for no row / not owner |
| app/api/lists/route.ts:223 restore write | unlogged 500 | `dbError("lists/PATCH","Restore",…,{listId})` | same 500, now logged |
| app/api/lists/route.ts:240 edit owner check | `.single()`, error ignored → 403 | `.maybeSingle()` + `dbError("lists/PATCH","Owner check",…)` | 500 on DB error (T7 shows the toast) |
| app/api/lists/route.ts:272 edit write | unlogged 500 | `dbError("lists/PATCH","Update",…,{listId})` | same 500, logged |
| app/api/lists/route.ts:298 delete owner check | `.single()`, error ignored → 403 | `.maybeSingle()` + `dbError("lists/DELETE","Owner check",…)` | 500 on DB error |
| app/api/lists/route.ts:319 delete write | unlogged 500 | `dbError("lists/DELETE","Delete",…,{listId})` | same 500, logged |
| app/api/user/route.ts:21 GET | `error \|\| !user` → unlogged 404 | `.maybeSingle()`; `dbError("user/GET","User read",…,{userId})`; 404 only for no row | no client calls GET /api/user today; logs only |
| app/api/user/route.ts:54 POST lookup | `.single()`, error ignored → falls into INSERT → unique violation 500 with a misleading log | `.maybeSingle()` + `dbError("user/POST","User lookup",…,{telegramId})` before any write | same failed boot, but the real cause is logged and no doomed INSERT runs |
| app/api/user/route.ts:128 PATCH | unlogged 500 | `dbError("user/PATCH","Update",…,{userId})` | same 500, logged (T7 handles the client) |
| app/api/share/route.ts:31 collaborators | error ignored; 200 with `[]` | `dbError("share/GET","Collaborators read",…,{listId})` | ShareDialog gets a 500 (T7 shows errors.generic inline) instead of a false empty list |
| app/api/share/route.ts:37 active link | error ignored; `activeLink: null` | `dbError("share/GET","Active link read",…,{listId})` | same as above |

- [ ] **Step 1: Write the failing tests**

Create `__tests__/unit/lists-route-db-errors.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

// Runs the real /api/lists handlers; auth, the rate limiter and Supabase are faked.
const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({ verifyUserAuth: async () => ({ success: true, userId: "u1" }) }));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));
vi.mock("@/src/services/categorize-list", () => ({ categorizeList: async () => {} }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => {} }));

import { GET, POST, PATCH, DELETE } from "@/app/api/lists/route";

const LIST = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e02";
const boom = { code: "57014", message: "canceling statement due to statement timeout" };

// PostgREST's answer to a read that matches no row: .single() reports PGRST116, .maybeSingle() null.
const noRow = (c: FakeCall): FakeResult =>
  c.filters.includes("single")
    ? { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } }
    : { data: null, error: null };

function use(resolve: (c: FakeCall) => FakeResult) {
  h.fake = fakeSupabase(resolve) as typeof h.fake;
}
const calls = (table: string, op: string) => h.fake.calls.filter((c) => c.table === table && c.op === op);
const json = (method: string, body: unknown) =>
  new NextRequest("https://app.test/api/lists", {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(console.error).mockClear();
  vi.mocked(console.warn).mockClear();
});

// The home screen is built from six reads: the user's lists, their collaborator rows, the
// lists shared with them, item counts, which owned lists are shared, and their per-user state.
type Read = "owned" | "collaborators" | "sharedLists" | "counts" | "sharedFlags" | "state";
const row = (id: string, owner: string) => ({
  id, name: id, owner_id: owner, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z",
  type: "regular", icon: null, color: null,
});
const answers: Record<Read, unknown> = {
  owned: [row("O1", "u1")],
  collaborators: [{ list_id: "S1", permission: "edit" }],
  sharedLists: [row("S1", "u2")],
  counts: [
    { list_id: "O1", active_count: "3", completed_count: "1" },
    { list_id: "S1", active_count: "2", completed_count: "0" },
  ],
  sharedFlags: [{ list_id: "O1" }],
  state: [],
};
function readOf(c: FakeCall): Read {
  if (c.table === "get_list_item_counts") return "counts";
  if (c.table === "user_list_state") return "state";
  if (c.table === "lists") return c.filters.includes("eq:owner_id=u1") ? "owned" : "sharedLists";
  return c.filters.includes("eq:user_id=u1") ? "collaborators" : "sharedFlags";
}
function home(fail?: Read) {
  use((c) => {
    const read = readOf(c);
    return read === fail ? { data: null, error: boom } : { data: answers[read], error: null };
  });
}
type HomeList = { id: string; role: string; is_shared: boolean; active_count: number; completed_count: number };
const getLists = async () => {
  const res = await GET(new NextRequest("https://app.test/api/lists"));
  return { res, body: res.status === 200 ? ((await res.json()) as HomeList[]) : [] };
};

describe("GET /api/lists", () => {
  it("answers every list with its counts and shared badge when all reads succeed", async () => {
    home();
    const { res, body } = await getLists();
    expect(res.status).toBe(200);
    expect(body.map((l) => l.id).sort()).toEqual(["O1", "S1"]);
    expect(body.find((l) => l.id === "O1")).toMatchObject({ role: "owner", is_shared: true, active_count: 3, completed_count: 1 });
    expect(body.find((l) => l.id === "S1")).toMatchObject({ role: "edit", is_shared: true, active_count: 2 });
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([
    ["owned", "Owned lists read"],
    ["collaborators", "Collaborator rows read"],
    ["sharedLists", "Shared lists read"],
    ["counts", "Item counts read"],
    ["state", "List state read"],
  ] as const)("answers a logged 500, not a partial home screen, when the %s read fails", async (read, what) => {
    home(read);
    const { res } = await getLists();
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(`[lists/GET] ${what} failed:`, { userId: "u1" }, boom);
  });

  it("still answers 200 when only the shared-badge read fails, and warns", async () => {
    home("sharedFlags");
    const { res, body } = await getLists();
    expect(res.status).toBe(200);
    expect(body.find((l) => l.id === "O1")).toMatchObject({ is_shared: false, active_count: 3 });
    // A list shared with the user is shared by definition; it keeps its badge.
    expect(body.find((l) => l.id === "S1")).toMatchObject({ is_shared: true });
    expect(console.warn).toHaveBeenCalledWith("[lists/GET] Shared badges read failed, showing none:", { userId: "u1" }, boom);
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("POST /api/lists (50-list cap)", () => {
  const create = () => POST(json("POST", { name: "Groceries" }));

  it("refuses with a logged 500 and inserts nothing when the list count cannot be read", async () => {
    use((c) => c.op === "select"
      ? ({ data: null, error: boom, count: null } as FakeResult)
      : { data: { id: LIST, name: "Groceries" }, error: null });
    const res = await create();
    expect(res.status).toBe(500);
    expect(calls("lists", "insert")).toEqual([]);
    expect(console.error).toHaveBeenCalledWith("[lists/POST] List count read failed:", { userId: "u1" }, boom);
  });

  it("creates the list when the count is under the cap", async () => {
    use((c) => c.op === "select"
      ? ({ data: null, error: null, count: 3 } as FakeResult)
      : { data: { id: LIST, name: "Groceries" }, error: null });
    const res = await create();
    expect(res.status).toBe(201);
    expect(calls("lists", "insert")).toHaveLength(1);
  });
});

describe("owner checks on undo-delete, edit and delete", () => {
  const restore = () => PATCH(json("PATCH", { id: LIST, restore: true }));
  const rename = () => PATCH(json("PATCH", { id: LIST, name: "New name" }));
  const remove = () => DELETE(new NextRequest(`https://app.test/api/lists?id=${LIST}`, { method: "DELETE" }));
  const checks = [
    ["undo delete", restore, "lists/PATCH"],
    ["edit", rename, "lists/PATCH"],
    ["delete", remove, "lists/DELETE"],
  ] as const;

  it.each(checks)("%s answers a logged 500 and writes nothing when the owner check fails", async (_label, call, tag) => {
    use((c) => c.op === "select" ? { data: null, error: boom } : { data: { id: LIST }, error: null });
    const res = await call();
    expect(res.status).toBe(500);
    expect(calls("lists", "update")).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(`[${tag}] Owner check failed:`, { listId: LIST, userId: "u1" }, boom);
  });

  it.each(checks)("%s answers 403 and writes nothing when there is no such list", async (_label, call) => {
    use((c) => c.op === "select" ? noRow(c) : { data: { id: LIST }, error: null });
    const res = await call();
    expect(res.status).toBe(403);
    expect(calls("lists", "update")).toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(checks)("%s answers 403 and writes nothing for someone who is not the owner", async (_label, call) => {
    use((c) => c.op === "select" ? { data: { owner_id: "u2" }, error: null } : { data: { id: LIST }, error: null });
    expect((await call()).status).toBe(403);
    expect(calls("lists", "update")).toEqual([]);
  });

  it.each([
    ["undo delete", restore, "[lists/PATCH] Restore failed:"],
    ["edit", rename, "[lists/PATCH] Update failed:"],
    ["delete", remove, "[lists/DELETE] Delete failed:"],
  ] as const)("%s logs the failed write with its list id", async (_label, call, line) => {
    use((c) => c.op === "select" ? { data: { owner_id: "u1" }, error: null } : { data: null, error: boom });
    const res = await call();
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(line, { listId: LIST }, boom);
  });
});
```

Create `__tests__/unit/user-route-db-errors.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

// Runs the real /api/user handlers; auth, initData validation, the rate limiter and Supabase are faked.
const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
}));
vi.mock("@/src/lib/rate-limit", () => ({
  apiRateLimiter: {},
  checkRateLimit: async () => ({ success: true }),
  getRateLimitHeaders: () => ({}),
}));
vi.mock("@/src/lib/api-auth", () => ({ verifyUserAuth: async () => ({ success: true, userId: "u1" }) }));
vi.mock("@/src/lib/telegram-auth", () => ({
  validateInitData: () => ({ id: 42, first_name: "Dana", last_name: "Levi", username: "dana", language_code: "he" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));

import { GET, POST, PATCH } from "@/app/api/user/route";

const boom = { code: "57014", message: "canceling statement due to statement timeout" };
const noRow = (c: FakeCall): FakeResult =>
  c.filters.includes("single")
    ? { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } }
    : { data: null, error: null };
function use(resolve: (c: FakeCall) => FakeResult) {
  h.fake = fakeSupabase(resolve) as typeof h.fake;
}
const calls = (op: string) => h.fake.calls.filter((c) => c.table === "users" && c.op === op);
const register = () =>
  POST(new NextRequest("https://app.test/api/user", { method: "POST", headers: { "x-telegram-init-data": "signed" } }));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(console.error).mockClear();
});

describe("GET /api/user", () => {
  it("answers a logged 500, not 404, when the read fails", async () => {
    use(() => ({ data: null, error: boom }));
    const res = await GET(new NextRequest("https://app.test/api/user"));
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[user/GET] User read failed:", { userId: "u1" }, boom);
  });

  it("answers 404 when there is no user row", async () => {
    use(noRow);
    const res = await GET(new NextRequest("https://app.test/api/user"));
    expect(res.status).toBe(404);
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("POST /api/user", () => {
  it("answers a logged 500 and writes nothing when the lookup fails", async () => {
    use((c) => c.op === "select" ? { data: null, error: boom } : { data: { id: "u1" }, error: null });
    const res = await register();
    expect(res.status).toBe(500);
    expect(calls("insert")).toEqual([]);
    expect(calls("update")).toEqual([]);
    expect(console.error).toHaveBeenCalledWith("[user/POST] User lookup failed:", { telegramId: 42 }, boom);
  });

  it("registers a new user with their Telegram language when no row exists", async () => {
    use((c) => c.op === "select" ? noRow(c) : { data: { id: "u1" }, error: null });
    const res = await register();
    expect(res.status).toBe(200);
    expect(calls("update")).toEqual([]);
    expect(calls("insert")).toHaveLength(1);
    expect(calls("insert")[0].values).toMatchObject({ telegram_id: 42, name: "Dana Levi", username: "dana", language: "he" });
  });

  it("updates an existing user and inserts nothing", async () => {
    use(() => ({ data: { id: "u1", telegram_id: 42 }, error: null }));
    const res = await register();
    expect(res.status).toBe(200);
    expect(calls("insert")).toEqual([]);
    expect(calls("update")).toHaveLength(1);
  });
});

describe("PATCH /api/user", () => {
  it("logs the failed language save", async () => {
    use(() => ({ data: null, error: boom }));
    const res = await PATCH(new NextRequest("https://app.test/api/user", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language: "ru" }),
    }));
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[user/PATCH] Update failed:", { userId: "u1" }, boom);
  });
});
```

Create `__tests__/unit/share-route-db-errors.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

// Runs the real GET /api/share handler; auth, env, the rate limiter and Supabase are faked.
const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "owner" }),
}));
vi.mock("@/src/lib/env", () => ({ serverEnv: () => ({ NEXT_PUBLIC_BOT_USERNAME: "testbot" }) }));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));

import { GET } from "@/app/api/share/route";

const boom = { code: "57014", message: "canceling statement due to statement timeout" };
const collaborator = { id: "c1", user_id: "u2", permission: "edit", status: "pending", users: { name: "Dana", username: null } };
function use(resolve: (c: FakeCall) => FakeResult) {
  h.fake = fakeSupabase(resolve) as typeof h.fake;
}
const settings = () => GET(new NextRequest("https://app.test/api/share?listId=L"));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(console.error).mockClear();
});

describe("GET /api/share", () => {
  it("answers the collaborators and the active link when both reads succeed", async () => {
    use((c) => c.table === "collaborators"
      ? { data: [collaborator], error: null }
      : { data: [{ token: "tok", permission: "edit", expires_at: "2026-11-05T00:00:00Z" }], error: null });
    const res = await settings();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ collaborators: [collaborator], activeLink: "https://t.me/testbot?start=invite_tok" });
  });

  it.each([
    ["collaborators", "Collaborators read"],
    ["invite_links", "Active link read"],
  ])("answers a logged 500, not an empty share screen, when the %s read fails", async (table, what) => {
    use((c) => c.table === table ? { data: null, error: boom } : { data: [], error: null });
    const res = await settings();
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(`[share/GET] ${what} failed:`, { listId: "L" }, boom);
  });
});
```

- [ ] **Step 2: Run them. Expect them to FAIL**

Run: `npx vitest run __tests__/unit/lists-route-db-errors.test.ts __tests__/unit/user-route-db-errors.test.ts __tests__/unit/share-route-db-errors.test.ts`

Expected:
- **FAIL:** every "logged 500" case, the shared-badge warn case and every "logs the failed write" case.
  - GET returns 200 with a partial body. POST inserts and returns 201. The owner checks return 403. The user lookup falls into INSERT. Share returns 200. The existing 500s log nothing, so `console.error` was not called.
- **PASS already (guards):**
  - the GET happy path
  - POST under the cap
  - "403 when there is no such list" and "403 for a non-owner"
  - "registers a new user" and "updates an existing user"
  - user GET 404
  - the share happy path

- [ ] **Step 3: Implementation**

**`app/api/lists/route.ts`**

Imports. Add after the existing `import { parseBody… } from "@/src/lib/api-validation";` line (T1 will have changed that line to also import `readJsonBody`; leave it as T1 left it):
```ts
import { dbError } from "@/src/lib/api-errors";
```

GET, owned lists. Current:
```ts
  // Lists where user is owner
  const { data: ownedLists } = await supabase
    .from("lists")
    .select("id, name, owner_id, created_at, updated_at, type, icon, color")
    .eq("owner_id", auth.userId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });

  // Lists where user is approved collaborator
  const { data: collabRecords } = await supabase
    .from("collaborators")
    .select("list_id, permission")
    .eq("user_id", auth.userId)
    .eq("status", "approved");
```
Replacement:
```ts
  // Lists where user is owner
  const { data: ownedLists, error: ownedError } = await supabase
    .from("lists")
    .select("id, name, owner_id, created_at, updated_at, type, icon, color")
    .eq("owner_id", auth.userId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });
  // A partial home screen hides lists or shows wrong counts; the client's Retry screen is honest.
  if (ownedError) return dbError("lists/GET", "Owned lists read", ownedError, { userId: auth.userId });

  // Lists where user is approved collaborator
  const { data: collabRecords, error: collabError } = await supabase
    .from("collaborators")
    .select("list_id, permission")
    .eq("user_id", auth.userId)
    .eq("status", "approved");
  if (collabError) return dbError("lists/GET", "Collaborator rows read", collabError, { userId: auth.userId });
```

GET, shared lists. Current:
```ts
  if (collabListIds.length > 0) {
    const { data } = await supabase
      .from("lists")
      .select("id, name, owner_id, created_at, updated_at, type, icon, color")
      .in("id", collabListIds)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false });
    collabLists = data || [];
  }
```
Replacement:
```ts
  if (collabListIds.length > 0) {
    const { data, error: sharedListsError } = await supabase
      .from("lists")
      .select("id, name, owner_id, created_at, updated_at, type, icon, color")
      .in("id", collabListIds)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false });
    if (sharedListsError) return dbError("lists/GET", "Shared lists read", sharedListsError, { userId: auth.userId });
    collabLists = data || [];
  }
```

GET, counts. Current:
```ts
  if (listIds.length > 0) {
    const { data: counts } = await supabase.rpc("get_list_item_counts", {
      p_list_ids: listIds,
    });
    if (counts) {
```
Replacement:
```ts
  if (listIds.length > 0) {
    const { data: counts, error: countsError } = await supabase.rpc("get_list_item_counts", {
      p_list_ids: listIds,
    });
    if (countsError) return dbError("lists/GET", "Item counts read", countsError, { userId: auth.userId });
    if (counts) {
```

GET, shared badges (warn only). Current:
```ts
    const { data: sharedRows } = await supabase
      .from("collaborators")
      .select("list_id")
      .in("list_id", listIds)
      .eq("status", "approved");
    for (const row of sharedRows || []) {
```
Replacement:
```ts
    const { data: sharedRows, error: sharedError } = await supabase
      .from("collaborators")
      .select("list_id")
      .in("list_id", listIds)
      .eq("status", "approved");
    // Only the badge depends on this read: show none for this load rather than fail it.
    if (sharedError) console.warn("[lists/GET] Shared badges read failed, showing none:", { userId: auth.userId }, sharedError);
    for (const row of sharedRows || []) {
```

GET, per-user state. Current:
```ts
    const { data: stateRows } = await supabase
      .from("user_list_state")
      .select("list_id, position, archived_at")
      .eq("user_id", auth.userId)
      .in("list_id", listIds);
    for (const row of stateRows || []) {
```
Replacement:
```ts
    const { data: stateRows, error: stateError } = await supabase
      .from("user_list_state")
      .select("list_id, position, archived_at")
      .eq("user_id", auth.userId)
      .in("list_id", listIds);
    if (stateError) return dbError("lists/GET", "List state read", stateError, { userId: auth.userId });
    for (const row of stateRows || []) {
```

POST, the 50-list cap. Current:
```ts
  // Enforce max 50 lists per user
  const { count } = await supabase
    .from("lists")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", auth.userId)
    .is("deleted_at", null);

  if ((count || 0) >= 50) {
```
Replacement:
```ts
  // Enforce max 50 lists per user. A cap that cannot be read fails closed.
  const { count, error: countError } = await supabase
    .from("lists")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", auth.userId)
    .is("deleted_at", null);
  if (countError) return dbError("lists/POST", "List count read", countError, { userId: auth.userId });

  if ((count || 0) >= 50) {
```

PATCH, restore owner check and restore write. Current:
```ts
  if (restore) {
    const { data: list } = await supabase
      .from("lists")
      .select("owner_id")
      .eq("id", id)
      .not("deleted_at", "is", null)
      .single();

    if (!list || list.owner_id !== auth.userId) {
```
Replacement:
```ts
  if (restore) {
    const { data: list, error: ownerError } = await supabase
      .from("lists")
      .select("owner_id")
      .eq("id", id)
      .not("deleted_at", "is", null)
      .maybeSingle();
    if (ownerError) return dbError("lists/PATCH", "Owner check", ownerError, { listId: id, userId: auth.userId });

    if (!list || list.owner_id !== auth.userId) {
```
Current:
```ts
    if (error) {
      return NextResponse.json({ error: "Restore failed" }, { status: 500 });
    }
```
Replacement:
```ts
    if (error) return dbError("lists/PATCH", "Restore", error, { listId: id });
```

PATCH, edit owner check and edit write. Current:
```ts
  // Only owner can update list settings
  const { data: list } = await supabase
    .from("lists")
    .select("owner_id")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
```
Replacement:
```ts
  // Only owner can update list settings
  const { data: list, error: ownerError } = await supabase
    .from("lists")
    .select("owner_id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (ownerError) return dbError("lists/PATCH", "Owner check", ownerError, { listId: id, userId: auth.userId });
```
Current:
```ts
  if (error) {
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
```
Replacement:
```ts
  if (error) return dbError("lists/PATCH", "Update", error, { listId: id });
```

DELETE, owner check and soft delete. Current:
```ts
  // Only owner can delete
  const { data: list } = await supabase
    .from("lists")
    .select("owner_id")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
```
Replacement:
```ts
  // Only owner can delete
  const { data: list, error: ownerError } = await supabase
    .from("lists")
    .select("owner_id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (ownerError) return dbError("lists/DELETE", "Owner check", ownerError, { listId: id, userId: auth.userId });
```
Current:
```ts
  if (error) {
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
```
Replacement:
```ts
  if (error) return dbError("lists/DELETE", "Delete", error, { listId: id });
```

Leave the POST insert error (`console.error("[Lists] Create error:", error)`) unchanged. It is already logged.

**`app/api/user/route.ts`**

Imports. Add after the `api-validation` import line (as T1 left it):
```ts
import { dbError } from "@/src/lib/api-errors";
```

GET. Current:
```ts
  const { data: user, error } = await supabase
    .from("users")
    .select("*")
    .eq("id", auth.userId)
    .single();

  if (error || !user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
```
Replacement:
```ts
  const { data: user, error } = await supabase
    .from("users")
    .select("*")
    .eq("id", auth.userId)
    .maybeSingle();

  if (error) return dbError("user/GET", "User read", error, { userId: auth.userId });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
```

POST lookup. Current:
```ts
  // Check if user already exists
  const { data: existing } = await supabase
    .from("users")
    .select()
    .eq("telegram_id", telegramUser.id)
    .single();
```
Replacement:
```ts
  // Check if user already exists. maybeSingle: no row is the normal new-user answer, so
  // `error` is a real failure and must not fall through to an INSERT.
  const { data: existing, error: lookupError } = await supabase
    .from("users")
    .select()
    .eq("telegram_id", telegramUser.id)
    .maybeSingle();
  if (lookupError) return dbError("user/POST", "User lookup", lookupError, { telegramId: telegramUser.id });
```

PATCH. Current:
```ts
  if (error) {
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  return NextResponse.json(user);
}
```
(This is the last block in the file. The POST blocks above it use different messages.) Replacement:
```ts
  if (error) return dbError("user/PATCH", "Update", error, { userId: auth.userId });

  return NextResponse.json(user);
}
```

**`app/api/share/route.ts`**

Imports. Add after `import { serverEnv } from "@/src/lib/env";`:
```ts
import { dbError } from "@/src/lib/api-errors";
```

GET. Current:
```ts
  // Get collaborators
  const { data: collaborators } = await supabase
    .from("collaborators")
    .select("id, user_id, permission, status, users(name, username)")
    .eq("list_id", listId);

  // Get active invite link
  const { data: activeLinks } = await supabase
    .from("invite_links")
    .select("token, permission, expires_at")
    .eq("list_id", listId)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1);
```
Replacement:
```ts
  // Get collaborators. An empty list here would hide a pending request from the owner.
  const { data: collaborators, error: collabError } = await supabase
    .from("collaborators")
    .select("id, user_id, permission, status, users(name, username)")
    .eq("list_id", listId);
  if (collabError) return dbError("share/GET", "Collaborators read", collabError, { listId });

  // Get active invite link
  const { data: activeLinks, error: linkError } = await supabase
    .from("invite_links")
    .select("token, permission, expires_at")
    .eq("list_id", listId)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1);
  if (linkError) return dbError("share/GET", "Active link read", linkError, { listId });
```

Only IDs (userId, listId, telegramId) go into the log context. No token, link, name or initData is logged.

- [ ] **Step 4: Update existing tests and mocks that break**

None are expected to need edits:
- `__tests__/unit/lists-route-categorize.test.ts` uses `fakeSupabase`. It answers `.maybeSingle()` the same way as `.single()` and already returns `error: null`. Its `updateFails` case now also logs, which is harmless.
- `__tests__/unit/user-update.test.ts` mocks only the PATCH `update().eq().select().single()` chain, and PATCH keeps `.single()`.
- No other test imports these three routes (checked with `grep -rl "api/lists/route\|api/user/route\|api/share/route" __tests__`).

If a run shows otherwise, change only the mock: add `error: null`, or a `maybeSingle` method that mirrors `single`. Never loosen a new check.

- [ ] **Step 5: Run the tests. Expect PASS**

```bash
npx vitest run __tests__/unit/lists-route-db-errors.test.ts __tests__/unit/user-route-db-errors.test.ts __tests__/unit/share-route-db-errors.test.ts __tests__/unit/lists-route-categorize.test.ts __tests__/unit/user-update.test.ts __tests__/unit/no-silent-catches.test.ts
npx tsc --noEmit
npx eslint app/api/lists/route.ts app/api/user/route.ts app/api/share/route.ts __tests__/unit/lists-route-db-errors.test.ts __tests__/unit/user-route-db-errors.test.ts __tests__/unit/share-route-db-errors.test.ts
```
Expected: every test passes, tsc reports no errors and eslint is clean.

- [ ] **Step 6: Make it bite**

Each change below must be undone alone, the named test run, the red seen, and the change restored before moving to the next. Command: `npx vitest run <file> -t "<name>"`.

1. `lists/route.ts`: delete `if (ownedError) return dbError(...)`. Red: `lists-route-db-errors` "answers a logged 500 … when the owned read fails" (gets 200).
2. Delete `if (collabError) …`. Red: "… the collaborators read fails".
3. Delete `if (sharedListsError) …`. Red: "… the sharedLists read fails".
4. Delete `if (countsError) …`. Red: "… the counts read fails".
5. Delete `if (stateError) …`. Red: "… the state read fails".
6. Delete the `if (sharedError) console.warn(...)` line. Red: "still answers 200 when only the shared-badge read fails, and warns". Then change it to `return dbError(...)`. The same test goes red with a 500, which proves the badge read must not fail the screen.
7. Delete `if (countError) …` in POST. Red: "refuses with a logged 500 and inserts nothing …" (gets 201).
8. Delete each of the three `if (ownerError) …` lines, one at a time. Red: "<undo delete|edit|delete> answers a logged 500 …" (gets 403).
9. Change each of the three owner-check `.maybeSingle()` back to `.single()`, keeping the `if (ownerError)`. Red: "<label> answers 403 … when there is no such list" (gets 500 from PGRST116).
10. Replace `if (error) return dbError("lists/PATCH", "Restore", …)` with the old `if (error) { return NextResponse.json({ error: "Restore failed" }, { status: 500 }); }`. Red: "undo delete logs the failed write …". Do the same for Update and Delete.
11. `user/route.ts` GET: delete `if (error) return dbError(...)`. Red: "answers a logged 500, not 404, when the read fails" (gets 404). Change `.maybeSingle()` back to `.single()`. Red: "answers 404 when there is no user row" (gets 500).
12. POST: delete `if (lookupError) …`. Red: "answers a logged 500 and writes nothing when the lookup fails" (INSERT runs). Change `.maybeSingle()` back to `.single()`. Red: "registers a new user …" (gets 500).
13. PATCH: put back the unlogged 500. Red: "logs the failed language save".
14. `share/route.ts`: delete `if (collabError) …`. Red: "… the collaborators read fails". Delete `if (linkError) …`. Red: "… the invite_links read fails".

- [ ] **Step 7: Commit**

```bash
git add app/api/lists/route.ts app/api/user/route.ts app/api/share/route.ts __tests__/unit/lists-route-db-errors.test.ts __tests__/unit/user-route-db-errors.test.ts __tests__/unit/share-route-db-errors.test.ts
git commit -m "$(cat <<'EOF'
fix(api): fail loudly on list, user and share read errors

GET /api/lists returns a logged 500 when a core read fails instead of a
silently partial home screen; only the shared badge stays best-effort.
The 50-list cap fails closed. Owner checks for undo-delete, edit and
delete tell a DB error (500) from a missing row or non-owner (403).
POST /api/user no longer falls into an INSERT after a failed lookup, and
GET /api/share no longer answers an empty collaborator list on error.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
)"
```

---

### Task 3b: Item, category and signal route reads and writes

Group 2, part 2: the items routes (GET, POST, the category check in PATCH, DELETE), the three bulk item routes, the three category routes, and the ready and remind routes.

**Runs after T1, T2 and T3a. T4 runs after this task.**
- **T1** in `items/route.ts` has switched both `await request.json()` calls to `readJsonBody`, added a 400 for a null or non-object POST body, and changed the `api-validation` import. In the categories and unskip-all routes it has replaced the inline `request.json().catch(...)` with `readJsonBody`.
- **T2** in `items/route.ts` has wrapped the batch loop's `findRecyclableItems` / `recycleItem` calls (log, skip, continue).
- **T4** later edits the items PATCH update (`query.select().single()` and `error || !item`) and the category reset. T4 does not touch the lines below, and it reuses the `dbError` import this task adds.

Anchor on the snippets shown, not on line numbers.

**Files:**
- Modify: `app/api/lists/[id]/items/route.ts`
- Modify: `app/api/lists/[id]/items/clear-completed/route.ts`
- Modify: `app/api/lists/[id]/items/unmark-completed/route.ts`
- Modify: `app/api/lists/[id]/items/unskip-all/route.ts`
- Modify: `app/api/lists/[id]/categories/route.ts`
- Modify: `app/api/lists/[id]/categories/[categoryId]/route.ts`
- Modify: `app/api/lists/[id]/categories/order/route.ts`
- Modify: `app/api/lists/[id]/ready/route.ts`
- Modify: `app/api/lists/[id]/remind/route.ts`
- Create (test): `__tests__/unit/items-route-db-errors.test.ts`
- Create (test): `__tests__/unit/signal-routes-db-errors.test.ts`
- Modify (test): `__tests__/unit/categories-routes.test.ts` (append one describe block)
- Re-run, unchanged:
  - `__tests__/unit/items-route-categorize.test.ts`
  - `__tests__/unit/items-get-columns.test.ts`
  - `__tests__/unit/items-completion-no-reminders.test.ts`
  - `__tests__/unit/unskip-all-route.test.ts`
  - `__tests__/unit/unmark-completed-route.test.ts`
  - `__tests__/unit/clear-completed.test.ts`
  - `__tests__/unit/no-deleted-item-leak.test.ts`
  - `__tests__/unit/recycle-scoping.test.ts`
  - `__tests__/unit/no-silent-catches.test.ts`

**Interfaces:**
- Consumes (T1): `dbError(tag: string, what: string, error: unknown, ctx?: Record<string, unknown>): NextResponse` from `@/src/lib/api-errors`.
- Produces:
  - `import { dbError } from "@/src/lib/api-errors";` in `app/api/lists/[id]/items/route.ts`. T4 uses it and must not add a second import.
  - Log tags: `items/GET`, `items/POST`, `items/PATCH`, `items/DELETE`, `items/clear-completed/POST`, `items/unmark-completed/POST`, `items/unskip-all/POST`, `categories/GET`, `categories/POST`, `categories/PATCH`, `categories/DELETE`, `categories/order/PUT`, `Ready`, `Remind`.

**Sites:**

| site (as of f441470) | today on failure | change | user-visible result |
|---|---|---|---|
| items/route.ts:57 list type read | error dropped; sweep skipped silently | read `listError`, `console.warn("[items/GET] List type read failed, skipping the category sweep:", {listId}, err)` | unchanged (items load, sweep runs next GET), now logged |
| items/route.ts:63 items read | unlogged 500 | `dbError("items/GET","Items read",…,{listId})` | same 500, logged |
| items/route.ts:115 idempotency lookup | `.single()`, error ignored → goes on to insert | `.maybeSingle()` + `dbError("items/POST","Idempotency lookup",…,{listId})` before the insert | 500 → queue retries; no insert attempted on a failed check |
| items/route.ts:136 max position (idempotent, no client position) | error ignored → position 1 → item buried at the bottom | `dbError("items/POST","Max position read",…,{listId})` before the insert | 500 → queue retries; item never lands at the bottom |
| items/route.ts:227 max position (batch) | error ignored → positions 1,2,3… | `dbError("items/POST","Max position read",…,{listId})` before the loop | 500 → nothing inserted or recycled; caller retries |
| items/route.ts:333 category check | unlogged 500 | `dbError("items/PATCH","Category check",…,{listId,categoryId})` | same 500 (queue retries), logged |
| items/route.ts:476 delete | unlogged 500 | `dbError("items/DELETE","Delete",…,{listId,itemId})` | same 500, logged |
| items/clear-completed/route.ts:40 | unlogged 500 | `dbError("items/clear-completed/POST","Clear completed",…,{listId})` | same 500 (T7 reverts + toast), logged |
| items/unmark-completed/route.ts:34 | unlogged 500 | `dbError("items/unmark-completed/POST","Unmark completed",…,{listId})` | same, logged |
| items/unskip-all/route.ts:45 | unlogged 500 | `dbError("items/unskip-all/POST","Unskip",…,{listId})` | same, logged |
| categories/route.ts:25 GET read | unlogged 500 | `dbError("categories/GET","Categories read",…,{listId})` | same, logged |
| categories/route.ts:54 cap pre-check | unlogged 500 | `dbError("categories/POST","Category count read",…,{listId})` | same, logged |
| categories/route.ts:73 insert RPC | unlogged 500 | `dbError("categories/POST","Category insert",…,{listId})` | same, logged |
| categories/[categoryId]/route.ts:49 read | unlogged 500 | `dbError("categories/PATCH","Category read",…,{listId,categoryId})` | same, logged |
| categories/[categoryId]/route.ts:63 rename | unlogged 500 | `dbError("categories/PATCH","Category rename",…)` | same, logged |
| categories/[categoryId]/route.ts:80 item release | unlogged 500 | `dbError("categories/DELETE","Item release",…)` | same, logged |
| categories/[categoryId]/route.ts:87 delete | unlogged 500 | `dbError("categories/DELETE","Category delete",…)` | same, logged |
| categories/order/route.ts:31 reorder RPC | unlogged 500 | `dbError("categories/order/PUT","Category reorder",…,{listId})` | same, logged |
| ready/route.ts:26 list read | `.single()`, error ignored → unlogged 404 | `.maybeSingle()` + `dbError("Ready","List read",…,{listId})`; 404 only for no row | same signalError toast, now logged |
| ready/route.ts:36 sender read | error ignored → message signed "Someone" | `.maybeSingle()` + `dbError("Ready","Sender read",…,{listId,userId})` before any send | nothing sent; user gets items.signalError and can retry; "Someone" only for a missing row |
| remind/route.ts:27 list read | as ready:26 | `dbError("Remind","List read",…)` | as above |
| remind/route.ts:38 sender read | as ready:36 | `dbError("Remind","Sender read",…)` | as above |

- [ ] **Step 1: Write the failing tests**

Create `__tests__/unit/items-route-db-errors.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

// Runs the real items handlers; auth, the rate limiter, the recycler and Supabase are faked.
const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
  after: [] as (() => unknown)[],
  findRecyclable: vi.fn(async () => [] as { id: string; text: string }[]),
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "owner" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));
vi.mock("@/src/services/categorize-list", () => ({ categorizeList: async () => {} }));
vi.mock("@/src/services/item-recycler", () => ({ findRecyclableItems: h.findRecyclable, recycleItem: async () => null }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => { h.after.push(fn); },
}));

import { GET, POST, PATCH, DELETE } from "@/app/api/lists/[id]/items/route";
import { POST as CLEAR } from "@/app/api/lists/[id]/items/clear-completed/route";
import { POST as UNMARK } from "@/app/api/lists/[id]/items/unmark-completed/route";
import { POST as UNSKIP } from "@/app/api/lists/[id]/items/unskip-all/route";

const CAT = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e01";
const MILK = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e03";
const boom = { code: "57014", message: "canceling statement due to statement timeout" };
const params = { params: Promise.resolve({ id: "L" }) };
const req = (method: string, body?: unknown, path = "items") =>
  new NextRequest(`https://app.test/api/lists/L/${path}`, {
    method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });

// PostgREST's answer to a read that matches no row: .single() reports PGRST116, .maybeSingle() null.
const noRow = (c: FakeCall): FakeResult =>
  c.filters.includes("single")
    ? { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } }
    : { data: null, error: null };
const isLookup = (c: FakeCall) => c.table === "items" && c.op === "select" && c.filters.includes("eq:idempotency_key=k1");
const isMaxPos = (c: FakeCall) =>
  c.table === "items" && c.op === "select" && c.filters.includes("order:position:false") && c.filters.includes("limit:1");
const inserted: FakeResult = { data: [{ id: "new", text: "milk" }], error: null };

function use(resolve: (c: FakeCall) => FakeResult) {
  h.fake = fakeSupabase(resolve) as typeof h.fake;
}
const inserts = () => h.fake.calls.filter((c) => c.op === "rpc" && c.table === "insert_item_if_under_limit");

beforeEach(() => {
  h.after = [];
  h.findRecyclable.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(console.error).mockClear();
  vi.mocked(console.warn).mockClear();
});

describe("GET /items", () => {
  it("answers a logged 500 when the items read fails", async () => {
    use((c) => c.table === "items" ? { data: null, error: boom } : { data: { type: "grocery", categories_rescan_at: null }, error: null });
    const res = await GET(req("GET"), params);
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[items/GET] Items read failed:", { listId: "L" }, boom);
  });

  it("still returns the items, skips the sweep and warns when the list type read fails", async () => {
    use((c) => c.table === "lists" ? { data: null, error: boom } : { data: [{ id: "a", position: 1, category_id: null }], error: null });
    const res = await GET(req("GET"), params);
    expect(res.status).toBe(200);
    expect((await res.json()).items).toHaveLength(1);
    expect(h.after).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith("[items/GET] List type read failed, skipping the category sweep:", { listId: "L" }, boom);
  });
});

describe("POST /items", () => {
  const create = (extra: object = {}) => POST(req("POST", { text: "milk", idempotencyKey: "k1", ...extra }), params);

  it("answers a logged 500 and inserts nothing when the duplicate check fails", async () => {
    use((c) => isLookup(c) ? { data: null, error: boom } : c.op === "rpc" ? inserted : { data: null, error: null });
    const res = await create({ position: 5 });
    expect(res.status).toBe(500);
    expect(inserts()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith("[items/POST] Idempotency lookup failed:", { listId: "L" }, boom);
  });

  it("inserts when no item has the idempotency key yet", async () => {
    use((c) => isLookup(c) ? noRow(c) : c.op === "rpc" ? inserted : { data: null, error: null });
    const res = await create({ position: 5 });
    expect(res.status).toBe(201);
    expect(inserts()).toHaveLength(1);
  });

  it("answers a logged 500 and inserts nothing when the max position cannot be read (no client position)", async () => {
    use((c) => isMaxPos(c) ? { data: null, error: boom } : c.op === "rpc" ? inserted : { data: null, error: null });
    const res = await create();
    expect(res.status).toBe(500);
    expect(inserts()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith("[items/POST] Max position read failed:", { listId: "L" }, boom);
  });

  it("places an item without a client position above the current top one", async () => {
    use((c) => isMaxPos(c) ? { data: [{ position: 41 }], error: null } : c.op === "rpc" ? inserted : { data: null, error: null });
    expect((await create()).status).toBe(201);
    expect(inserts()[0].values).toMatchObject({ p_position: 42 });
  });

  it("batch: answers a logged 500 and neither recycles nor inserts when the max position cannot be read", async () => {
    use((c) => isMaxPos(c) ? { data: null, error: boom } : c.op === "rpc" ? inserted : { data: null, error: null });
    const res = await POST(req("POST", { text: "milk, eggs" }), params);
    expect(res.status).toBe(500);
    expect(inserts()).toEqual([]);
    expect(h.findRecyclable).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("[items/POST] Max position read failed:", { listId: "L" }, boom);
  });
});

describe("PATCH and DELETE /items", () => {
  it("PATCH logs the failed category check", async () => {
    use((c) => c.table === "list_categories" ? { data: null, error: boom } : { data: null, error: null });
    const res = await PATCH(req("PATCH", { itemId: "a", categoryId: CAT }), params);
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[items/PATCH] Category check failed:", { listId: "L", categoryId: CAT }, boom);
  });

  it("DELETE logs the failed soft delete", async () => {
    use(() => ({ data: null, error: boom }));
    const res = await DELETE(new NextRequest("https://app.test/api/lists/L/items?itemId=a", { method: "DELETE" }), params);
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[items/DELETE] Delete failed:", { listId: "L", itemId: "a" }, boom);
  });
});

describe("bulk item routes", () => {
  it.each([
    ["clear completed", () => CLEAR(req("POST", undefined, "items/clear-completed"), params), "[items/clear-completed/POST] Clear completed failed:"],
    ["unmark all", () => UNMARK(req("POST", undefined, "items/unmark-completed"), params), "[items/unmark-completed/POST] Unmark completed failed:"],
    ["restore Not available", () => UNSKIP(req("POST", { itemIds: [MILK] }, "items/unskip-all"), params), "[items/unskip-all/POST] Unskip failed:"],
  ] as const)("%s answers 500 and logs the failed update with its list id", async (_label, call, line) => {
    use(() => ({ data: null, error: boom }));
    const res = await call();
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(line, { listId: "L" }, boom);
  });
});
```

Create `__tests__/unit/signal-routes-db-errors.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

// Runs the real ready and remind handlers; auth, recipients, the bot and Supabase are faked.
const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
  sendReady: vi.fn(async () => {}),
  sendReminder: vi.fn(async () => {}),
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "editor" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));
vi.mock("@/src/lib/list-notify", () => ({ resolveListRecipients: async () => [{ telegramId: 7, language: "he" }] }));
vi.mock("@/src/services/bot", () => ({ sendListReady: h.sendReady, sendListReminder: h.sendReminder }));

import { POST as READY } from "@/app/api/lists/[id]/ready/route";
import { POST as REMIND } from "@/app/api/lists/[id]/remind/route";

const boom = { code: "57014", message: "canceling statement due to statement timeout" };
const noRow = (c: FakeCall): FakeResult =>
  c.filters.includes("single")
    ? { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } }
    : { data: null, error: null };
const list: FakeResult = { data: { name: "Groceries" }, error: null };
const sender: FakeResult = { data: { name: "Dana" }, error: null };
function use(lists: (c: FakeCall) => FakeResult, users: (c: FakeCall) => FakeResult) {
  h.fake = fakeSupabase((c) => (c.table === "lists" ? lists(c) : c.table === "users" ? users(c) : { data: null, error: null })) as typeof h.fake;
}
const call = (route: typeof READY, path: string) =>
  route(new NextRequest(`https://app.test/api/lists/L/${path}`, { method: "POST" }), { params: Promise.resolve({ id: "L" }) });

beforeEach(() => {
  h.sendReady.mockClear();
  h.sendReminder.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(console.error).mockClear();
});

describe.each([
  ["ready", READY, h.sendReady, "Ready"],
  ["remind", REMIND, h.sendReminder, "Remind"],
] as const)("POST /api/lists/[id]/%s", (path, route, send, tag) => {
  it("answers a logged 500 and sends nothing when the list read fails", async () => {
    use(() => ({ data: null, error: boom }), () => sender);
    const res = await call(route, path);
    expect(res.status).toBe(500);
    expect(send).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(`[${tag}] List read failed:`, { listId: "L" }, boom);
  });

  it("answers 404 and sends nothing when the list is gone", async () => {
    use(noRow, () => sender);
    const res = await call(route, path);
    expect(res.status).toBe(404);
    expect(send).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("answers a logged 500 and sends nothing signed 'Someone' when the sender read fails", async () => {
    use(() => list, () => ({ data: null, error: boom }));
    const res = await call(route, path);
    expect(res.status).toBe(500);
    expect(send).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(`[${tag}] Sender read failed:`, { listId: "L", userId: "u1" }, boom);
  });

  it("signs the message 'Someone' only when the sender has no row", async () => {
    use(() => list, noRow);
    const res = await call(route, path);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1 });
    expect(send).toHaveBeenCalledWith(7, "he", "Someone", "Groceries", "L");
  });

  it("signs the message with the sender's name", async () => {
    use(() => list, () => sender);
    expect((await call(route, path)).status).toBe(200);
    expect(send).toHaveBeenCalledWith(7, "he", "Dana", "Groceries", "L");
  });
});
```

Append to `__tests__/unit/categories-routes.test.ts`, after the last `describe` block. It reuses that file's `h`, `use`, `req`, `listParams`, `catParams`, `A` and `B`. The file's `beforeEach` already spies on `console.error`, so the spy is cleared per case:

```ts
// Every failed database call answers 500 and leaves its cause, with the ids, in the logs.
describe("failed database calls are logged", () => {
  const boom = { code: "57014", message: "canceling statement due to statement timeout" };
  const stored = { id: A, list_id: "L", name_en: "Pets", name_he: "חיות", name_ru: "Питомцы", position: 2, created_by: null };
  const ids = { listId: "L", categoryId: A };
  const cases: [string, (c: FakeCall) => boolean, () => Promise<Response>, string, Record<string, unknown>][] = [
    ["GET's read", (c) => c.table === "list_categories", () => GET(req("GET"), listParams), "[categories/GET] Categories read failed:", { listId: "L" }],
    ["POST's cap pre-check", (c) => c.table === "list_categories", () => POST(req("POST", { name: "Pets", locale: "en" }), listParams), "[categories/POST] Category count read failed:", { listId: "L" }],
    ["POST's insert", (c) => c.table === "insert_list_category", () => POST(req("POST", { name: "Pets", locale: "en" }), listParams), "[categories/POST] Category insert failed:", { listId: "L" }],
    ["PATCH's read", (c) => c.op === "select", () => PATCH(req("PATCH", { name: "Animals", locale: "en" }), catParams), "[categories/PATCH] Category read failed:", ids],
    ["PATCH's rename", (c) => c.op === "update", () => PATCH(req("PATCH", { name: "Animals", locale: "en" }), catParams), "[categories/PATCH] Category rename failed:", ids],
    ["DELETE's item release", (c) => c.table === "items", () => DELETE(req("DELETE"), catParams), "[categories/DELETE] Item release failed:", ids],
    ["DELETE's delete", (c) => c.op === "delete", () => DELETE(req("DELETE"), catParams), "[categories/DELETE] Category delete failed:", ids],
    ["PUT's reorder", (c) => c.op === "rpc", () => PUT(req("PUT", { orderedIds: [B, A] }), listParams), "[categories/order/PUT] Category reorder failed:", { listId: "L" }],
  ];

  it.each(cases)("%s answers 500 and logs the error", async (_label, failing, call, line, ctx) => {
    vi.mocked(console.error).mockClear();
    use((c) => failing(c) ? { data: null, error: boom }
      : c.table === "list_categories" && c.op === "select" ? { data: c.filters.includes("maybeSingle") ? stored : [], error: null }
      : { data: null, error: null });
    const res = await call();
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(line, ctx, boom);
  });
});
```

- [ ] **Step 2: Run them. Expect them to FAIL**

Run: `npx vitest run __tests__/unit/items-route-db-errors.test.ts __tests__/unit/signal-routes-db-errors.test.ts __tests__/unit/categories-routes.test.ts`

Expected:
- **FAIL:**
  - Every "logs …" case: the routes return 500 already, but `console.error` is never called.
  - The list-type warn case: no warn today.
  - The three POST 500 cases: today the duplicate check and the max-position reads are ignored, so the RPC runs and POST answers 201. In the batch case `findRecyclableItems` is called as well.
  - Ready/remind "list read fails": 404 today.
  - Ready/remind "sender read fails": today it answers 200 and sends with "Someone".
- **PASS already (guards):**
  - "inserts when no item has the key" (`.single()`'s PGRST116 is ignored today)
  - "places … above the current top one"
  - ready/remind 404, "Someone" for no row, and the sender's name
  - every existing test in `categories-routes.test.ts`

- [ ] **Step 3: Implementation**

**`app/api/lists/[id]/items/route.ts`**

Imports. Add after the `api-validation` import line (as T1 left it):
```ts
import { dbError } from "@/src/lib/api-errors";
```

GET. Current:
```ts
  const [{ data: items, error }, { data: list }] = await Promise.all([
    query,
    supabase.from("lists").select("type, categories_rescan_at").eq("id", listId).maybeSingle(),
  ]);

  if (error) {
    return NextResponse.json({ error: "Failed to fetch items" }, { status: 500 });
  }
```
Replacement:
```ts
  const [{ data: items, error }, { data: list, error: listError }] = await Promise.all([
    query,
    supabase.from("lists").select("type, categories_rescan_at").eq("id", listId).maybeSingle(),
  ]);

  if (error) return dbError("items/GET", "Items read", error, { listId });
  // Only the sweep needs the list's type: without it, skip the sweep for this load.
  if (listError) console.warn("[items/GET] List type read failed, skipping the category sweep:", { listId }, listError);
```

POST, idempotency lookup. Current:
```ts
    // Check for existing item with same idempotency key
    const { data: existing } = await supabase
      .from("items")
      .select()
      .eq("list_id", listId)
      .eq("idempotency_key", parsed.data.idempotencyKey)
      .single();
```
Replacement:
```ts
    // Check for existing item with same idempotency key. maybeSingle: no row is the normal
    // answer, so `error` is a real failure (500, the queue retries).
    const { data: existing, error: lookupError } = await supabase
      .from("items")
      .select()
      .eq("list_id", listId)
      .eq("idempotency_key", parsed.data.idempotencyKey)
      .maybeSingle();
    if (lookupError) return dbError("items/POST", "Idempotency lookup", lookupError, { listId });
```

POST, idempotent max position. Current:
```ts
    if (position === null) {
      const { data: maxPosResult } = await supabase
        .from("items")
        .select("position")
        .eq("list_id", listId)
        .order("position", { ascending: false })
        .limit(1);
      position = (maxPosResult?.[0]?.position || 0) + 1;
    }
```
Replacement:
```ts
    if (position === null) {
      const { data: maxPosResult, error: maxPosError } = await supabase
        .from("items")
        .select("position")
        .eq("list_id", listId)
        .order("position", { ascending: false })
        .limit(1);
      // Falling back to 1 would bury the new item at the bottom of the list.
      if (maxPosError) return dbError("items/POST", "Max position read", maxPosError, { listId });
      position = (maxPosResult?.[0]?.position || 0) + 1;
    }
```

POST, batch max position. Current:
```ts
  // Get current max position
  const { data: maxPosResult } = await supabase
    .from("items")
    .select("position")
    .eq("list_id", listId)
    .order("position", { ascending: false })
    .limit(1);

  let nextPosition = (maxPosResult?.[0]?.position || 0) + 1;
```
Replacement:
```ts
  // Get current max position. Checked before the loop, so nothing is inserted or recycled
  // at a wrong position.
  const { data: maxPosResult, error: maxPosError } = await supabase
    .from("items")
    .select("position")
    .eq("list_id", listId)
    .order("position", { ascending: false })
    .limit(1);
  if (maxPosError) return dbError("items/POST", "Max position read", maxPosError, { listId });

  let nextPosition = (maxPosResult?.[0]?.position || 0) + 1;
```

PATCH, category check. Current:
```ts
    if (categoryError) {
      // 500, not 400: the mutation queue drops 4xx, and this move should be retried.
      return NextResponse.json({ error: "Failed to check category" }, { status: 500 });
    }
```
Replacement:
```ts
    if (categoryError) {
      // 500, not 400: the mutation queue drops 4xx, and this move should be retried.
      return dbError("items/PATCH", "Category check", categoryError, { listId, categoryId: updates.categoryId });
    }
```

DELETE. Current:
```ts
  if (error) {
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
```
(This is the last block in the file.) Replacement:
```ts
  if (error) return dbError("items/DELETE", "Delete", error, { listId, itemId });

  return NextResponse.json({ success: true });
}
```

Leave PATCH's `const { data: item, error } = await query.select().single();`, its `error || !item` 404 and the category reset to T4.

**`app/api/lists/[id]/items/clear-completed/route.ts`**

Add after `import { createServerClient } from "@/src/lib/supabase";`:
```ts
import { dbError } from "@/src/lib/api-errors";
```
Current:
```ts
  if (error) {
    return NextResponse.json(
      { error: "Failed to clear items" },
      { status: 500 }
    );
  }
```
Replacement:
```ts
  if (error) return dbError("items/clear-completed/POST", "Clear completed", error, { listId });
```

**`app/api/lists/[id]/items/unmark-completed/route.ts`**

Add after `import { createServerClient } from "@/src/lib/supabase";`:
```ts
import { dbError } from "@/src/lib/api-errors";
```
Current:
```ts
  if (error) {
    return NextResponse.json(
      { error: "Failed to unmark items" },
      { status: 500 }
    );
  }
```
Replacement:
```ts
  if (error) return dbError("items/unmark-completed/POST", "Unmark completed", error, { listId });
```

**`app/api/lists/[id]/items/unskip-all/route.ts`**

Add after the `api-validation` import (as T1 left it):
```ts
import { dbError } from "@/src/lib/api-errors";
```
Current:
```ts
  if (error) {
    return NextResponse.json(
      { error: "Failed to restore items" },
      { status: 500 }
    );
  }
```
Replacement:
```ts
  if (error) return dbError("items/unskip-all/POST", "Unskip", error, { listId });
```

**`app/api/lists/[id]/categories/route.ts`**

Add after the `api-validation` import (as T1 left it):
```ts
import { dbError } from "@/src/lib/api-errors";
```
Current: `  if (error) return NextResponse.json({ error: "Failed to load categories" }, { status: 500 });`
Replacement: `  if (error) return dbError("categories/GET", "Categories read", error, { listId });`

Current: `  if (readError) return NextResponse.json({ error: "Failed to create category" }, { status: 500 });`
Replacement: `  if (readError) return dbError("categories/POST", "Category count read", readError, { listId });`

Current: `  if (error) return NextResponse.json({ error: "Failed to create category" }, { status: 500 });`
Replacement: `  if (error) return dbError("categories/POST", "Category insert", error, { listId });`

Leave the `owedError` `console.error` unchanged (it is already logged, and the route still answers 201 by design).

**`app/api/lists/[id]/categories/[categoryId]/route.ts`**

Add after the `api-validation` import (as T1 left it):
```ts
import { dbError } from "@/src/lib/api-errors";
```
Current: `  if (readError) return NextResponse.json({ error: "Failed to rename category" }, { status: 500 });`
Replacement: `  if (readError) return dbError("categories/PATCH", "Category read", readError, { listId, categoryId });`

Current: `  if (error) return NextResponse.json({ error: "Failed to rename category" }, { status: 500 });`
Replacement: `  if (error) return dbError("categories/PATCH", "Category rename", error, { listId, categoryId });`

Current: `  if (releaseError) return NextResponse.json({ error: "Failed to delete category" }, { status: 500 });`
Replacement: `  if (releaseError) return dbError("categories/DELETE", "Item release", releaseError, { listId, categoryId });`

Current: `  if (error) return NextResponse.json({ error: "Failed to delete category" }, { status: 500 });`
Replacement: `  if (error) return dbError("categories/DELETE", "Category delete", error, { listId, categoryId });`

**`app/api/lists/[id]/categories/order/route.ts`**

Add after the `api-validation` import (as T1 left it):
```ts
import { dbError } from "@/src/lib/api-errors";
```
Current: `  if (error) return NextResponse.json({ error: "Failed to reorder" }, { status: 500 });`
Replacement: `  if (error) return dbError("categories/order/PUT", "Category reorder", error, { listId });`

**`app/api/lists/[id]/ready/route.ts`**

Add after `import { resolveListRecipients } from "@/src/lib/list-notify";`:
```ts
import { dbError } from "@/src/lib/api-errors";
```
Current:
```ts
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
```
Replacement:
```ts
  const { data: list, error: listError } = await supabase
    .from("lists")
    .select("name")
    .eq("id", listId)
    .maybeSingle();
  if (listError) return dbError("Ready", "List read", listError, { listId });

  if (!list) {
    return NextResponse.json({ error: "List not found" }, { status: 404 });
  }

  const { data: sender, error: senderError } = await supabase
    .from("users")
    .select("name")
    .eq("id", auth.userId)
    .maybeSingle();
  // A message signed by the wrong person can't be taken back: send nothing if the name
  // can't be read. "Someone" is only for a sender with no row.
  if (senderError) return dbError("Ready", "Sender read", senderError, { listId, userId: auth.userId });

  const senderName = sender?.name || "Someone";
```

**`app/api/lists/[id]/remind/route.ts`**

Add after `import { resolveListRecipients } from "@/src/lib/list-notify";`:
```ts
import { dbError } from "@/src/lib/api-errors";
```
Current:
```ts
  // Get list name
  const { data: list } = await supabase
    .from("lists")
    .select("name")
    .eq("id", listId)
    .single();

  if (!list) {
    return NextResponse.json({ error: "List not found" }, { status: 404 });
  }

  // Get sender info
  const { data: sender } = await supabase
    .from("users")
    .select("name, telegram_id")
    .eq("id", auth.userId)
    .single();

  const senderName = sender?.name || "Someone";
```
Replacement (`telegram_id` stays selected; it is out of scope):
```ts
  // Get list name
  const { data: list, error: listError } = await supabase
    .from("lists")
    .select("name")
    .eq("id", listId)
    .maybeSingle();
  if (listError) return dbError("Remind", "List read", listError, { listId });

  if (!list) {
    return NextResponse.json({ error: "List not found" }, { status: 404 });
  }

  // Get sender info. A reminder signed by the wrong person can't be taken back: send
  // nothing if the name can't be read. "Someone" is only for a sender with no row.
  const { data: sender, error: senderError } = await supabase
    .from("users")
    .select("name, telegram_id")
    .eq("id", auth.userId)
    .maybeSingle();
  if (senderError) return dbError("Remind", "Sender read", senderError, { listId, userId: auth.userId });

  const senderName = sender?.name || "Someone";
```

Task 2 does not touch these reads (ruling R3); this task adds the checks.

After this step, check that `NextResponse` is still used in each file. It is used in all nine files (the 403 and 404 branches and the success responses), so no import becomes unused.

- [ ] **Step 4: Update existing tests and mocks that break**

None are expected to need edits:
- `items-route-categorize.test.ts`, `items-get-columns.test.ts` and `items-completion-no-reminders.test.ts` use `fakeSupabase`. Its `.maybeSingle()` resolves like `.single()`, and every resolver already returns `error: null`.
- "POST returning an already-created item" still gets its row from the lookup, now through `.maybeSingle()`.
- `unskip-all-route.test.ts` uses a hand-rolled update chain with no `single`. Its 500 case now also logs, which is harmless.
- `unmark-completed-route.test.ts` and `categories-routes.test.ts` already return `error: null` on their success paths.
- The source-inspection tests (`clear-completed.test.ts`'s `.eq("recurring", false)`, `no-deleted-item-leak.test.ts`'s GET slice and restoreRecurring slice, `recycle-scoping.test.ts`'s single `recycleItem(` call) look at text this task does not change.

If a run shows a break, fix only the mock: add `error: null`, or a `maybeSingle` that mirrors `single`. Never loosen a new check.

- [ ] **Step 5: Run the tests. Expect PASS**

```bash
npx vitest run __tests__/unit/items-route-db-errors.test.ts __tests__/unit/signal-routes-db-errors.test.ts __tests__/unit/categories-routes.test.ts __tests__/unit/items-route-categorize.test.ts __tests__/unit/items-get-columns.test.ts __tests__/unit/items-completion-no-reminders.test.ts __tests__/unit/unskip-all-route.test.ts __tests__/unit/unmark-completed-route.test.ts __tests__/unit/clear-completed.test.ts __tests__/unit/no-deleted-item-leak.test.ts __tests__/unit/recycle-scoping.test.ts __tests__/unit/no-silent-catches.test.ts
npx tsc --noEmit
npx eslint "app/api/lists/[id]/items/route.ts" "app/api/lists/[id]/items/clear-completed/route.ts" "app/api/lists/[id]/items/unmark-completed/route.ts" "app/api/lists/[id]/items/unskip-all/route.ts" "app/api/lists/[id]/categories/route.ts" "app/api/lists/[id]/categories/[categoryId]/route.ts" "app/api/lists/[id]/categories/order/route.ts" "app/api/lists/[id]/ready/route.ts" "app/api/lists/[id]/remind/route.ts" __tests__/unit/items-route-db-errors.test.ts __tests__/unit/signal-routes-db-errors.test.ts __tests__/unit/categories-routes.test.ts
```
Expected: every test passes, tsc reports no errors and eslint is clean.

- [ ] **Step 6: Make it bite**

Undo one change at a time, run `npx vitest run <file> -t "<name>"`, see the red, then restore.

1. `items/route.ts` GET: put back the unlogged `NextResponse.json({ error: "Failed to fetch items" }, { status: 500 })`. Red: "answers a logged 500 when the items read fails". Delete the `if (listError) console.warn(...)` line. Red: "still returns the items, skips the sweep and warns …".
2. POST: delete `if (lookupError) …`. Red: "answers a logged 500 and inserts nothing when the duplicate check fails" (201). Change `.maybeSingle()` back to `.single()` with the check in place. Red: "inserts when no item has the idempotency key yet" (500 from PGRST116).
3. Delete the idempotent-path `if (maxPosError) …`. Red: "… max position cannot be read (no client position)" (201, with p_position 1).
4. Delete the batch `if (maxPosError) …`. Red: "batch: answers a logged 500 and neither recycles nor inserts …" (201, and findRecyclable called).
5. PATCH: put back `return NextResponse.json({ error: "Failed to check category" }, { status: 500 });`. Red: "PATCH logs the failed category check".
6. DELETE: put back the unlogged 500. Red: "DELETE logs the failed soft delete".
7. Each bulk route: put back its unlogged 500. Red: the matching "bulk item routes" case.
8. Each of the 8 category sites: put back its `NextResponse.json(... 500)`. Red: the matching "failed database calls are logged" case.
9. `ready/route.ts`:
   - Delete `if (listError) …`. Red: "ready › answers a logged 500 … list read fails" (404).
   - Delete `if (senderError) …`. Red: "ready › … sender read fails" (200, and the message is sent signed Someone).
   - Change the sender `.maybeSingle()` back to `.single()`. Red: "ready › signs the message 'Someone' only when the sender has no row" (500).
   - Change the list `.maybeSingle()` back to `.single()`. Red: "ready › answers 404 …" (500).
10. `remind/route.ts`: the same four undos. Red: the same four tests under "remind".

- [ ] **Step 7: Commit**

```bash
git add "app/api/lists/[id]/items/route.ts" "app/api/lists/[id]/items/clear-completed/route.ts" "app/api/lists/[id]/items/unmark-completed/route.ts" "app/api/lists/[id]/items/unskip-all/route.ts" "app/api/lists/[id]/categories/route.ts" "app/api/lists/[id]/categories/[categoryId]/route.ts" "app/api/lists/[id]/categories/order/route.ts" "app/api/lists/[id]/ready/route.ts" "app/api/lists/[id]/remind/route.ts" __tests__/unit/items-route-db-errors.test.ts __tests__/unit/signal-routes-db-errors.test.ts __tests__/unit/categories-routes.test.ts
git commit -m "$(cat <<'EOF'
fix(api): check item, category and signal route DB errors

Adding items no longer falls back to position 1 or skips the duplicate
check when a read fails: POST answers 500 before any insert, so the queue
retries. Ready and remind send nothing when the sender name cannot be
read, instead of signing the message "Someone", and tell a failed list
read (500) from a missing list (404). Every existing unlogged 500 in the
item, bulk and category routes now logs its cause with the list id.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
)"
```

### Task 4: Items PATCH: DB error is a retryable 500

Today the items PATCH handler answers every failed update with a 404 (`if (error || !item)`). The offline queue drops 4xx, so a passing DB blip during a toggle, edit, skip, order, restore or category move loses the change on the server, while the screen shows it as applied. Also, after a text edit the category reset ignores its own error, so the item can keep a stale category for good. After this task a DB error is a logged 500 (the queue retries it), only a missing row is a 404, and a failed reset is a logged 500 with no categorize run. The queue's replay of the same edit then redoes the reset.

**Files:**
- Modify: `app/api/lists/[id]/items/route.ts` (PATCH handler only: the update result check and the category reset after a text edit)
- Create (test): `__tests__/unit/items-patch-db-errors.test.ts`
- No existing test needs changes (checked: `items-route-categorize.test.ts`, `items-completion-no-reminders.test.ts`, `no-deleted-item-leak.test.ts`, `recycle-scoping.test.ts`, `items-get-columns.test.ts`; the fake records `.single()` and `.maybeSingle()` the same way and their PATCH mocks already return `error: null`).

**Interfaces:**
- Consumes (Task 1): `dbError(tag: string, what: string, error: unknown, ctx?: Record<string, unknown>): NextResponse` from `@/src/lib/api-errors`. It logs `console.error(\`[${tag}] ${what} failed:\`, ctx, error)` and returns `NextResponse.json({ error: \`${what} failed\` }, { status: 500 })`.
- State of the file after earlier tasks (anchor on code, not line numbers):
  - Task 1 replaced the PATCH body read `const body = await request.json();` with `readJsonBody(request, ...)`. Not touched here.
  - Task 2 made `verifyListPermission` throw on a DB error. The PATCH permission check is unchanged in this file.
  - Task 3 already added `import { dbError } from "@/src/lib/api-errors";` to this file (for the items GET/POST sites), and switched the PATCH category check (`if (categoryError)`, "Failed to check category") to `dbError`. **The import is already there (ruling R4); do not add it again.** Do not touch the category check.
- Produces: nothing new for later tasks. Behavior later tasks rely on: `PATCH /api/lists/[id]/items` answers **500** `{ error: "Item update failed" }` on a DB error, **404** `{ error: "Item not found" }` only when no active row matched (including an undo-restore of an already-purged row), and **500** `{ error: "Category reset failed" }` when the post-edit reset fails. Task 7's `restoreItemsOnServer` sees a non-ok status in both failure cases.

**Sites:**

| site (file:line as of today) | today on failure | change | user-visible result |
|---|---|---|---|
| `app/api/lists/[id]/items/route.ts:415-422` (`query.select().single()` + `if (error \|\| !item)` 404) | A DB error and "no row" both return 404 "Item not found or update failed", nothing logged. The queue drops the 404 and the change never reaches the server. | `.maybeSingle()` so zero rows is `{ data: null, error: null }`. `if (error) return dbError("items/PATCH", "Item update", error, { listId, itemId })`. Then `if (!item)` warns with the IDs and returns 404 "Item not found". | During a DB blip the toggle or edit is retried silently and saved once the DB recovers. A deleted or missing item still gets 404, so the queue drops it as before. |
| `app/api/lists/[id]/items/route.ts:427-434` (category reset `update({ category_id: null })` after a text edit) | The error is ignored, `scheduleCategorize` runs anyway, and the item keeps its old category for good (the pending sweep only picks uncategorized items). 200, nothing logged. | Destructure `{ error: resetError }`. On error, `return dbError("items/PATCH", "Category reset", resetError, { listId, itemId })` before `scheduleCategorize`. | The edit itself was saved. The queue retries the same edit, the replay redoes the reset, and the item is re-sorted under the right category. No new UI: 5xx retries are silent, as designed. |

- [ ] **Step 1: Write the failing tests**

Create `__tests__/unit/items-patch-db-errors.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
  after: [] as (() => unknown)[],
  categorize: vi.fn(async () => {}),
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "owner" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));
vi.mock("@/src/services/categorize-list", () => ({ categorizeList: h.categorize }));
vi.mock("@/src/services/item-recycler", () => ({ findRecyclableItems: async () => [], recycleItem: async () => null }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => { h.after.push(fn); },
}));

import { PATCH } from "@/app/api/lists/[id]/items/route";

const params = { params: Promise.resolve({ id: "L" }) };
function patch(body: unknown) {
  return new NextRequest("https://app.test/api/lists/L/items", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function use(resolve: (c: FakeCall) => FakeResult) {
  h.fake = fakeSupabase(resolve) as typeof h.fake;
}
const updates = () => h.fake.calls.filter((c) => c.table === "items" && c.op === "update");
// The post-edit reset is the update that sets only category_id = null.
const isReset = (c: FakeCall) =>
  c.table === "items" && c.op === "update" &&
  JSON.stringify(c.values) === JSON.stringify({ category_id: null });

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.after = [];
  h.categorize.mockClear();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// The offline queue drops 4xx and retries 5xx. A DB error on the update must not read
// as "item not found", or the user's change is lost on the server.
describe("PATCH /api/lists/[id]/items DB failures", () => {
  it("a DB error on the update is a logged 500, so the queue retries the change", async () => {
    const dbErr = { message: "canceling statement due to statement timeout", code: "57014" };
    use((c) => c.table === "items" && c.op === "update"
      ? { data: null, error: dbErr }
      : { data: null, error: null });

    const res = await PATCH(patch({ itemId: "a", completed: true }), params);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Item update failed" });
    expect(errorSpy).toHaveBeenCalledWith(
      "[items/PATCH] Item update failed:",
      { listId: "L", itemId: "a" },
      dbErr
    );
    expect(updates()).toHaveLength(1);
    expect(h.after).toEqual([]);
  });

  it("a text edit whose update fails never runs the category reset or a categorize", async () => {
    const dbErr = { message: "connection reset" };
    use((c) => c.table === "items" && c.op === "update"
      ? { data: null, error: dbErr }
      : { data: null, error: null });

    const res = await PATCH(patch({ itemId: "a", text: "oat milk" }), params);

    expect(res.status).toBe(500);
    expect(h.fake.calls.filter(isReset)).toEqual([]);
    expect(h.after).toEqual([]);
  });

  it("an update that matches no row is a 404 with no error log", async () => {
    use(() => ({ data: null, error: null }));

    const res = await PATCH(patch({ itemId: "gone", completed: true }), params);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Item not found" });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("[items/PATCH] Item not found:", { listId: "L", itemId: "gone" });
  });

  // PostgREST answers zero rows under .single() with PGRST116 as an *error*, and under
  // .maybeSingle() with { data: null, error: null }. This fake behaves the same way, so
  // a deleted row (e.g. an undo-restore of a purged item) must stay a 404 that the queue
  // drops, not a 500 it retries for 24 hours.
  it("a deleted row stays a 404, the way PostgREST reports zero rows", async () => {
    use((c) => {
      if (c.table === "items" && c.op === "update") {
        return c.filters.includes("single")
          ? { data: null, error: { code: "PGRST116", details: "The result contains 0 rows", message: "JSON object requested, multiple (or no) rows returned" } }
          : { data: null, error: null };
      }
      return { data: null, error: null };
    });

    const res = await PATCH(patch({ itemId: "a", deleted_at: null }), params);

    expect(res.status).toBe(404);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("a failed category reset after a text edit is a logged 500 and schedules no categorize", async () => {
    const resetErr = { message: "deadlock detected", code: "40P01" };
    use((c) => {
      if (isReset(c)) return { data: null, error: resetErr };
      if (c.table === "items" && c.op === "update") {
        return { data: { id: "a", text: "oat milk", category_locked: false }, error: null };
      }
      return { data: null, error: null };
    });

    const res = await PATCH(patch({ itemId: "a", text: "oat milk" }), params);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Category reset failed" });
    expect(errorSpy).toHaveBeenCalledWith(
      "[items/PATCH] Category reset failed:",
      { listId: "L", itemId: "a" },
      resetErr
    );
    expect(h.fake.calls.filter(isReset)).toHaveLength(1);
    expect(h.after).toEqual([]);
    expect(h.categorize).not.toHaveBeenCalled();
  });

  it("a successful reset after a text edit still answers 200 with the item and schedules a run", async () => {
    use((c) => {
      if (isReset(c)) return { data: null, error: null };
      if (c.table === "items" && c.op === "update") {
        return { data: { id: "a", text: "oat milk", category_locked: false }, error: null };
      }
      return { data: null, error: null };
    });

    const res = await PATCH(patch({ itemId: "a", text: "oat milk" }), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "a", text: "oat milk" });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(h.after).toHaveLength(1);
    for (const fn of h.after) await fn();
    expect(h.categorize).toHaveBeenCalledWith(expect.anything(), "L", "pending");
  });
});
```

- [ ] **Step 2: Run them, expect FAIL**

```bash
npx vitest run __tests__/unit/items-patch-db-errors.test.ts
```

Expected:
- "a DB error on the update is a logged 500" FAILS: status is 404 (today's `error || !item` branch), and nothing is logged.
- "a text edit whose update fails never runs the category reset" FAILS: status is 404, not 500.
- "an update that matches no row is a 404 with no error log" FAILS: the body is `"Item not found or update failed"` and no warn is logged.
- "a failed category reset ... is a logged 500" FAILS: status is 200, because the reset's error is ignored and `scheduleCategorize` runs.
- "a deleted row stays a 404" and "a successful reset ... answers 200" PASS already. They are regression guards for the `.maybeSingle()` switch and for the happy path.

- [ ] **Step 3: Implementation**

In `app/api/lists/[id]/items/route.ts`:

**3a. Import.** Task 3b already added it (ruling R4); confirm this line exists and skip:

```ts
import { dbError } from "@/src/lib/api-errors";
```

**3b. The update result (today lines 415-422).** Current:

```ts
  const { data: item, error } = await query.select().single();

  if (error || !item) {
    return NextResponse.json(
      { error: "Item not found or update failed" },
      { status: 404 }
    );
  }
```

Replace with:

```ts
  // maybeSingle: zero rows (missing, or already deleted) is { data: null, error: null },
  // so `error` is always a real DB failure. That must be a 500, which the queue retries;
  // a 404 would make it drop the change.
  const { data: item, error } = await query.select().maybeSingle();

  if (error) return dbError("items/PATCH", "Item update", error, { listId, itemId });
  if (!item) {
    console.warn("[items/PATCH] Item not found:", { listId, itemId });
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }
```

**3c. The category reset (today lines 426-435).** Current:

```ts
  if (typeof patchData.text === "string" && !updates.categoryId && item.category_locked === false) {
    await supabase
      .from("items")
      .update({ category_id: null })
      .eq("id", itemId)
      .eq("list_id", listId)
      .eq("category_locked", false)
      .eq("text", patchData.text);
    scheduleCategorize(supabase, listId);
  }
```

Replace with:

```ts
  if (typeof patchData.text === "string" && !updates.categoryId && item.category_locked === false) {
    const { error: resetError } = await supabase
      .from("items")
      .update({ category_id: null })
      .eq("id", itemId)
      .eq("list_id", listId)
      .eq("category_locked", false)
      .eq("text", patchData.text);
    // The edit is saved, but a 500 makes the queue replay it, and the replay redoes the
    // reset. Otherwise the item keeps its old category for good.
    if (resetError) return dbError("items/PATCH", "Category reset", resetError, { listId, itemId });
    scheduleCategorize(supabase, listId);
  }
```

Leave the comment above this `if` ("A text change re-sorts the item...") as it is. Do not touch anything else in the handler.

Why `.maybeSingle()` is safe on an UPDATE: in the installed `@supabase/postgrest-js` 2.95.3 (`node_modules/@supabase/postgrest-js/dist/index.cjs`), `maybeSingle()` on a non-GET sends the object Accept header, and a zero-row answer's PGRST116 error (details contain "0 rows") is turned into `{ data: null, error: null }`. The repo already uses `update(...).select().maybeSingle()` in `app/api/lists/[id]/categories/[categoryId]/route.ts`.

- [ ] **Step 4: Update existing tests/mocks**

None. Checked:
- `__tests__/unit/items-route-categorize.test.ts`: the PATCH mocks return `{ data: {...}, error: null }` for the item update and `{ data: null, error: null }` for the reset, so the "clears its category and schedules a run" test still gets 200 and a scheduled run. The "category check fails" test still gets 500 (Task 3 owns that branch).
- `__tests__/unit/items-completion-no-reminders.test.ts`: the item update returns `{ data, error: null }`, so it still gets 200 with exactly one call.
- `__tests__/unit/no-deleted-item-leak.test.ts` slices the source between `if (updates.restoreRecurring === true)` and `// Allow restoring soft-deleted items`, neither of which changes.
- The fake records `.single()` and `.maybeSingle()` as filters only, and no existing test asserts the `single` filter on the PATCH update.

- [ ] **Step 5: Run tests, expect PASS**

```bash
npx vitest run __tests__/unit/items-patch-db-errors.test.ts __tests__/unit/items-route-categorize.test.ts __tests__/unit/items-completion-no-reminders.test.ts __tests__/unit/no-deleted-item-leak.test.ts __tests__/unit/no-silent-catches.test.ts __tests__/unit/executor-factory.test.ts __tests__/unit/mutation-queue.test.ts
npx tsc --noEmit
npx eslint "app/api/lists/[id]/items/route.ts" __tests__/unit/items-patch-db-errors.test.ts
```

Expected: all green, no type errors, no lint errors. `executor-factory.test.ts` already proves the client update executor throws `"...: 500"` on a 500 (the status the queue keeps and retries; the keep/drop rule is in `src/hooks/useMutationQueue.ts:75-86` and is unchanged).

- [ ] **Step 6: Make it bite**

Remove each check, run `npx vitest run __tests__/unit/items-patch-db-errors.test.ts`, confirm the named test goes red, then restore it:
1. Delete `if (error) return dbError("items/PATCH", "Item update", error, { listId, itemId });`. Red: "a DB error on the update is a logged 500, so the queue retries the change" (gets 404 from the `!item` branch) and "a text edit whose update fails never runs the category reset" (gets 404). Restore.
2. Change `.maybeSingle()` back to `.single()` on the update. Red: "a deleted row stays a 404, the way PostgREST reports zero rows" (gets 500, and console.error is called). Restore.
3. Delete `if (resetError) return dbError("items/PATCH", "Category reset", resetError, { listId, itemId });`. Red: "a failed category reset after a text edit is a logged 500 and schedules no categorize" (gets 200 and a scheduled run). Restore.

Re-run the Step 5 commands once more after restoring everything.

- [ ] **Step 7: Commit**

```bash
git add "app/api/lists/[id]/items/route.ts" __tests__/unit/items-patch-db-errors.test.ts
git commit -m "$(cat <<'EOF'
fix(items): a DB error on item PATCH is a retryable 500, not a dropped 404

The update used .single() and answered `error || !item` with 404, so a DB
blip made the offline queue drop the user's toggle or edit. The update now
uses .maybeSingle(): a real error logs and returns 500 (the queue retries),
and only a missing row returns 404. A failed category reset after a text
edit now returns a logged 500 before scheduling a categorize run, so the
queue's replay redoes the reset instead of leaving a stale category.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
)"
```

### Task 5: Voice receipt lists only what happened

The voice handler (`src/services/voice-handler.ts`) reads only `data` from every Supabase call. A failed insert or soft-delete is still receipted as "Added"/"Removed". A failed recycle is receipted as "(recycled)". A failed lists read quietly shrinks the set of target lists, so items can land in the wrong list. A failed user lookup tells a registered user to "open the app first". This task makes whole-message reads abort to the existing outer catch (which sends `voice.error`). It isolates per-item failures with the new `voice.itemFailed` line, and skips a receipt for a list where nothing changed.

**Files:**
- Modify: `src/services/voice-handler.ts`
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json` (add `voice.itemFailed`)
- Modify: `__tests__/helpers/fake-supabase.ts` (no change: Task 2b added `.ilike`, ruling R4)
- Modify: `__tests__/unit/recycle-scoping.test.ts` (the voice handler's two `recycleItem(` calls become one)
- Create/Test: `__tests__/unit/voice-handler-failures.test.ts`

**Interfaces:**
- Consumes, from T2 (`src/services/item-recycler.ts`, signatures unchanged):
  - `findFuzzyMatch(listId: string, text: string): Promise<RecyclableItem[]>`. After T2 it rejects when its ILIKE fallback read fails.
  - `recycleItem(itemId: string, userId: string, listId: string): Promise<RecyclableItem | null>`. After T2 it rejects on any DB error and resolves `null` only when the row is genuinely missing.
  - This task needs nothing else from T2. The new tests mock the recycler module, so they pass whether or not T2 has landed.
- Consumes nothing from T1, T3 or T4. The shared `dbError` in `src/lib/api-errors.ts` returns a `NextResponse` and does not fit a bot flow, so the voice handler gets its own private helper under a different name to avoid confusion.
- Produces nothing exported. Private to `src/services/voice-handler.ts`:
  - `function dbFailure(what: string, error: { code?: string; message?: string }): Error`
  - `async function softDeleteItem(supabase: SupabaseClient, itemId: string): Promise<void>`
  - `async function recycleOrThrow(itemId: string, userId: string, listId: string): Promise<void>`
- Produces i18n key `voice.itemFailed` (en/he/ru text exactly as the spec gives it).
- Produces test helper `fakeSupabase` chain method `.ilike(k, v)`, which records filter `ilike:<k>=<v>`.

**Sites:**

| site (as of today) | today on failure | change | user-visible result |
|---|---|---|---|
| voice-handler.ts:80-84 user lookup `.single()` | error gives `user = null`, so the user gets `voice.noUser` ("open the app first") | `.maybeSingle()`, and an error throws `dbFailure("User lookup")` | `voice.error`. A genuinely unregistered user still gets `voice.noUser` |
| :113-117 owned lists | error is read as `[]`. Owned lists vanish, items default to a shared list | error throws `dbFailure("Owned lists read")` | `voice.error`, nothing written, Gemini not called |
| :119-123 collaborators | error is read as `[]`. Shared lists vanish | throws `dbFailure("Collaborators read")` | same |
| :131-136 shared list names | error is read as `[]` | throws `dbFailure("Shared lists read")` | same |
| :147-152 archived state | error is read as `[]`. Archived lists become targets | throws `dbFailure("Archived lists read")` | same |
| :198-200 Telegram download | `res.ok` unchecked. A 404 body is sent to Gemini as audio | throws `Telegram voice download failed: <status>` before Gemini, and never logs `fileUrl` | `voice.error`, and no billed Gemini call |
| :300-322 item loop | any throw from one item aborts the whole message with `voice.error`, after earlier items were already written but never receipted | try/catch per item: log `{action, chatId, listId}` + error, send `voice.itemFailed` (its own logged try/catch), continue | "Couldn't update 'X' in List. Please try again." for that item, normal receipt for the rest |
| :328 receipt loop | a list with nothing added or removed still gets an empty "Updated List:" message. This already happens today when a removal finds nothing | `continue` when `added` and `removed` are both empty | no empty receipt |
| :360 outer catch log | `"[VoiceHandler] Processing error:", error`, with no chatId | `"[VoiceHandler] Processing error, chatId:", chatId, error` | log only |
| :405 and :418 `recycleItem` result ignored | a `null` result or a rejection is ignored or aborts. The receipt says "(recycled)" while the item stays completed | both call `recycleOrThrow`, which throws on `null`. The per-item catch handles it | `voice.itemFailed`, no "(recycled)" claim, no duplicate insert |
| :426-433 max position | error gives `nextPosition = 1` | throws `dbFailure("Max position read")` before the insert | `voice.itemFailed`, nothing inserted |
| :435-442 insert | error ignored, item receipted as added | throws `dbFailure("Item insert")` before `receipt.added.push` | `voice.itemFailed`, item not in receipt |
| :459-467 exact lookup | error falls through to fuzzy, then "not found" | throws `dbFailure("Exact match lookup")` | `voice.itemFailed`, never a false "Couldn't find" |
| :471-474 soft-delete (exact) | error ignored, item receipted as removed | `softDeleteItem` throws `dbFailure("Item soft-delete")` | `voice.itemFailed`, item not in receipt |
| :480-486 fuzzy lookup | error skips the fuzzy block, then "not found" | throws `dbFailure("Fuzzy match lookup")` | `voice.itemFailed` |
| :501-504 soft-delete (fuzzy) | same as :471 | `softDeleteItem` | same as :471 |
| :511-518 completed check | error says "not found" instead of "already checked off" | throws `dbFailure("Completed match lookup")` | `voice.itemFailed` |
| messages/{en,he,ru}.json | key does not exist | add `voice.itemFailed` right after `voice.notFound` | the new line in all 3 languages |

Notes for the implementer:
- Keep the function order: `handleVoiceMessage` stays before `processAddItem`. `__tests__/unit/voice-categorize-wiring.test.ts` slices the source between them and looks for `} catch (error) {` after the receipts loop. The new per-item catch is named `itemErr` and sits before the receipts loop, and the outer catch keeps the name `error`.
- `dbFailure` keeps only `code` and `message`. A PostgREST `details` field can quote row values, and item text must never be logged.
- Nothing extra is needed for Telegram redaction in the outer catch. `redactTelegramErrors` is a class-level hook that `getBot()` installs. Any Telegram error can only exist after the bot was created, so the existing `console.error(..., error)` is already safe.

- [ ] **Step 1: write the failing tests.** First give the fake Supabase builder `.ilike`. The voice handler's remove flow calls it, and the helper doesn't support it today. Task 2b already added `.ilike` (ruling R4): skip this sub-step.

In `__tests__/helpers/fake-supabase.ts`, current:
```ts
    c.limit = (n: number) => add(`limit:${n}`);
```
Replacement:
```ts
    c.limit = (n: number) => add(`limit:${n}`);
    c.ilike = (k: string, v: unknown) => add(`ilike:${k}=${v}`);
```

Then create `__tests__/unit/voice-handler-failures.test.ts` with exactly this content. It runs the real `handleVoiceMessage` and the real `src/services/bot.ts` (real `getMsg`, real `messages/*.json`). It uses a fake `node-telegram-bot-api` class, like `bot-command-errors.test.ts`, plus a `fakeSupabase` database and a stubbed `fetch`. Gemini, Redis, rate-limit, categorizer and recycler are mocked.

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { format } from "util";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

// postgrest resolves a failed call with { data: null, error } instead of rejecting. The voice
// handler used to read only `data`, so a failed insert or soft-delete was still receipted as
// "Added"/"Removed", and a failed lists read quietly shrank the set of target lists. These run
// the real handleVoiceMessage and the real bot module (real getMsg, real messages) against a
// fake Telegram client, a fake database and a stubbed download. Gemini, Redis and the
// recycler are mocked.
const h = vi.hoisted(() => ({
  sent: [] as { chatId: number; text: string }[],
  db: null as null | { client: unknown; calls: unknown[] },
  process: null as null | ReturnType<typeof import("vitest").vi.fn>,
  fuzzy: null as null | ReturnType<typeof import("vitest").vi.fn>,
  recycle: null as null | ReturnType<typeof import("vitest").vi.fn>,
}));

const FILE_URL = "https://api.telegram.org/file/bot123456:BOT_TOKEN_SECRET/voice/file_1.oga";

vi.mock("@/src/lib/env", () => ({
  serverEnv: () => ({ TELEGRAM_BOT_TOKEN: "123456:BOT_TOKEN_SECRET", NEXT_PUBLIC_APP_URL: "https://app.test" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.db!.client }));
vi.mock("@/src/utils/redis-lock", () => ({
  acquireVoiceLock: async () => true,
  releaseVoiceLock: async () => {},
}));
vi.mock("@/src/lib/rate-limit", () => ({
  voiceRateLimiter: {},
  checkRateLimit: async () => ({ success: true }),
}));
vi.mock("@/src/services/voice-processor", () => ({
  getVoiceProcessor: () => ({ process: (...args: unknown[]) => h.process!(...args) }),
}));
vi.mock("@/src/services/item-recycler", () => ({
  findFuzzyMatch: (...args: unknown[]) => h.fuzzy!(...args),
  recycleItem: (...args: unknown[]) => h.recycle!(...args),
}));
vi.mock("@/src/services/categorize-list", () => ({ categorizeList: async () => {} }));
vi.mock("node-telegram-bot-api", () => ({
  default: class FakeTelegramBot {
    onText() {}
    async sendMessage(chatId: number, text: string) {
      h.sent.push({ chatId, text });
      return {};
    }
    async sendChatAction() {
      return true;
    }
    async getFileLink() {
      return FILE_URL;
    }
  },
}));

import { handleVoiceMessage } from "@/src/services/voice-handler";

type Item = { action: "add" | "remove"; text: string; targetList: string | null };
const dbErr = { code: "XX000", message: "db unavailable" };
const ok = (data: unknown): FakeResult => ({ data, error: null });
const fail: FakeResult = { data: null, error: dbErr };

// A user with two lists, no shared lists, nothing archived, items at position 3.
// `override` returns a result for the call it wants to change, or undefined to keep the default.
function world(override: (call: FakeCall) => FakeResult | undefined = () => undefined) {
  return fakeSupabase((call) => {
    const o = override(call);
    if (o) return o;
    if (call.table === "users") return ok({ id: "u1", language: "en" });
    if (call.table === "lists") return ok([{ id: "L1", name: "Groceries" }, { id: "L2", name: "Home" }]);
    if (call.table === "collaborators") return ok([]);
    if (call.table === "user_list_state") return ok([]);
    if (call.table === "items" && call.op === "select" && call.cols === "position") return ok([{ position: 3 }]);
    if (call.table === "items" && call.op === "insert") return ok({ id: "new-item" });
    if (call.table === "items" && call.op === "update") return ok(null);
    if (call.table === "items" && call.op === "select") return ok([]);
    throw new Error(`unexpected call ${call.table} ${call.op}`);
  });
}

const insertOf = (call: FakeCall, text: string) =>
  call.table === "items" && call.op === "insert" && (call.values as { text: string }).text === text;
const isExactLookup = (call: FakeCall) =>
  call.table === "items" && call.op === "select" && call.cols === "id, text" && call.filters.some((f) => f.startsWith("ilike:"));
const isFuzzyLookup = (call: FakeCall) =>
  call.table === "items" && call.op === "select" && call.cols === "id, text" && call.filters.includes("limit:200");
const isCompletedLookup = (call: FakeCall) =>
  call.table === "items" && call.op === "select" && call.cols === "text" && call.filters.includes("eq:completed=true");
const itemWrites = () =>
  (h.db!.calls as FakeCall[]).filter((c) => c.table === "items" && (c.op === "insert" || c.op === "update"));

async function speak(items: Item[]) {
  h.process!.mockResolvedValue({ items });
  await handleVoiceMessage(42, 7, { file_id: "f1", file_unique_id: "u-f1", duration: 3 }, { id: 7, first_name: "A", language_code: "en" });
}
const texts = () => h.sent.map((m) => m.text);
const itemFailed = (item: string, list: string) => `Couldn't update '${item}' in ${list}. Please try again.`;
const VOICE_ERROR = "Sorry, I couldn't understand that. Please try again or use the app.";

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  h.sent = [];
  h.db = world();
  h.process = vi.fn();
  h.fuzzy = vi.fn().mockResolvedValue([]);
  h.recycle = vi.fn();
  fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("voice: a failed item is never receipted, the rest still are", () => {
  it("baseline: a saved item is receipted at the next position", async () => {
    await speak([{ action: "add", text: "milk", targetList: "Groceries" }]);
    expect(texts()).toEqual(["Added to Groceries:\n- milk"]);
    const insert = (h.db!.calls as FakeCall[]).find((c) => c.op === "insert");
    expect(insert?.values).toMatchObject({ list_id: "L1", text: "milk", position: 4 });
  });

  it("insert fails: that item gets voice.itemFailed, the other item is still receipted", async () => {
    h.db = world((c) => (insertOf(c, "milk") ? fail : undefined));
    await speak([
      { action: "add", text: "milk", targetList: "Groceries" },
      { action: "add", text: "eggs", targetList: "Groceries" },
    ]);

    expect(texts()).toEqual([itemFailed("milk", "Groceries"), "Added to Groceries:\n- eggs"]);
    expect(errorSpy).toHaveBeenCalledWith(
      "[VoiceHandler] Item update failed:",
      { action: "add", chatId: 42, listId: "L1" },
      expect.objectContaining({ message: expect.stringContaining("Item insert failed: XX000 db unavailable") })
    );
    // Item text never reaches the logs.
    expect(errorSpy.mock.calls.map((a) => format(...a)).join("\n")).not.toContain("milk");
  });

  it("max position read fails: nothing is inserted for that item and it is not receipted", async () => {
    h.db = world((c) => (c.table === "items" && c.cols === "position" ? fail : undefined));
    await speak([{ action: "add", text: "milk", targetList: "Groceries" }]);

    expect(itemWrites()).toEqual([]);
    expect(texts()).toEqual([itemFailed("milk", "Groceries")]);
    expect(errorSpy).toHaveBeenCalledWith(
      "[VoiceHandler] Item update failed:",
      { action: "add", chatId: 42, listId: "L1" },
      expect.objectContaining({ message: expect.stringContaining("Max position read failed") })
    );
  });

  it.each([
    ["resolves null (the row is gone)", () => h.recycle!.mockResolvedValue(null)],
    ["rejects (a DB error)", () => h.recycle!.mockRejectedValue(new Error("[ItemRecycler] Recycle update failed"))],
  ])("recycleItem %s: voice.itemFailed, no '(recycled)' claim and no duplicate insert", async (_label, arrange) => {
    h.fuzzy!.mockResolvedValue([{ id: "old-milk", text: "milk", completed: true, completed_at: null, deleted_at: null, position: 1 }]);
    arrange();
    await speak([{ action: "add", text: "milk", targetList: "Groceries" }]);

    expect(h.recycle).toHaveBeenCalledWith("old-milk", "u1", "L1");
    expect(texts()).toEqual([itemFailed("milk", "Groceries")]);
    expect(itemWrites()).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      "[VoiceHandler] Item update failed:",
      { action: "add", chatId: 42, listId: "L1" },
      expect.any(Error)
    );
  });

  it("a successful recycle is still receipted with the recycled label", async () => {
    h.fuzzy!.mockResolvedValue([{ id: "old-milk", text: "milk", completed: true, completed_at: null, deleted_at: null, position: 1 }]);
    h.recycle!.mockResolvedValue({ id: "old-milk", text: "milk", completed: false, completed_at: null, deleted_at: null, position: 4 });
    await speak([{ action: "add", text: "milk", targetList: "Groceries" }]);
    expect(texts()).toEqual(["Added to Groceries:\n- milk (recycled)"]);
  });

  it("findFuzzyMatch rejects: voice.itemFailed and no insert", async () => {
    h.fuzzy!.mockRejectedValue(new Error("[ItemRecycler] Recyclable items read failed"));
    await speak([{ action: "add", text: "milk", targetList: "Groceries" }]);
    expect(texts()).toEqual([itemFailed("milk", "Groceries")]);
    expect(itemWrites()).toEqual([]);
  });

  it("soft-delete (exact match) fails: the item is not in the 'Removed' receipt", async () => {
    h.db = world((c) => {
      if (isExactLookup(c)) return ok([{ id: "i-milk", text: "milk" }]);
      if (c.table === "items" && c.op === "update") return fail;
      return undefined;
    });
    await speak([
      { action: "remove", text: "milk", targetList: "Groceries" },
      { action: "add", text: "eggs", targetList: "Groceries" },
    ]);

    expect(texts()).toEqual([itemFailed("milk", "Groceries"), "Added to Groceries:\n- eggs"]);
    expect(errorSpy).toHaveBeenCalledWith(
      "[VoiceHandler] Item update failed:",
      { action: "remove", chatId: 42, listId: "L1" },
      expect.objectContaining({ message: expect.stringContaining("Item soft-delete failed") })
    );
  });

  it("soft-delete (fuzzy match) fails: the item is not in the 'Removed' receipt", async () => {
    h.db = world((c) => {
      if (isFuzzyLookup(c)) return ok([{ id: "i-milk", text: "milk" }]);
      if (c.table === "items" && c.op === "update") return fail;
      return undefined;
    });
    await speak([{ action: "remove", text: "milky", targetList: "Groceries" }]);

    expect(texts()).toEqual([itemFailed("milky", "Groceries")]);
  });

  it("a successful removal is still receipted", async () => {
    h.db = world((c) => (isExactLookup(c) ? ok([{ id: "i-milk", text: "milk" }]) : undefined));
    await speak([{ action: "remove", text: "milk", targetList: "Groceries" }]);
    expect(texts()).toEqual(["Removed from Groceries:\n- milk"]);
    const update = itemWrites()[0];
    expect(update.filters).toContain("eq:id=i-milk");
  });

  it.each([
    ["exact lookup", isExactLookup],
    ["fuzzy lookup", isFuzzyLookup],
    ["completed check", isCompletedLookup],
  ])("remove: a failed %s says 'couldn't update', never 'not found'", async (_label, isFailing) => {
    h.db = world((c) => (isFailing(c) ? fail : undefined));
    await speak([{ action: "remove", text: "milk", targetList: "Groceries" }]);

    expect(texts()).toEqual([itemFailed("milk", "Groceries")]);
    expect(itemWrites()).toEqual([]);
  });
});

describe("voice: no empty receipt", () => {
  it("a list where every item failed gets no 'Added to'/'Updated' message; other lists still do", async () => {
    h.db = world((c) => (insertOf(c, "milk") || insertOf(c, "eggs") ? fail : undefined));
    await speak([
      { action: "add", text: "milk", targetList: "Groceries" },
      { action: "add", text: "eggs", targetList: "Groceries" },
      { action: "add", text: "nails", targetList: "Home" },
    ]);

    expect(texts()).toEqual([
      itemFailed("milk", "Groceries"),
      itemFailed("eggs", "Groceries"),
      "Added to Home:\n- nails",
    ]);
  });

  it("a removal that found nothing sends only 'Couldn't find', not an empty 'Updated' message", async () => {
    await speak([{ action: "remove", text: "milk", targetList: "Groceries" }]);
    expect(texts()).toEqual(["Couldn't find 'milk' in Groceries."]);
  });
});

describe("voice: a failed whole-message read stops with voice.error", () => {
  it("user lookup fails: voice.error, not 'open the app first'", async () => {
    h.db = world((c) => (c.table === "users" ? fail : undefined));
    await speak([{ action: "add", text: "milk", targetList: "Groceries" }]);

    expect(texts()).toEqual([VOICE_ERROR]);
    expect(h.process).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "[VoiceHandler] Processing error, chatId:",
      42,
      expect.objectContaining({ message: expect.stringContaining("User lookup failed: XX000 db unavailable") })
    );
  });

  it("an unregistered user (no row) still gets 'open the app first'", async () => {
    // Real PostgREST: .single() reports zero rows as error PGRST116; .maybeSingle() returns null.
    h.db = world((c) =>
      c.table === "users"
        ? c.filters.includes("single")
          ? { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } }
          : ok(null)
        : undefined
    );
    await speak([{ action: "add", text: "milk", targetList: "Groceries" }]);

    expect(texts()).toEqual(["Please open the app first to get started!"]);
    expect(h.process).not.toHaveBeenCalled();
  });

  it.each([
    ["owned lists", "Owned lists read failed", (c: FakeCall) => c.table === "lists" && c.filters.includes("eq:owner_id=u1")],
    ["collaborators", "Collaborators read failed", (c: FakeCall) => c.table === "collaborators"],
    ["shared lists", "Shared lists read failed", (c: FakeCall) => c.table === "lists" && c.filters.some((f) => f.startsWith("in:id="))],
    ["archived state", "Archived lists read failed", (c: FakeCall) => c.table === "user_list_state"],
  ])("%s read fails: voice.error, Gemini is never called, nothing is written", async (_label, what, isFailing) => {
    h.db = world((c) => {
      if (isFailing(c)) return fail;
      // One shared list with edit rights, so the shared-lists read runs.
      if (c.table === "collaborators") return ok([{ list_id: "S1", permission: "edit" }]);
      if (c.table === "lists" && c.filters.some((f) => f.startsWith("in:id="))) return ok([{ id: "S1", name: "Shared" }]);
      return undefined;
    });
    await speak([{ action: "add", text: "milk", targetList: null }]);

    expect(texts()).toEqual([VOICE_ERROR]);
    expect(h.process).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(itemWrites()).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      "[VoiceHandler] Processing error, chatId:",
      42,
      expect.objectContaining({ message: expect.stringContaining(what) })
    );
  });
});

describe("voice: the Telegram download is checked before Gemini", () => {
  it("a 404 download: voice.error, Gemini never called, status logged, file URL never logged", async () => {
    fetchMock.mockResolvedValue(new Response("Not Found", { status: 404 }));
    await speak([{ action: "add", text: "milk", targetList: "Groceries" }]);

    expect(h.process).not.toHaveBeenCalled();
    expect(texts()).toEqual([VOICE_ERROR]);
    expect(errorSpy).toHaveBeenCalledWith(
      "[VoiceHandler] Processing error, chatId:",
      42,
      expect.objectContaining({ message: "Telegram voice download failed: 404" })
    );
    const logged = [...errorSpy.mock.calls, ...warnSpy.mock.calls].map((a) => format(...a)).join("\n");
    expect(logged).not.toContain("BOT_TOKEN_SECRET");
  });
});
```

- [ ] **Step 2: run the tests. Expected FAIL.**

```bash
npx vitest run __tests__/unit/voice-handler-failures.test.ts
```
Expected: 18 failed, 4 passed. The 4 that pass today are the baseline add, the successful recycle, the successful removal and "unregistered user gets open the app first". They pin behavior that must not change. The 18 fail for these reasons:
- `voice.itemFailed` doesn't exist, so the item-failure tests see the false "Added to…/Removed from…" receipt or a false "Couldn't find" instead.
- The receipt loop still sends an empty "Updated Groceries:" message.
- The lists and user reads ignore `error`, so Gemini is called and the user gets `voice.noUser` or a "list not found" line.
- The download isn't checked, so the processor is called with the 404 body.
- The outer log has no `chatId`.

- [ ] **Step 3: implementation in `src/services/voice-handler.ts`.** Apply each replacement below. No earlier task touches this file. T2 changes only `src/services/item-recycler.ts`, whose signatures stay the same.

**3a. Add `dbFailure`** below `MAX_VOICE_FILE_SIZE`.

Current:
```ts
const MAX_VOICE_FILE_SIZE = 5 * 1024 * 1024; // 5MB
```
Replacement:
```ts
const MAX_VOICE_FILE_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * postgrest resolves a failed call with a plain { code, message } object instead of rejecting.
 * Wrap it in an Error that names the step, so the catch that receives it logs what failed.
 * Only code and message are kept: `details` can quote row values (item text).
 */
function dbFailure(what: string, error: { code?: string; message?: string }): Error {
  return new Error(`[VoiceHandler] ${what} failed: ${error.code ?? "?"} ${error.message ?? ""}`.trimEnd());
}
```

**3b. User lookup (:80-86)**

Current:
```ts
    const { data: user } = await supabase
      .from("users")
      .select("id, language")
      .eq("telegram_id", telegramUserId)
      .single();

    if (!user) {
```
Replacement:
```ts
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, language")
      .eq("telegram_id", telegramUserId)
      .maybeSingle();
    if (userError) throw dbFailure("User lookup", userError);

    if (!user) {
```

**3c. Owned lists and collaborators (:112-123)**

Current:
```ts
    // Get user's lists
    const { data: ownedLists } = await supabase
      .from("lists")
      .select("id, name")
      .eq("owner_id", user.id)
      .is("deleted_at", null);

    const { data: collabRecords } = await supabase
      .from("collaborators")
      .select("list_id, permission")
      .eq("user_id", user.id)
      .eq("status", "approved");
```
Replacement:
```ts
    // Get user's lists
    // Each read below fails the whole message: a partial set of lists would change which
    // list the items land in.
    const { data: ownedLists, error: ownedError } = await supabase
      .from("lists")
      .select("id, name")
      .eq("owner_id", user.id)
      .is("deleted_at", null);
    if (ownedError) throw dbFailure("Owned lists read", ownedError);

    const { data: collabRecords, error: collabError } = await supabase
      .from("collaborators")
      .select("list_id, permission")
      .eq("user_id", user.id)
      .eq("status", "approved");
    if (collabError) throw dbFailure("Collaborators read", collabError);
```

**3d. Shared list names (:130-137)**

Current:
```ts
      const { data } = await supabase
        .from("lists")
        .select("id, name")
        .in("id", collabListIds)
        .is("deleted_at", null);
      collabLists = data || [];
```
Replacement:
```ts
      const { data, error: sharedError } = await supabase
        .from("lists")
        .select("id, name")
        .in("id", collabListIds)
        .is("deleted_at", null);
      if (sharedError) throw dbFailure("Shared lists read", sharedError);
      collabLists = data || [];
```

**3e. Archived state (:147-152)**

Current:
```ts
    const { data: archivedRows } = await supabase
      .from("user_list_state")
      .select("list_id")
      .eq("user_id", user.id)
      .not("archived_at", "is", null);
    const archivedListIds = new Set((archivedRows || []).map((r) => r.list_id));
```
Replacement:
```ts
    const { data: archivedRows, error: archivedError } = await supabase
      .from("user_list_state")
      .select("list_id")
      .eq("user_id", user.id)
      .not("archived_at", "is", null);
    if (archivedError) throw dbFailure("Archived lists read", archivedError);
    const archivedListIds = new Set((archivedRows || []).map((r) => r.list_id));
```

**3f. Download (:197-200)**

Current:
```ts
    // Download voice file
    const fileUrl = await bot.getFileLink(voice.file_id);
    const audioResponse = await fetch(fileUrl);
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
```
Replacement:
```ts
    // Download voice file
    const fileUrl = await bot.getFileLink(voice.file_id);
    const audioResponse = await fetch(fileUrl);
    // Status only: fileUrl contains the bot token and must never be logged.
    if (!audioResponse.ok) {
      throw new Error(`Telegram voice download failed: ${audioResponse.status}`);
    }
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
```

**3g. Per-item try/catch in the item loop (:300-324)**

Current:
```ts
      if (voiceItem.action === "add") {
        await processAddItem(
          supabase,
          bot,
          chatId,
          targetList.id,
          voiceItem,
          user.id,
          receipt,
          lang
        );
      } else {
        await processRemoveItem(
          supabase,
          bot,
          chatId,
          targetList.id,
          voiceItem,
          receipt,
          lang,
          targetList.name
        );
      }

      receipts.set(targetList.id, receipt);
```
Replacement:
```ts
      // One item's failure must not stop the rest: that item gets its own line and
      // stays out of the receipt, the others are receipted as usual.
      try {
        if (voiceItem.action === "add") {
          await processAddItem(
            supabase,
            bot,
            chatId,
            targetList.id,
            voiceItem,
            user.id,
            receipt,
            lang
          );
        } else {
          await processRemoveItem(
            supabase,
            bot,
            chatId,
            targetList.id,
            voiceItem,
            receipt,
            lang,
            targetList.name
          );
        }
      } catch (itemErr) {
        console.error(
          "[VoiceHandler] Item update failed:",
          { action: voiceItem.action, chatId, listId: targetList.id },
          itemErr
        );
        try {
          await bot.sendMessage(
            chatId,
            getMsg(lang, "voice.itemFailed")
              .replace("{item}", () => voiceItem.text)
              .replace("{listName}", () => receipt.listName)
          );
        } catch (sendErr) {
          console.error("[VoiceHandler] Failed to send item-failed notice, chatId:", chatId, "listId:", targetList.id, sendErr);
        }
      }

      receipts.set(targetList.id, receipt);
```

**3h. Skip an empty receipt (:328)**

Current:
```ts
    for (const receipt of receipts.values()) {
      const lines: string[] = [];
```
Replacement:
```ts
    for (const receipt of receipts.values()) {
      // Nothing changed on this list (every item failed or was not found): no receipt.
      if (receipt.added.length === 0 && receipt.removed.length === 0) continue;

      const lines: string[] = [];
```
Leave `listsToSort.push(...receipts.keys());` as it is. Categorizing a list with no new items is a harmless no-op, and the wiring test pins that line.

**3i. Outer catch log (:360)**

Current:
```ts
    console.error("[VoiceHandler] Processing error:", error);
```
Replacement:
```ts
    console.error("[VoiceHandler] Processing error, chatId:", chatId, error);
```

**3j. Recycles in `processAddItem` (:404-406 and :418)**

Current (single match):
```ts
      // High confidence — auto-recycle
      await recycleItem(match.id, userId, listId);
```
Replacement:
```ts
      // High confidence — auto-recycle
      await recycleOrThrow(match.id, userId, listId);
```
Current (multiple matches):
```ts
      await recycleItem(bestMatch.id, userId, listId);
```
Replacement:
```ts
      await recycleOrThrow(bestMatch.id, userId, listId);
```
Keep the import `import { findFuzzyMatch, recycleItem } from "./item-recycler";` unchanged, because `recycleOrThrow` uses it.

**3k. Max position and insert in `processAddItem` (:426-442)**

Current:
```ts
  const { data: maxPosResult } = await supabase
    .from("items")
    .select("position")
    .eq("list_id", listId)
    .order("position", { ascending: false })
    .limit(1);

  const nextPosition = (maxPosResult?.[0]?.position || 0) + 1;

  const { data: created } = await supabase.from("items").insert({
    list_id: listId,
    text: normalizeForStorage(voiceItem.text),
    position: nextPosition,
    created_by: userId,
  }).select("id").single();

  receipt.added.push(voiceItem.text);
```
Replacement:
```ts
  const { data: maxPosResult, error: maxPosError } = await supabase
    .from("items")
    .select("position")
    .eq("list_id", listId)
    .order("position", { ascending: false })
    .limit(1);
  if (maxPosError) throw dbFailure("Max position read", maxPosError);

  const nextPosition = (maxPosResult?.[0]?.position || 0) + 1;

  const { data: created, error: insertError } = await supabase.from("items").insert({
    list_id: listId,
    text: normalizeForStorage(voiceItem.text),
    position: nextPosition,
    created_by: userId,
  }).select("id").single();
  if (insertError) throw dbFailure("Item insert", insertError);

  receipt.added.push(voiceItem.text);
```

**3l. Exact lookup and its soft-delete in `processRemoveItem` (:459-476)**

Current:
```ts
  const { data: exactMatches } = await supabase
    .from("items")
    .select("id, text")
    .eq("list_id", listId)
    .eq("completed", false)
    .is("deleted_at", null)
    .ilike("text", escapeIlike(canonical))
    .order("created_at", { ascending: false })
    .limit(1);

  if (exactMatches && exactMatches.length > 0) {
    // Soft-delete the most recent match
    await supabase
      .from("items")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", exactMatches[0].id);
    receipt.removed.push(exactMatches[0].text);
```
Replacement:
```ts
  const { data: exactMatches, error: exactError } = await supabase
    .from("items")
    .select("id, text")
    .eq("list_id", listId)
    .eq("completed", false)
    .is("deleted_at", null)
    .ilike("text", escapeIlike(canonical))
    .order("created_at", { ascending: false })
    .limit(1);
  if (exactError) throw dbFailure("Exact match lookup", exactError);

  if (exactMatches && exactMatches.length > 0) {
    // Soft-delete the most recent match
    await softDeleteItem(supabase, exactMatches[0].id);
    receipt.removed.push(exactMatches[0].text);
```

**3m. Fuzzy lookup (:480-486)**

Current:
```ts
  const { data: fuzzyActive } = await supabase
    .from("items")
    .select("id, text")
    .eq("list_id", listId)
    .eq("completed", false)
    .is("deleted_at", null)
    .limit(200);
```
Replacement:
```ts
  const { data: fuzzyActive, error: fuzzyError } = await supabase
    .from("items")
    .select("id, text")
    .eq("list_id", listId)
    .eq("completed", false)
    .is("deleted_at", null)
    .limit(200);
  if (fuzzyError) throw dbFailure("Fuzzy match lookup", fuzzyError);
```

**3n. Fuzzy soft-delete (:501-505)**

Current:
```ts
      await supabase
        .from("items")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", scored[0].id);
      receipt.removed.push(scored[0].text);
```
Replacement:
```ts
      await softDeleteItem(supabase, scored[0].id);
      receipt.removed.push(scored[0].text);
```

**3o. Completed check (:511-518)**

Current:
```ts
  const { data: completedMatch } = await supabase
    .from("items")
    .select("text")
    .eq("list_id", listId)
    .eq("completed", true)
    .is("deleted_at", null)
    .ilike("text", escapeIlike(canonical))
    .limit(1);
```
Replacement:
```ts
  const { data: completedMatch, error: completedError } = await supabase
    .from("items")
    .select("text")
    .eq("list_id", listId)
    .eq("completed", true)
    .is("deleted_at", null)
    .ilike("text", escapeIlike(canonical))
    .limit(1);
  if (completedError) throw dbFailure("Completed match lookup", completedError);
```

**3p. Add the two helpers** after `processRemoveItem`, directly above `textSimilarity`.

Current:
```ts
// Simple text similarity (Dice coefficient on character bigrams)
```
Replacement:
```ts
/** Soft-deletes one item. Throws when the write fails, so the receipt never claims it. */
async function softDeleteItem(supabase: SupabaseClient, itemId: string): Promise<void> {
  const { error } = await supabase
    .from("items")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", itemId);
  if (error) throw dbFailure("Item soft-delete", error);
}

/**
 * recycleItem throws on a database error and returns null when the row is gone. Either way
 * the item was not recycled, so this throws and the receipt never claims it.
 */
async function recycleOrThrow(itemId: string, userId: string, listId: string): Promise<void> {
  const recycled = await recycleItem(itemId, userId, listId);
  if (!recycled) throw new Error(`[VoiceHandler] Recycle found no item ${itemId} in list ${listId}`);
}

// Simple text similarity (Dice coefficient on character bigrams)
```

**3q. The new string.** Add one line directly after `voice.notFound` in each locale file.

`messages/en.json`, current:
```json
    "notFound": "Couldn't find '{item}' in {listName}.",
```
Replacement:
```json
    "notFound": "Couldn't find '{item}' in {listName}.",
    "itemFailed": "Couldn't update '{item}' in {listName}. Please try again.",
```
`messages/he.json`, current:
```json
    "notFound": "לא מצאתי '{item}' ב{listName}.",
```
Replacement:
```json
    "notFound": "לא מצאתי '{item}' ב{listName}.",
    "itemFailed": "לא הצלחתי לעדכן את '{item}' ב{listName}. נסה שוב.",
```
`messages/ru.json`, current:
```json
    "notFound": "Не нашёл '{item}' в {listName}.",
```
Replacement:
```json
    "notFound": "Не нашёл '{item}' в {listName}.",
    "itemFailed": "Не получилось обновить '{item}' в {listName}. Попробуйте ещё раз.",
```
Each file has a second `"notFound"` key under another section (line ~180, "Not found."). Edit only the one in the `voice` block, the one with `{item}`.

- [ ] **Step 4: update the existing test that breaks.** `__tests__/unit/recycle-scoping.test.ts` counts live `recycleItem(` call sites across `app/` and `src/`. Today it expects exactly 3 (the route plus two in the voice handler). After 3j and 3p the voice handler has exactly one, inside `recycleOrThrow`, so the expected count drops by 1. The per-call argument-count check and the route checks stay as they are, so nothing gets weaker.

If T2 left the count at 3, current:
```ts
      `expected exactly 3 live recycleItem( call sites (route.ts + 2 in voice-handler.ts), ` +
        `found ${callSites.length}: ${callSites.map((c) => c.file).join(", ")}`
    ).toBe(3);
```
Replacement:
```ts
      `expected exactly 2 live recycleItem( call sites (route.ts + recycleOrThrow in voice-handler.ts), ` +
        `found ${callSites.length}: ${callSites.map((c) => c.file).join(", ")}`
    ).toBe(2);
```
If T2 changed the route's count, subtract 1 from whatever T2 left and update the message the same way: the voice handler now counts as one call, inside `recycleOrThrow`.

No other existing test breaks. I checked this by applying this exact change to a copy of today's tree: the full `npx vitest run` passed, 73 files and 582 tests. `voice-categorize-wiring`, `voice-handler-no-reminders`, `no-silent-catches`, `locale-parity`, `telegram-error-redaction` and `bot-command-errors` all stay green.

- [ ] **Step 5: run the tests. Expected PASS.**

```bash
npx vitest run __tests__/unit/voice-handler-failures.test.ts __tests__/unit/recycle-scoping.test.ts __tests__/unit/voice-categorize-wiring.test.ts __tests__/unit/voice-handler-no-reminders.test.ts __tests__/unit/no-silent-catches.test.ts __tests__/unit/locale-parity.test.ts __tests__/unit/telegram-error-redaction.test.ts __tests__/unit/bot-command-errors.test.ts
npx tsc --noEmit
npx eslint src/services/voice-handler.ts __tests__/unit/voice-handler-failures.test.ts __tests__/helpers/fake-supabase.ts __tests__/unit/recycle-scoping.test.ts
```
Expected: all green (`voice-handler-failures`: 22 passed). tsc and eslint print nothing.

- [ ] **Step 6: make it bite.** For each row, delete or revert the named code in `src/services/voice-handler.ts`, run `npx vitest run __tests__/unit/voice-handler-failures.test.ts`, check that the named test goes red, then restore the code. I verified every row on a copy of the tree.

| remove / revert | test that must go red |
|---|---|
| `if (userError) throw dbFailure("User lookup", userError);` | "user lookup fails: voice.error, not 'open the app first'" |
| `.maybeSingle()` on the user lookup, back to `.single()` | "an unregistered user (no row) still gets 'open the app first'" (the fake returns PGRST116 for `.single()` with zero rows, as real PostgREST does) |
| `if (ownedError) throw ...` | "owned lists read fails: …" |
| `if (collabError) throw ...` | "collaborators read fails: …" |
| `if (sharedError) throw ...` | "shared lists read fails: …" |
| `if (archivedError) throw ...` | "archived state read fails: …" |
| the `if (!audioResponse.ok) { throw … }` block | "a 404 download: voice.error, Gemini never called, …" |
| `if (maxPosError) throw ...` | "max position read fails: nothing is inserted …" |
| `if (insertError) throw ...` | "insert fails: that item gets voice.itemFailed …" and "a list where every item failed gets no 'Added to'/'Updated' message …" |
| `if (exactError) throw ...` | "remove: a failed exact lookup says 'couldn't update', never 'not found'" |
| `if (fuzzyError) throw ...` | "remove: a failed fuzzy lookup …" |
| `if (completedError) throw ...` | "remove: a failed completed check …" |
| `if (error) throw dbFailure("Item soft-delete", error);` in `softDeleteItem` | "soft-delete (exact match) fails …" and "soft-delete (fuzzy match) fails …" |
| `if (!recycled) throw …` in `recycleOrThrow` | "recycleItem resolves null (the row is gone): …" |
| `if (receipt.added.length === 0 && receipt.removed.length === 0) continue;` | "a removal that found nothing sends only 'Couldn't find' …" (plus every per-item failure test) |
| the per-item catch: change `} catch (itemErr) {` to `} catch (itemErr) { throw itemErr;` (same as no wrapper) | "insert fails …", "recycleItem rejects (a DB error) …", "findFuzzyMatch rejects …" (they get `voice.error` instead) |
| the `"itemFailed"` line in `messages/en.json` | every per-item failure test (the line comes out empty) and both `locale-parity` tests |

Restore each change, then run Step 5 again.

- [ ] **Step 7: commit.**

```bash
git add src/services/voice-handler.ts messages/en.json messages/he.json messages/ru.json __tests__/helpers/fake-supabase.ts __tests__/unit/recycle-scoping.test.ts __tests__/unit/voice-handler-failures.test.ts
git commit -m "$(cat <<'MSG'
fix(voice): receipt lists only what really happened

A failed insert, soft-delete or recycle was still receipted as done, and a
failed lists or user read shrank the target lists or told a registered user
to open the app first. Whole-message reads and the Telegram download now
abort to voice.error; each item's failure is isolated with the new
voice.itemFailed line and the rest of the receipt stays accurate. A list
where nothing changed no longer gets an empty receipt.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
MSG
)"
```
(If Step 1 skipped the `fake-supabase.ts` edit because T2 already added `ilike`, leave that path out of `git add`.)

### Task 6a: Webhook waits for bot command handlers

**Files:**
- Modify: `src/services/bot.ts` (logFailures, new export `waitForBotHandlers`)
- Modify: `app/api/webhook/route.ts` (after() block)
- Modify (test): `__tests__/unit/bot-command-errors.test.ts`
- Create (test): `__tests__/unit/webhook-waits-for-handlers.test.ts`

No earlier task touches these files.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export async function waitForBotHandlers(): Promise<void>` in `src/services/bot.ts`. Resolves once every `/start` and `/help` handler started so far has settled. Never rejects (failures are already logged by `logFailures`). No timeout of its own.

**Sites:**

| site (as of today) | today on failure | change | user-visible result |
|---|---|---|---|
| `src/services/bot.ts:59-65` (`logFailures`) | The handler promise is dropped after its `.catch` logger is attached, so nothing can wait for it | Keep the logged promise in a module-level `inFlight: Set<Promise<void>>`, remove it in `.finally`; export `waitForBotHandlers()` = `Promise.allSettled([...inFlight])` | none on its own |
| `app/api/webhook/route.ts:70` (`bot.processUpdate(body)`) | processUpdate calls the onText handlers synchronously (`node_modules/node-telegram-bot-api/src/telegram.js:713-726`, `reg.callback(message, result)`) and returns, so `after()` resolves while `/start` is still mid-upsert or mid-send; Vercel can freeze it | `bot.processUpdate(body); await waitForBotHandlers();` inside the same try | `/start` and `/help` replies and the user row reliably arrive |

- [ ] **Step 1: write the failing tests**

In `__tests__/unit/bot-command-errors.test.ts`:

1. Add under the vitest import:
```ts
import en from "@/messages/en.json";
```
2. Replace the hoisted state
```ts
const h = vi.hoisted(() => ({
  handlers: [] as { regexp: RegExp; handler: (msg: unknown, match: RegExpExecArray | null) => unknown }[],
  sendError: null as Error | null,
}));
```
with
```ts
const h = vi.hoisted(() => ({
  handlers: [] as { regexp: RegExp; handler: (msg: unknown, match: RegExpExecArray | null) => unknown }[],
  sendError: null as Error | null,
  // While set, sendMessage waits for it: lets a test hold a handler mid-flight.
  sendGate: null as Promise<void> | null,
  sends: [] as { chatId: number; text: string }[],
}));
```
3. Replace the fake bot's `sendMessage`
```ts
    async sendMessage() {
      if (h.sendError) throw h.sendError;
      return {};
    }
```
with
```ts
    async sendMessage(chatId: number, text: string) {
      if (h.sendGate) await h.sendGate;
      if (h.sendError) throw h.sendError;
      h.sends.push({ chatId, text });
      return {};
    }
```
4. In the existing `describe("bot command handlers log their own failures")` `beforeEach`, add before the `h.sendError = ...` line:
```ts
    h.sendGate = null;
    h.sends = [];
```
5. Append at the end of the file:
```ts
// The webhook runs processUpdate inside after() and then awaits waitForBotHandlers(), so Vercel
// keeps the function alive until /start and /help have finished their writes and sends.
describe("waitForBotHandlers", () => {
  beforeEach(() => {
    h.sendGate = null;
    h.sendError = null;
    h.sends = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("stays pending until a running handler finishes, then resolves", async () => {
    const handler = await commandHandler("/help");
    const { waitForBotHandlers } = await import("@/src/services/bot");
    let release!: () => void;
    h.sendGate = new Promise<void>((r) => (release = r));

    handler(msg, null);
    let done = false;
    const waiting = waitForBotHandlers().then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(done).toBe(false);
    expect(h.sends).toEqual([]);

    release();
    await waiting;

    expect(done).toBe(true);
    expect(h.sends).toEqual([{ chatId: 42, text: en.bot.help }]);
  });

  it("resolves when a handler fails, and the failure is logged once", async () => {
    h.sendError = new Error("ETELEGRAM: 403 Forbidden: bot was blocked by the user");
    const handler = await commandHandler("/help");
    const { waitForBotHandlers } = await import("@/src/services/bot");

    handler(msg, null);
    await expect(waitForBotHandlers()).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith("[Bot] /help handler failed, chatId:", 42, h.sendError);
  });

  it("resolves at once when nothing is running", async () => {
    const { waitForBotHandlers } = await import("@/src/services/bot");

    await expect(waitForBotHandlers()).resolves.toBeUndefined();
  });
});
```

Create `__tests__/unit/webhook-waits-for-handlers.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Runs the real webhook POST handler. after() is captured instead of run by Next, and the bot
// module is faked, so the test can see whether the background step waits for the command
// handlers that processUpdate started.
const h = vi.hoisted(() => ({
  afterTasks: [] as (() => Promise<void>)[],
  processUpdate: null as unknown as ReturnType<typeof vi.fn>,
  handlersDone: null as Promise<void> | null,
}));

vi.mock("next/server", async (importOriginal) => {
  const real = await importOriginal<typeof import("next/server")>();
  return { ...real, after: (task: () => Promise<void>) => void h.afterTasks.push(task) };
});
vi.mock("@/src/lib/env", () => ({
  serverEnv: () => ({ TELEGRAM_WEBHOOK_SECRET: "hook-secret" }),
}));
vi.mock("@/src/services/bot", () => ({
  default: { processUpdate: (...args: unknown[]) => h.processUpdate(...args) },
  waitForBotHandlers: () => h.handlersDone ?? Promise.resolve(),
}));

import { POST } from "@/app/api/webhook/route";

const startUpdate = {
  update_id: 1,
  message: { message_id: 5, date: 0, chat: { id: 42, type: "private" }, from: { id: 7, is_bot: false, first_name: "A" }, text: "/start" },
};
const req = () =>
  new NextRequest("https://app.test/api/webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "hook-secret", "Content-Type": "application/json" },
    body: JSON.stringify(startUpdate),
  });

beforeEach(() => {
  h.afterTasks = [];
  h.processUpdate = vi.fn();
  h.handlersDone = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/webhook: command updates", () => {
  it("keeps the background step alive until the bot's command handlers finish", async () => {
    let release!: () => void;
    h.handlersDone = new Promise<void>((r) => (release = r));

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(h.afterTasks).toHaveLength(1);

    let finished = false;
    const background = h.afterTasks[0]().then(() => {
      finished = true;
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(h.processUpdate).toHaveBeenCalledWith(startUpdate);
    expect(finished).toBe(false);

    release();
    await background;
    expect(finished).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: run them, expected FAIL**

`npx vitest run __tests__/unit/bot-command-errors.test.ts __tests__/unit/webhook-waits-for-handlers.test.ts`

Expected: the three `waitForBotHandlers` tests fail with `TypeError: waitForBotHandlers is not a function` (no such export yet). The webhook test fails on `expect(finished).toBe(false)` (received true): the after() task returns as soon as processUpdate returns. The three existing tests stay green.

- [ ] **Step 3: implementation**

`src/services/bot.ts`, current (lines 57-65):
```ts
// onText drops the promise an async handler returns, so a failure would otherwise be an
// unhandled rejection. Log it here instead, with the chat it came from.
function logFailures(command: string, handler: CommandHandler) {
  return (msg: TelegramBot.Message, match: RegExpExecArray | null) => {
    handler(msg, match).catch((err) => {
      console.error(`[Bot] ${command} handler failed, chatId:`, msg.chat.id, err);
    });
  };
}
```
replacement:
```ts
// Command handlers still running. processUpdate calls onText handlers synchronously, so a
// handler's promise is in this set by the time processUpdate returns.
const inFlight = new Set<Promise<void>>();

// onText drops the promise an async handler returns, so a failure would otherwise be an
// unhandled rejection. Log it here instead, with the chat it came from, and track the
// promise so the webhook can wait for it (waitForBotHandlers).
function logFailures(command: string, handler: CommandHandler) {
  return (msg: TelegramBot.Message, match: RegExpExecArray | null) => {
    const run = handler(msg, match).catch((err) => {
      console.error(`[Bot] ${command} handler failed, chatId:`, msg.chat.id, err);
    });
    inFlight.add(run);
    void run.finally(() => inFlight.delete(run));
  };
}

/**
 * Resolves once every command handler started so far has finished (failures are already
 * logged by logFailures). The webhook awaits this inside after(), so the function is not
 * frozen mid-handler. No timeout of its own: the platform's function limit applies.
 */
export async function waitForBotHandlers(): Promise<void> {
  await Promise.allSettled([...inFlight]);
}
```
(`run` never rejects because its `.catch` logs, so `run.finally(...)` never produces an unhandled rejection. `.finally` is not a catch, so the no-silent-catches guard is unaffected.)

`app/api/webhook/route.ts`, current (inside `after(async () => { try { ... }`):
```ts
      const bot = (await import("@/src/services/bot")).default;
```
replacement:
```ts
      const { default: bot, waitForBotHandlers } = await import("@/src/services/bot");
```
current:
```ts
      // Feed all other updates to bot for command handling
      bot.processUpdate(body as TelegramBot.Update);
```
replacement:
```ts
      // Feed all other updates to bot for command handling. processUpdate starts the
      // /start and /help handlers without waiting for them; wait here so the function
      // is not frozen before their database write and reply finish.
      bot.processUpdate(body as TelegramBot.Update);
      await waitForBotHandlers();
```

- [ ] **Step 4: update existing tests/mocks**

None break. `__tests__/unit/telegram-error-redaction.test.ts` and `removed-reminder-buttons.test.ts` import the real bot module and do not touch `logFailures`.

- [ ] **Step 5: run tests, expected PASS**

```bash
npx vitest run __tests__/unit/bot-command-errors.test.ts __tests__/unit/webhook-waits-for-handlers.test.ts __tests__/unit/telegram-error-redaction.test.ts __tests__/unit/removed-reminder-buttons.test.ts __tests__/unit/no-silent-catches.test.ts
npx tsc --noEmit
npx eslint src/services/bot.ts app/api/webhook/route.ts __tests__/unit/bot-command-errors.test.ts __tests__/unit/webhook-waits-for-handlers.test.ts
```

- [ ] **Step 6: make it bite**

1. In `src/services/bot.ts` delete `    inFlight.add(run);`. Run `npx vitest run __tests__/unit/bot-command-errors.test.ts`: "waitForBotHandlers > stays pending until a running handler finishes, then resolves" must go red. Restore.
2. In `app/api/webhook/route.ts` delete `      await waitForBotHandlers();`. Run `npx vitest run __tests__/unit/webhook-waits-for-handlers.test.ts`: "keeps the background step alive until the bot's command handlers finish" must go red. Restore.

- [ ] **Step 7: commit**

```bash
git add src/services/bot.ts app/api/webhook/route.ts __tests__/unit/bot-command-errors.test.ts __tests__/unit/webhook-waits-for-handlers.test.ts
git commit -m "$(cat <<'EOF'
fix(bot): webhook waits for /start and /help handlers to finish

processUpdate runs onText handlers without waiting for them, so after()
returned while /start was still saving the user and sending the welcome,
and Vercel could freeze the function midway. logFailures now tracks each
handler promise and the webhook awaits waitForBotHandlers(). No timeout
of its own; the platform limit applies.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
)"
```

### Task 6b: Join requests on the server: invite route, owner approve/decline, /start

**Files:**
- Modify: `app/api/share/[token]/route.ts` (POST, DELETE, `sendApprovalNotification`)
- Modify: `src/services/bot.ts` (`/start` upsert, `sendApprovalRequest`, approve/decline in `handleCallbackQuery`), as Task 6a left it
- Modify (test helper): `__tests__/helpers/fake-supabase.ts` (add `upsert` op and optional `count`)
- Modify (test): `__tests__/unit/bot-command-errors.test.ts` (as Task 6a left it)
- Create (test): `__tests__/unit/share-token-route.test.ts`
- Create (test): `__tests__/unit/join-request-bot.test.ts`

**Interfaces:**
- Consumes: `dbError(tag: string, what: string, error: unknown, ctx?: Record<string, unknown>): NextResponse` from `src/lib/api-errors.ts` (Task 1). `waitForBotHandlers(): Promise<void>` from `src/services/bot.ts` (Task 6a; used by the `/start` test).
- Produces:
  - `sendApprovalRequest(ownerTelegramId: number, requesterId: string, requesterName: string, listId: string, listName: string, collaboratorId: string, ownerLanguage: string): Promise<boolean>`: true only when Telegram accepted the message; logs and returns false otherwise. Only caller: the route below.
  - Route-local `sendApprovalNotification(...): Promise<boolean>`, same meaning.
  - `FakeCall.op` gains `"upsert"`, `FakeResult` gains `count?: number | null`, and the fake client gains `from(t).upsert(values)`. Purely additive. No earlier task adds these (ruling R4).

**Sites:**

| site (as of today) | today on failure | change | user-visible result |
|---|---|---|---|
| `app/api/share/[token]/route.ts:38` invite read | error ignored; `.single()`; a DB failure answers 404 "Invite not found", nothing logged | `.maybeSingle()`; `if (inviteError) return dbError("Share", "Invite read", inviteError)` with no ctx (the token is never logged) | invitee gets the try-again screen (6c), not "Invite not valid" |
| `:59` list read | error ignored; DB failure answers 410 "This list has been deleted." | `.maybeSingle()`; `dbError("Share", "List read", e, { listId })` | not told the list was deleted |
| `:83` user upsert | error not destructured; 500 "Failed to register user" with no log | `if (userError \|\| !user) return dbError("Share", "User upsert", userError, { telegramId })` | same 500, now logged |
| `:113` existing collaborator read | error ignored; `.single()` errors on the normal zero-row case; a DB failure skips the approved/pending/declined branches and hits the UNIQUE insert | `.maybeSingle()`; `dbError("Share", "Collaborator read", e, { listId, userId })` before any branch | an approved member gets try-again, not a misleading 500 from the insert |
| `:142` re-invite update | result ignored; owner still asked, 200 pending while the row stays declined | `if (reinviteError) return dbError("Share", "Re-invite update", e, { collaboratorId })` before notifying | invitee gets try-again instead of waiting on a declined row |
| `:151` re-invite notify | `sendApprovalNotification` returns void; owner silently not messaged | use its boolean; on false `console.warn("[Share] Owner was not notified of the join request:", { listId, collaboratorId })`; still 200 pending (product call 2 = A) | unchanged screen; cause traceable |
| `:170` pending count | error ignored; `null` count bypasses the 10-pending cap | destructure `error`; `dbError("Share", "Pending count read", e, { listId })` (fail closed) | try-again instead of an uncapped insert |
| `:184-217` insert + `collab!` (missed by inventory: the two non-null assertions) | no-error/no-row would throw a TypeError (unlogged Next 500) | `if (error \|\| !collab)` with ctx in the existing log; drop both `!` | logged 500 |
| `:204` new-request notify | same as :151 | same as :151 | same |
| `:238` DELETE cancel | result ignored; always `{ success: true }` | destructure `error`; `dbError("Share", "Join request cancel", e, { collaboratorId, userId })`; zero matched rows stays success | the page stays on "waiting" with an error (6c), instead of going home while the request stays pending |
| `:259` owner read in `sendApprovalNotification` | error ignored; `if (owner)` false, silent | `.maybeSingle()`; error: `console.error("[Share] Owner read failed:", { ownerId }, e)`, return false; no row: `console.warn("[Share] List owner row is missing:", { ownerId })`, return false | logged; route warns |
| `src/services/bot.ts:176` `sendApprovalRequest` | catches, logs, returns undefined | `Promise<boolean>`: `return true` after send, `return false` in the catch | feeds the route's warn |
| `src/services/bot.ts:279` approve/decline read | error ignored; a DB failure says "Request not found." | `.maybeSingle()`; error: log, answer `getMsg(query.from.language_code, "errors.generic")`, return | owner sees "Something went wrong. Please try again." in their Telegram language; buttons stay |
| `src/services/bot.ts:309` status update | result ignored; requester told "approved", buttons removed, row still pending | move the five `requester*/listName/ownerLang` consts above the update; on error log, answer `getMsg(ownerLang, "errors.generic")`, return before any message or edit | requester not told anything false; owner keeps the buttons and can tap again |
| `src/services/bot.ts:85` `/start` upsert | result ignored | destructure `error`; `console.error("[Bot] /start user upsert failed, telegramId:", telegramId, e)`; welcome still sent | unchanged; cause logged |

- [ ] **Step 1: write the failing tests**

`__tests__/helpers/fake-supabase.ts`: three additive edits.

Current:
```ts
  op: "select" | "insert" | "update" | "delete" | "rpc";
```
replacement:
```ts
  op: "select" | "insert" | "update" | "upsert" | "delete" | "rpc";
```
Current:
```ts
export type FakeResult = { data: unknown; error: unknown };
```
replacement:
```ts
// `count` is what a `select(col, { count: "exact", head: true })` chain answers with.
export type FakeResult = { data: unknown; error: unknown; count?: number | null };
```
Current:
```ts
      update: (values: unknown) => chain({ table, op: "update", values, filters: [] }),
```
replacement:
```ts
      update: (values: unknown) => chain({ table, op: "update", values, filters: [] }),
      upsert: (values: unknown) => chain({ table, op: "upsert", values, filters: [] }),
```

Create `__tests__/unit/share-token-route.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

// Runs the real POST/DELETE /api/share/[token] handlers. Supabase, auth, rate limit and the bot
// are faked. A database failure must give a logged 500, never "invalid link" (404) or
// "list deleted" (410), and the invite token must never reach a log line.
const TOKEN = "invite-token-SECRET-123";

type Row = Record<string, unknown> | null;
type World = {
  invite: Row; inviteError: unknown;
  list: Row; listError: unknown;
  user: Row; userError: unknown;
  existing: Row; existingError: unknown;
  reinviteError: unknown;
  pendingCount: number | null; countError: unknown;
  inserted: Row; insertError: unknown;
  owner: Row; ownerError: unknown;
  deleteError: unknown;
};

const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; cols?: string; filters: string[] }[] },
  sendApprovalRequest: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("@/src/lib/telegram-auth", () => ({
  validateInitData: () => ({ id: 7, first_name: "Dana", language_code: "he" }),
}));
vi.mock("@/src/lib/rate-limit", () => ({
  apiRateLimiter: {},
  checkRateLimit: async () => ({ success: true }),
  getRateLimitHeaders: () => ({}),
}));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u2" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));
vi.mock("@/src/services/bot", () => ({
  sendApprovalRequest: (...args: unknown[]) => h.sendApprovalRequest(...args),
}));

import { POST, DELETE } from "@/app/api/share/[token]/route";

const DB_DOWN = { message: "connection terminated unexpectedly", code: "08006" };

// Real .single() answers zero rows with an error (PGRST116); .maybeSingle() answers null.
function row(c: FakeCall, data: Row, error: unknown): FakeResult {
  if (error) return { data: null, error };
  if (data === null && c.filters.includes("single")) {
    return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
  }
  return { data, error: null };
}

let w: World;
function use(overrides: Partial<World> = {}) {
  w = {
    invite: { id: "inv1", list_id: "L1", permission: "edit", expires_at: "2999-01-01T00:00:00Z", revoked_at: null },
    inviteError: null,
    list: { id: "L1", name: "Groceries", owner_id: "u1" },
    listError: null,
    user: { id: "u2" },
    userError: null,
    existing: null,
    existingError: null,
    reinviteError: null,
    pendingCount: 0,
    countError: null,
    inserted: { id: "c-new" },
    insertError: null,
    owner: { telegram_id: 777, language: "he" },
    ownerError: null,
    deleteError: null,
    ...overrides,
  };
  h.fake = fakeSupabase((c) => {
    if (c.table === "invite_links") return row(c, w.invite, w.inviteError);
    if (c.table === "lists") return row(c, w.list, w.listError);
    if (c.table === "users" && c.op === "upsert") return row(c, w.user, w.userError);
    if (c.table === "users" && c.op === "select") return row(c, w.owner, w.ownerError);
    if (c.table === "collaborators" && c.op === "select" && c.cols === "id, status") return row(c, w.existing, w.existingError);
    if (c.table === "collaborators" && c.op === "select") {
      return { data: null, error: w.countError, count: w.countError ? null : w.pendingCount };
    }
    if (c.table === "collaborators" && c.op === "update") return { data: null, error: w.reinviteError };
    // Not passed through row(): a test needs the "no row, no error" answer here.
    if (c.table === "collaborators" && c.op === "insert") return { data: w.inserted, error: w.insertError };
    if (c.table === "collaborators" && c.op === "delete") return { data: null, error: w.deleteError };
    throw new Error(`unexpected ${c.op} on ${c.table}`);
  }) as typeof h.fake;
}

const post = () =>
  POST(
    new NextRequest(`https://app.test/api/share/${TOKEN}`, {
      method: "POST",
      headers: { "x-telegram-init-data": "init-data" },
    }),
    { params: Promise.resolve({ token: TOKEN }) }
  );
const del = () =>
  DELETE(
    new NextRequest(`https://app.test/api/share/${TOKEN}?collaboratorId=c1`, { method: "DELETE" })
  );

const ops = () => h.fake.calls.map((c) => `${c.table}:${c.op}`);
function printedLogs(): string {
  const calls = [
    ...vi.mocked(console.error).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
  ];
  return calls
    .flat()
    .map((a) => (typeof a === "string" ? a : `${JSON.stringify(a)} ${String(a)}`))
    .join("\n");
}

beforeEach(() => {
  h.sendApprovalRequest = vi.fn(async () => true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/share/[token]: reads", () => {
  it("answers a failed invite read with a logged 500, without the token in any log", async () => {
    use({ invite: null, inviteError: DB_DOWN });

    const res = await post();

    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[Share] Invite read failed:", DB_DOWN);
    expect(printedLogs()).not.toContain(TOKEN);
    expect(ops()).toEqual(["invite_links:select"]);
    expect(h.sendApprovalRequest).not.toHaveBeenCalled();
  });

  it("still answers 404 for an invite that does not exist, and logs no error", async () => {
    use({ invite: null });

    const res = await post();

    expect(res.status).toBe(404);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("answers a failed list read with a logged 500, not 'list deleted'", async () => {
    use({ list: null, listError: DB_DOWN });

    const res = await post();

    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[Share] List read failed:", { listId: "L1" }, DB_DOWN);
    expect(ops()).not.toContain("users:upsert");
  });

  it("still answers 410 for a list that is really gone", async () => {
    use({ list: null });

    const res = await post();

    expect(res.status).toBe(410);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("logs a failed user upsert with the telegram id before its 500", async () => {
    use({ user: null, userError: DB_DOWN });

    const res = await post();

    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[Share] User upsert failed:", { telegramId: 7 }, DB_DOWN);
    expect(ops()).not.toContain("collaborators:insert");
  });

  it("answers a failed collaborator-row read with a 500 before any write", async () => {
    use({ existingError: DB_DOWN });

    const res = await post();

    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(
      "[Share] Collaborator read failed:",
      { listId: "L1", userId: "u2" },
      DB_DOWN
    );
    expect(ops()).not.toContain("collaborators:insert");
    expect(ops()).not.toContain("collaborators:update");
    expect(h.sendApprovalRequest).not.toHaveBeenCalled();
  });
});

describe("POST /api/share/[token]: new and returning requesters", () => {
  it("creates a pending request and asks the owner, in the owner's language", async () => {
    use();

    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ listId: "L1", listName: "Groceries", collaboratorId: "c-new", status: "pending" });
    expect(h.sendApprovalRequest).toHaveBeenCalledWith(777, "u2", "Dana", "L1", "Groceries", "c-new", "he");
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("re-invites a declined requester and asks the owner again", async () => {
    use({ existing: { id: "c-old", status: "declined" } });

    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ listId: "L1", listName: "Groceries", collaboratorId: "c-old", status: "pending" });
    const update = h.fake.calls.find((c) => c.table === "collaborators" && c.op === "update");
    expect(update?.values).toEqual({ status: "pending", permission: "edit" });
    expect(update?.filters).toContain("eq:id=c-old");
    expect(h.sendApprovalRequest).toHaveBeenCalledWith(777, "u2", "Dana", "L1", "Groceries", "c-old", "he");
  });

  it("answers a failed re-invite update with a 500 and never asks the owner", async () => {
    use({ existing: { id: "c-old", status: "declined" }, reinviteError: DB_DOWN });

    const res = await post();

    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[Share] Re-invite update failed:", { collaboratorId: "c-old" }, DB_DOWN);
    expect(h.sendApprovalRequest).not.toHaveBeenCalled();
  });

  it("fails closed with a 500 when the pending count cannot be read, and inserts nothing", async () => {
    use({ countError: DB_DOWN });

    const res = await post();

    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[Share] Pending count read failed:", { listId: "L1" }, DB_DOWN);
    expect(ops()).not.toContain("collaborators:insert");
  });

  it("still refuses an 11th pending request with a 400", async () => {
    use({ pendingCount: 10 });

    const res = await post();

    expect(res.status).toBe(400);
    expect(ops()).not.toContain("collaborators:insert");
  });

  it("answers an insert that returns no row with a logged 500 instead of crashing", async () => {
    // No row and no error: the guard on the inserted row itself is what is tested.
    use({ inserted: null });

    const res = await post();

    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(
      "[Share] Accept invite error:",
      { listId: "L1", userId: "u2" },
      null
    );
    expect(h.sendApprovalRequest).not.toHaveBeenCalled();
  });
});

describe("POST /api/share/[token]: the owner could not be asked (product call 2: still pending)", () => {
  it("answers 200 pending and warns when the bot could not message the owner", async () => {
    use();
    h.sendApprovalRequest = vi.fn(async () => false);

    const res = await post();

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("pending");
    expect(console.warn).toHaveBeenCalledWith(
      "[Share] Owner was not notified of the join request:",
      { listId: "L1", collaboratorId: "c-new" }
    );
  });

  it("answers 200 pending, logs and warns when sending throws", async () => {
    use({ existing: { id: "c-old", status: "declined" } });
    const boom = new Error("bot module failed to load");
    h.sendApprovalRequest = vi.fn(async () => {
      throw boom;
    });

    const res = await post();

    expect(res.status).toBe(200);
    expect(console.error).toHaveBeenCalledWith("[Share] Failed to send approval notification:", boom);
    expect(console.warn).toHaveBeenCalledWith(
      "[Share] Owner was not notified of the join request:",
      { listId: "L1", collaboratorId: "c-old" }
    );
  });

  it("logs a failed owner read and warns, without trying to send", async () => {
    use({ owner: null, ownerError: DB_DOWN });

    const res = await post();

    expect(res.status).toBe(200);
    expect(console.error).toHaveBeenCalledWith("[Share] Owner read failed:", { ownerId: "u1" }, DB_DOWN);
    expect(console.warn).toHaveBeenCalledWith(
      "[Share] Owner was not notified of the join request:",
      { listId: "L1", collaboratorId: "c-new" }
    );
    expect(h.sendApprovalRequest).not.toHaveBeenCalled();
  });

  it("warns about a missing owner row, without trying to send", async () => {
    use({ owner: null });

    const res = await post();

    expect(res.status).toBe(200);
    expect(console.warn).toHaveBeenCalledWith("[Share] List owner row is missing:", { ownerId: "u1" });
    expect(h.sendApprovalRequest).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/share/[token] (cancel a pending request)", () => {
  it("deletes only the caller's own pending row and answers success", async () => {
    use();

    const res = await del();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const [call] = h.fake.calls;
    expect(call.op).toBe("delete");
    expect([...call.filters].sort()).toEqual(["eq:id=c1", "eq:status=pending", "eq:user_id=u2"]);
  });

  it("answers a failed delete with a logged 500, so the page does not claim it cancelled", async () => {
    use({ deleteError: DB_DOWN });

    const res = await del();

    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(
      "[Share] Join request cancel failed:",
      { collaboratorId: "c1", userId: "u2" },
      DB_DOWN
    );
  });
});
```

Create `__tests__/unit/join-request-bot.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type TelegramBot from "node-telegram-bot-api";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";
import en from "@/messages/en.json";
import he from "@/messages/he.json";
import ru from "@/messages/ru.json";

// Runs the real handleCallbackQuery (Approve / Decline buttons) and sendApprovalRequest.
// The Telegram client, env and Supabase are faked. A database failure must never tell the
// requester "approved" and must leave the owner's buttons in place for another tap.
const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
  answers: [] as { id: string; options: unknown }[],
  textEdits: [] as { text: string; options: unknown }[],
  sends: [] as { chatId: number; text: string }[],
  sendError: null as Error | null,
}));

vi.mock("@/src/lib/env", () => ({
  serverEnv: () => ({ TELEGRAM_BOT_TOKEN: "test-token", NEXT_PUBLIC_APP_URL: "https://app.test" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));
vi.mock("node-telegram-bot-api", () => ({
  default: class FakeTelegramBot {
    onText(): void {
      // /start and /help are covered by bot-command-errors.test.ts.
    }
    async answerCallbackQuery(id: string, options?: unknown) {
      h.answers.push({ id, options });
      return true;
    }
    async editMessageText(text: string, options?: unknown) {
      h.textEdits.push({ text, options });
      return true;
    }
    async sendMessage(chatId: number, text: string) {
      if (h.sendError) throw h.sendError;
      h.sends.push({ chatId, text });
      return {};
    }
  },
}));

import { handleCallbackQuery, sendApprovalRequest } from "@/src/services/bot";

const DB_DOWN = { message: "connection terminated unexpectedly", code: "08006" };
const OWNER_TG = 777;
const REQUESTER_TG = 900;
// The owner's row says Hebrew, the owner's Telegram client says Russian: the answer's
// language shows which one the handler used.
const COLLAB = {
  id: "c1",
  status: "pending",
  users: { telegram_id: REQUESTER_TG, name: "Dana", language: "en" },
  lists: { name: "Groceries", owner_id: "u1", users: { telegram_id: OWNER_TG, language: "he" } },
};

// Real .single() answers zero rows with an error (PGRST116); .maybeSingle() answers null.
function row(c: FakeCall, data: unknown, error: unknown): FakeResult {
  if (error) return { data: null, error };
  if (data === null && c.filters.includes("single")) {
    return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
  }
  return { data, error: null };
}

function use(opts: { collab?: unknown; readError?: unknown; updateError?: unknown } = {}) {
  const collab = "collab" in opts ? opts.collab : COLLAB;
  h.fake = fakeSupabase((c) => {
    if (c.table === "collaborators" && c.op === "select") return row(c, collab, opts.readError ?? null);
    if (c.table === "collaborators" && c.op === "update") return { data: null, error: opts.updateError ?? null };
    throw new Error(`unexpected ${c.op} on ${c.table}`);
  }) as typeof h.fake;
}

function tap(data: string): TelegramBot.CallbackQuery {
  return {
    id: "cb-1",
    from: { id: OWNER_TG, is_bot: false, first_name: "Owner", language_code: "ru" },
    chat_instance: "ci-1",
    data,
    message: { message_id: 42, date: 0, chat: { id: OWNER_TG, type: "private" as const } },
  };
}

const updates = () => h.fake.calls.filter((c) => c.op === "update");

beforeEach(() => {
  h.answers = [];
  h.textEdits = [];
  h.sends = [];
  h.sendError = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("handleCallbackQuery: Approve / Decline a join request", () => {
  it("approves: writes the status, tells the requester and replaces the buttons", async () => {
    use();

    await handleCallbackQuery(tap("approve:c1"));

    expect(updates()).toHaveLength(1);
    expect(updates()[0].values).toEqual({ status: "approved" });
    expect(updates()[0].filters).toContain("eq:id=c1");
    expect(h.sends).toEqual([
      { chatId: REQUESTER_TG, text: en.share.approvedMessage.replace("{listName}", "Groceries") },
    ]);
    expect(h.answers).toEqual([{ id: "cb-1", options: { text: "Approved!" } }]);
    expect(h.textEdits).toHaveLength(1);
  });

  it("still says 'Request not found.' for a request that is really gone, and logs no error", async () => {
    use({ collab: null });

    await handleCallbackQuery(tap("approve:c1"));

    expect(h.answers).toEqual([{ id: "cb-1", options: { text: "Request not found." } }]);
    expect(console.error).not.toHaveBeenCalled();
    expect(updates()).toEqual([]);
  });

  it.each(["approve", "decline"])(
    "%s: a failed read answers errors.generic in the tapper's Telegram language and changes nothing",
    async (action) => {
      use({ collab: null, readError: DB_DOWN });

      await handleCallbackQuery(tap(`${action}:c1`));

      expect(console.error).toHaveBeenCalledWith("[Bot] Join request read failed, collaboratorId:", "c1", DB_DOWN);
      expect(h.answers).toEqual([{ id: "cb-1", options: { text: ru.errors.generic } }]);
      expect(updates()).toEqual([]);
      expect(h.sends).toEqual([]);
      expect(h.textEdits).toEqual([]);
    }
  );

  it.each(["approve", "decline"])(
    "%s: a failed status update answers errors.generic in the owner's language, tells the requester nothing and keeps the buttons",
    async (action) => {
      use({ updateError: DB_DOWN });

      await handleCallbackQuery(tap(`${action}:c1`));

      expect(console.error).toHaveBeenCalledWith(
        "[Bot] Join request status update failed, collaboratorId:",
        "c1",
        DB_DOWN
      );
      expect(h.answers).toEqual([{ id: "cb-1", options: { text: he.errors.generic } }]);
      expect(h.sends).toEqual([]);
      expect(h.textEdits).toEqual([]);
    }
  );
});

describe("sendApprovalRequest", () => {
  it("returns true once the owner was messaged", async () => {
    await expect(sendApprovalRequest(OWNER_TG, "u2", "Dana", "L1", "Groceries", "c1", "he")).resolves.toBe(true);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].chatId).toBe(OWNER_TG);
  });

  it("logs and returns false when Telegram refuses the message", async () => {
    h.sendError = new Error("ETELEGRAM: 403 Forbidden: bot was blocked by the user");

    await expect(sendApprovalRequest(OWNER_TG, "u2", "Dana", "L1", "Groceries", "c1", "he")).resolves.toBe(false);
    expect(console.error).toHaveBeenCalledWith("[Bot] Failed to send approval request:", h.sendError);
  });
});
```

`__tests__/unit/bot-command-errors.test.ts` (as Task 6a left it):
1. In the hoisted state, add after `sends: ...`:
```ts
  upsertError: null as { message: string } | null,
```
2. Replace the Supabase mock line
```ts
    from: () => ({ upsert: async () => ({ data: null, error: null }) }),
```
with
```ts
    from: () => ({ upsert: async () => ({ data: null, error: h.upsertError }) }),
```
3. In both existing `beforeEach` blocks (the "log their own failures" one and the `waitForBotHandlers` one), add `    h.upsertError = null;` next to `h.sendGate = null;`.
4. Insert this block just above the `// The webhook runs processUpdate inside after()` comment:
```ts
describe("/start when the user row cannot be saved", () => {
  beforeEach(() => {
    h.sendGate = null;
    h.sendError = null;
    h.sends = [];
    h.upsertError = { message: "connection terminated unexpectedly" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("logs the failed upsert with the telegram id and still sends the welcome", async () => {
    const handler = await commandHandler("/start");
    const { waitForBotHandlers } = await import("@/src/services/bot");

    handler(msg, ["/start", ""] as unknown as RegExpExecArray);
    await waitForBotHandlers();

    expect(console.error).toHaveBeenCalledWith("[Bot] /start user upsert failed, telegramId:", 7, h.upsertError);
    expect(h.sends).toEqual([{ chatId: 42, text: en.bot.welcome }]);
  });
});
```

- [ ] **Step 2: run them, expected FAIL**

```bash
npx vitest run __tests__/unit/share-token-route.test.ts __tests__/unit/join-request-bot.test.ts __tests__/unit/bot-command-errors.test.ts
```
Expected: in share-token-route, 12 of 18 fail: invite/list read errors give 404/410, the upsert and owner-read logs are missing, the collaborator-read/re-invite/count errors fall through to 200, the no-row insert throws on `collab!.id`, the owner-not-notified warns are missing and the failed DELETE answers 200. Six already pass (404/410 for missing rows, the happy pending and re-invite paths, the 400 cap, the DELETE filters). They are regression guards for the `.maybeSingle()` switch: `row()` in the test emulates `.single()`'s PGRST116 on zero rows. In join-request-bot, 6 of 8 fail: read errors answer "Request not found.", update errors still message the requester and edit the message, and `sendApprovalRequest` resolves `undefined`. In bot-command-errors, only the new `/start` upsert test fails (no log).

- [ ] **Step 3: implementation**

**`app/api/share/[token]/route.ts`.** No earlier task touches this file.

Imports. Current:
```ts
import { checkRateLimit, getRateLimitHeaders } from "@/src/lib/rate-limit";
```
replacement:
```ts
import { checkRateLimit, getRateLimitHeaders } from "@/src/lib/rate-limit";
import { dbError } from "@/src/lib/api-errors";
```

Invite read (:37-44). Current:
```ts
  // Validate invite link
  const { data: invite } = await supabase
    .from("invite_links")
    .select("id, list_id, permission, expires_at, revoked_at")
    .eq("token", token)
    .single();

  if (!invite) {
```
replacement:
```ts
  // Validate invite link. The token is a credential: never put it in a log line.
  const { data: invite, error: inviteError } = await supabase
    .from("invite_links")
    .select("id, list_id, permission, expires_at, revoked_at")
    .eq("token", token)
    .maybeSingle();

  if (inviteError) return dbError("Share", "Invite read", inviteError);
  if (!invite) {
```

List read (:59-66). Current:
```ts
  const { data: list } = await supabase
    .from("lists")
    .select("id, name, owner_id")
    .eq("id", invite.list_id)
    .is("deleted_at", null)
    .single();

  if (!list) {
```
replacement:
```ts
  const { data: list, error: listError } = await supabase
    .from("lists")
    .select("id, name, owner_id")
    .eq("id", invite.list_id)
    .is("deleted_at", null)
    .maybeSingle();

  if (listError) return dbError("Share", "List read", listError, { listId: invite.list_id });
  if (!list) {
```

User upsert (:83, :97-102). Current:
```ts
  const { data: user } = await supabase
    .from("users")
```
replacement:
```ts
  const { data: user, error: userError } = await supabase
    .from("users")
```
Current:
```ts
  if (!user) {
    return NextResponse.json(
      { error: "Failed to register user" },
      { status: 500 }
    );
  }
```
replacement:
```ts
  if (userError || !user) {
    return dbError("Share", "User upsert", userError, { telegramId: telegramUser.id });
  }
```
(The upsert keeps `.single()`: it always returns the upserted row, so zero rows there is a real failure.)

Existing collaborator read (:113-120). Current:
```ts
  const { data: existing } = await supabase
    .from("collaborators")
    .select("id, status")
    .eq("list_id", list.id)
    .eq("user_id", user.id)
    .single();

  if (existing) {
```
replacement:
```ts
  const { data: existing, error: existingError } = await supabase
    .from("collaborators")
    .select("id, status")
    .eq("list_id", list.id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (existingError) {
    return dbError("Share", "Collaborator read", existingError, { listId: list.id, userId: user.id });
  }
  if (existing) {
```

Re-invite update and notify (:141-159). Current:
```ts
    // Re-invite declined user
    await supabase
      .from("collaborators")
      .update({
        status: "pending",
        permission: invite.permission,
      })
      .eq("id", existing.id);

    // Send approval request to owner
    await sendApprovalNotification(
      supabase,
      list.owner_id,
      user.id,
      name,
      list.id,
      list.name,
      existing.id
    );
```
replacement:
```ts
    // Re-invite declined user
    const { error: reinviteError } = await supabase
      .from("collaborators")
      .update({
        status: "pending",
        permission: invite.permission,
      })
      .eq("id", existing.id);

    if (reinviteError) {
      return dbError("Share", "Re-invite update", reinviteError, { collaboratorId: existing.id });
    }

    // Send approval request to owner. The request is saved either way, so the
    // invitee still sees "pending" and the owner finds it in the Share dialog.
    const notified = await sendApprovalNotification(
      supabase,
      list.owner_id,
      user.id,
      name,
      list.id,
      list.name,
      existing.id
    );
    if (!notified) {
      console.warn("[Share] Owner was not notified of the join request:", { listId: list.id, collaboratorId: existing.id });
    }
```

Pending count (:170-174). Current:
```ts
  const { count: pendingCount } = await supabase
    .from("collaborators")
    .select("id", { count: "exact", head: true })
    .eq("list_id", list.id)
    .eq("status", "pending");
```
replacement:
```ts
  const { count: pendingCount, error: countError } = await supabase
    .from("collaborators")
    .select("id", { count: "exact", head: true })
    .eq("list_id", list.id)
    .eq("status", "pending");

  // Fail closed: the cap must not be bypassed because the count could not be read.
  if (countError) return dbError("Share", "Pending count read", countError, { listId: list.id });
```

Insert guard (:195-196). Current:
```ts
  if (error) {
    console.error("[Share] Accept invite error:", error);
```
replacement (the following `return NextResponse.json({ error: "Failed to process invite" }, { status: 500 })` stays):
```ts
  if (error || !collab) {
    console.error("[Share] Accept invite error:", { listId: list.id, userId: user.id }, error);
```

New-request notify and response (:203-218). Current:
```ts
  // Send approval request to owner
  await sendApprovalNotification(
    supabase,
    list.owner_id,
    user.id,
    name,
    list.id,
    list.name,
    collab!.id
  );

  return NextResponse.json({
    listId: list.id,
    listName: list.name,
    collaboratorId: collab!.id,
```
replacement:
```ts
  // Send approval request to owner (see the re-invite branch above)
  const notified = await sendApprovalNotification(
    supabase,
    list.owner_id,
    user.id,
    name,
    list.id,
    list.name,
    collab.id
  );
  if (!notified) {
    console.warn("[Share] Owner was not notified of the join request:", { listId: list.id, collaboratorId: collab.id });
  }

  return NextResponse.json({
    listId: list.id,
    listName: list.name,
    collaboratorId: collab.id,
```

DELETE (:238-245). Current:
```ts
  await supabase
    .from("collaborators")
    .delete()
    .eq("id", collaboratorId)
    .eq("user_id", auth.userId)
    .eq("status", "pending");

  return NextResponse.json({ success: true });
```
replacement:
```ts
  // Zero matched rows is still success: the request is already gone.
  const { error } = await supabase
    .from("collaborators")
    .delete()
    .eq("id", collaboratorId)
    .eq("user_id", auth.userId)
    .eq("status", "pending");

  if (error) {
    return dbError("Share", "Join request cancel", error, { collaboratorId, userId: auth.userId });
  }

  return NextResponse.json({ success: true });
```

`sendApprovalNotification` (:248-280). Replace the whole function with:
```ts
/** Messages the list owner about a join request. True only when the owner was actually messaged. */
async function sendApprovalNotification(
  supabase: ReturnType<typeof createServerClient>,
  ownerId: string,
  requesterId: string,
  requesterName: string,
  listId: string,
  listName: string,
  collaboratorId: string
): Promise<boolean> {
  try {
    // Get owner's telegram_id
    const { data: owner, error: ownerError } = await supabase
      .from("users")
      .select("telegram_id, language")
      .eq("id", ownerId)
      .maybeSingle();

    if (ownerError) {
      console.error("[Share] Owner read failed:", { ownerId }, ownerError);
      return false;
    }
    if (!owner) {
      console.warn("[Share] List owner row is missing:", { ownerId });
      return false;
    }

    const { sendApprovalRequest } = await import("@/src/services/bot");
    return await sendApprovalRequest(
      owner.telegram_id,
      requesterId,
      requesterName,
      listId,
      listName,
      collaboratorId,
      owner.language
    );
  } catch (e) {
    console.error("[Share] Failed to send approval notification:", e);
    return false;
  }
}
```

**`src/services/bot.ts`** (as Task 6a left it: `logFailures` has the `inFlight` set; nothing else changed).

`/start` upsert. Current:
```ts
    await supabase.from("users").upsert(
      {
        telegram_id: telegramId,
        name,
        username: username || null,
        language,
      },
      { onConflict: "telegram_id" }
    );
```
replacement:
```ts
    const { error: upsertError } = await supabase.from("users").upsert(
      {
        telegram_id: telegramId,
        name,
        username: username || null,
        language,
      },
      { onConflict: "telegram_id" }
    );
    // Still send the welcome: the Mini App creates the row on first open (POST /api/user).
    if (upsertError) {
      console.error("[Bot] /start user upsert failed, telegramId:", telegramId, upsertError);
    }
```

`sendApprovalRequest`. Current signature tail:
```ts
  collaboratorId: string,
  ownerLanguage: string
) {
  try {
```
replacement:
```ts
  collaboratorId: string,
  ownerLanguage: string
): Promise<boolean> {
  try {
```
Current end of the function:
```ts
    );
  } catch (error) {
    console.error("[Bot] Failed to send approval request:", error);
  }
}
```
replacement:
```ts
    );
    return true;
  } catch (error) {
    console.error("[Bot] Failed to send approval request:", error);
    return false;
  }
}
```

Approve/decline read. Current:
```ts
    const { data: collab } = await supabase
      .from("collaborators")
      .select("*, users!collaborators_user_id_fkey(telegram_id, name, language), lists!collaborators_list_id_fkey(name, owner_id, users!lists_owner_id_fkey(telegram_id, language))")
      .eq("id", collaboratorId)
      .single();

    if (!collab) {
```
replacement:
```ts
    const { data: collab, error: readError } = await supabase
      .from("collaborators")
      .select("*, users!collaborators_user_id_fkey(telegram_id, name, language), lists!collaborators_list_id_fkey(name, owner_id, users!lists_owner_id_fkey(telegram_id, language))")
      .eq("id", collaboratorId)
      .maybeSingle();

    // The owner's row was not loaded, so answer in the tapper's Telegram language. The
    // buttons stay on the message, so the owner can tap again.
    if (readError) {
      console.error("[Bot] Join request read failed, collaboratorId:", collaboratorId, readError);
      await bot.answerCallbackQuery(query.id, {
        text: getMsg(query.from.language_code, "errors.generic"),
      });
      return;
    }
    if (!collab) {
```

Status update. Current:
```ts
    // Update status
    const newStatus = isApprove ? "approved" : "declined";
    await supabase
      .from("collaborators")
      .update({ status: newStatus })
      .eq("id", collaboratorId);

    const requesterTgId = collabData.users?.telegram_id;
    const requesterName = collabData.users?.name || "Someone";
    const listName = collabData.lists?.name || "a list";
    const requesterLang = collabData.users?.language || "en";
    const ownerLang = collabData.lists?.users?.language || "en";
```
replacement:
```ts
    const requesterTgId = collabData.users?.telegram_id;
    const requesterName = collabData.users?.name || "Someone";
    const listName = collabData.lists?.name || "a list";
    const requesterLang = collabData.users?.language || "en";
    const ownerLang = collabData.lists?.users?.language || "en";

    // Update status
    const newStatus = isApprove ? "approved" : "declined";
    const { error: updateError } = await supabase
      .from("collaborators")
      .update({ status: newStatus })
      .eq("id", collaboratorId);

    // Stop before telling the requester anything or editing the owner's message,
    // so the Approve / Decline buttons stay for another tap.
    if (updateError) {
      console.error("[Bot] Join request status update failed, collaboratorId:", collaboratorId, updateError);
      await bot.answerCallbackQuery(query.id, { text: getMsg(ownerLang, "errors.generic") });
      return;
    }
```
Everything after (notify requester, "Approved!"/"Declined." answer, editMessageText) stays as is.

- [ ] **Step 4: update existing tests/mocks**

None break. Verified against the full suite: `removed-reminder-buttons.test.ts` mocks both `.single()` and `.maybeSingle()` and never reaches the approve path, and `bot-command-errors.test.ts` was updated in Step 1. `errors.generic` already exists in en, he and ru (messages/*.json:182). No new i18n keys.

- [ ] **Step 5: run tests, expected PASS**

```bash
npx vitest run __tests__/unit/share-token-route.test.ts __tests__/unit/join-request-bot.test.ts __tests__/unit/bot-command-errors.test.ts __tests__/unit/removed-reminder-buttons.test.ts __tests__/unit/telegram-error-redaction.test.ts __tests__/unit/no-silent-catches.test.ts
npx tsc --noEmit
npx eslint "app/api/share/[token]/route.ts" src/services/bot.ts __tests__/helpers/fake-supabase.ts __tests__/unit/share-token-route.test.ts __tests__/unit/join-request-bot.test.ts __tests__/unit/bot-command-errors.test.ts
```

- [ ] **Step 6: make it bite** (each one: make the edit, run the named file, see the named test go red, restore)

`npx vitest run __tests__/unit/share-token-route.test.ts`:
1. Delete `if (inviteError) return dbError("Share", "Invite read", inviteError);`. Red: "answers a failed invite read with a logged 500, without the token in any log".
2. Invite read `.maybeSingle()` changed back to `.single()`. Red: "still answers 404 for an invite that does not exist, and logs no error".
3. Delete the `if (listError) ...` line. Red: "answers a failed list read with a logged 500, not 'list deleted'".
4. List read back to `.single()`. Red: "still answers 410 for a list that is really gone".
5. Replace `return dbError("Share", "User upsert", ...)` with the old unlogged `NextResponse.json({ error: "Failed to register user" }, { status: 500 })`. Red: "logs a failed user upsert with the telegram id before its 500".
6. `if (existingError) {` changed to `if (false) {`. Red: "answers a failed collaborator-row read with a 500 before any write".
7. Collaborator read back to `.single()`. Red: "creates a pending request and asks the owner, in the owner's language", plus the other no-row paths.
8. `if (reinviteError) {` changed to `if (false) {`. Red: "answers a failed re-invite update with a 500 and never asks the owner".
9. Delete the `if (countError) ...` line. Red: "fails closed with a 500 when the pending count cannot be read, and inserts nothing".
10. `if (error || !collab) {` changed to `if (error) {` (the `collab.id` uses then need `!` for tsc; tests run without tsc). Red: "answers an insert that returns no row with a logged 500 instead of crashing".
11. The re-invite branch's `if (!notified) {` changed to `if (false) {`. Red: "answers 200 pending, logs and warns when sending throws".
12. The new-request branch's `if (!notified) {` changed to `if (false) {`. Red: "answers 200 pending and warns when the bot could not message the owner".
13. `if (ownerError) {` changed to `if (false) {`. Red: "logs a failed owner read and warns, without trying to send".
14. Owner read back to `.single()`. Red: "warns about a missing owner row, without trying to send".
15. `return await sendApprovalRequest(` changed to `await sendApprovalRequest(` (and `return true;` after it, for tsc). Red: "answers 200 pending and warns when the bot could not message the owner".
16. DELETE `if (error) {` changed to `if (false) {`. Red: "answers a failed delete with a logged 500, so the page does not claim it cancelled".

`npx vitest run __tests__/unit/join-request-bot.test.ts`:
17. `if (readError) {` changed to `if (false) {`. Red: both "a failed read answers errors.generic ..." cases.
18. The callback read back to `.single()`. Red: "still says 'Request not found.' for a request that is really gone, and logs no error".
19. `if (updateError) {` changed to `if (false) {`. Red: both "a failed status update answers errors.generic ..." cases.
20. Remove `return true;` and `return false;` from `sendApprovalRequest`. Red: both `sendApprovalRequest` tests.

`npx vitest run __tests__/unit/bot-command-errors.test.ts`:
21. `if (upsertError) {` changed to `if (false) {`. Red: "logs the failed upsert with the telegram id and still sends the welcome".

(All 21 were run once in a scratch copy of the repo while writing this plan, and each went red.)

- [ ] **Step 7: commit**

```bash
git add "app/api/share/[token]/route.ts" src/services/bot.ts __tests__/helpers/fake-supabase.ts __tests__/unit/share-token-route.test.ts __tests__/unit/join-request-bot.test.ts __tests__/unit/bot-command-errors.test.ts
git commit -m "$(cat <<'EOF'
fix(share): tell database failures apart from dead invites and failed approvals

POST /api/share/[token] now answers a failed invite, list, collaborator,
re-invite or pending-count call with a logged 500 instead of 404, 410,
a fall-through insert or a bypassed cap. Missing rows keep their 404/410
via maybeSingle. The invite token is never logged. A failed owner ping
keeps the request pending and logs a warning. Cancel checks its delete.

Bot approve/decline: a failed read or status update answers
errors.generic and returns before messaging the requester or editing the
owner's message, so the buttons stay. /start logs a failed user upsert.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
)"
```

### Task 6c: Invite page: try again on server failures, cancel only after confirmation

**Files:**
- Create: `src/utils/invite-requests.ts` (the page's two requests, moved out so they can be tested without a DOM; the repo's Vitest runs in node with no jsdom or happy-dom installed)
- Modify: `app/invite/[token]/page.tsx`
- Create (test): `__tests__/unit/invite-requests.test.ts`

**Interfaces:**
- Consumes: none from earlier tasks. The status codes come from Task 6b: 500 for DB failures, 404/410/400 for real refusals, 500 on a failed cancel.
- Produces (used only by the invite page):
  - `export type JoinOutcome = { kind: "pending"; listId: string; listName: string; collaboratorId: string } | { kind: "member"; listId: string } | { kind: "invalid"; message: string } | { kind: "retry" }`
  - `export async function requestToJoin(token: string, initData: string): Promise<JoinOutcome>`
  - `export async function cancelJoinRequest(token: string, collaboratorId: string, headers: Record<string, string>): Promise<boolean>`

**Sites:**

| site (as of today) | today on failure | change | user-visible result |
|---|---|---|---|
| `app/invite/[token]/page.tsx:35-62` accept | every non-ok answer except already_* becomes the terminal "Invite not valid" with the server's English text; a network error or non-JSON 500 also becomes "Invite not valid" with a hardcoded English line | `requestToJoin`: status >= 500 or 429, a non-JSON body or a network error gives `retry`; the page shows a new `retry` state with `errors.generic`, Retry (`common.retry`, re-runs accept) and Go home (`common.goHome`). 404/410/400 keep "Invite not valid" | a DB blip no longer tells the invitee the link is dead; one tap retries |
| `app/invite/[token]/page.tsx:84` cancel | `res.ok` never read; `router.push("/")` always runs | `cancelJoinRequest` returns true only on `res.ok`; the page pushes home only on true, otherwise stays on waiting and shows `errors.generic` under Cancel (centred, `role="alert"`, cleared on the next tap) | the invitee is no longer sent home while the request stays pending |
| `app/invite/[token]/page.tsx:82` no-credentials early return (missed by inventory) | the Cancel tap silently does nothing | `console.warn` with the collaboratorId, show the same inline error | the tap gives feedback |

- [ ] **Step 1: write the failing tests**

Create `__tests__/unit/invite-requests.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { requestToJoin, cancelJoinRequest } from "@/src/utils/invite-requests";

// The invite page's two requests. A server failure or a dropped connection must never be shown
// as "Invite not valid", and Cancel must only count as done when the server confirms it.
const TOKEN = "invite-token-SECRET-123";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("requestToJoin", () => {
  it("posts to the invite route with the init data header", async () => {
    fetchMock.mockResolvedValue(json(200, { listId: "L1", listName: "Groceries", collaboratorId: "c1", status: "pending" }));

    await requestToJoin(TOKEN, "init-data");

    expect(fetchMock).toHaveBeenCalledWith(`/api/share/${TOKEN}`, {
      method: "POST",
      headers: { "x-telegram-init-data": "init-data", "Content-Type": "application/json" },
    });
  });

  it("a new request is pending", async () => {
    fetchMock.mockResolvedValue(json(200, { listId: "L1", listName: "Groceries", collaboratorId: "c1", status: "pending" }));

    await expect(requestToJoin(TOKEN, "init-data")).resolves.toEqual({
      kind: "pending", listId: "L1", listName: "Groceries", collaboratorId: "c1",
    });
  });

  it("an earlier pending request is pending too", async () => {
    fetchMock.mockResolvedValue(json(400, { status: "already_pending", listId: "L1", listName: "Groceries", collaboratorId: "c1" }));

    await expect(requestToJoin(TOKEN, "init-data")).resolves.toEqual({
      kind: "pending", listId: "L1", listName: "Groceries", collaboratorId: "c1",
    });
  });

  it("a member is sent to the list", async () => {
    fetchMock.mockResolvedValue(json(400, { status: "already_approved", listId: "L1" }));

    await expect(requestToJoin(TOKEN, "init-data")).resolves.toEqual({ kind: "member", listId: "L1" });
  });

  it.each([
    [404, "Invite not found"],
    [410, "This list has been deleted."],
  ])("a dead link (%s) is invalid, with the server's reason", async (status, error) => {
    fetchMock.mockResolvedValue(json(status, { error }));

    await expect(requestToJoin(TOKEN, "init-data")).resolves.toEqual({ kind: "invalid", message: error });
  });

  it.each([500, 503, 429])("a %s answer is 'try again', not invalid, and is logged", async (status) => {
    fetchMock.mockResolvedValue(json(status, { error: "Invite read failed" }));

    await expect(requestToJoin(TOKEN, "init-data")).resolves.toEqual({ kind: "retry" });
    expect(console.error).toHaveBeenCalledWith("[Invite] Join request failed, status:", status);
  });

  it("a 500 with an HTML body is 'try again' too", async () => {
    fetchMock.mockResolvedValue(new Response("<html>Internal Server Error</html>", { status: 500 }));

    await expect(requestToJoin(TOKEN, "init-data")).resolves.toEqual({ kind: "retry" });
  });

  it("a dropped connection is 'try again' and logs the error", async () => {
    const offline = new TypeError("Failed to fetch");
    fetchMock.mockRejectedValue(offline);

    await expect(requestToJoin(TOKEN, "init-data")).resolves.toEqual({ kind: "retry" });
    expect(console.warn).toHaveBeenCalledWith("[Invite] Join request did not reach the server:", offline);
  });

  it("never logs the invite token", async () => {
    fetchMock.mockResolvedValue(json(500, {}));
    await requestToJoin(TOKEN, "init-data");
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await requestToJoin(TOKEN, "init-data");

    const printed = [...vi.mocked(console.error).mock.calls, ...vi.mocked(console.warn).mock.calls]
      .flat()
      .map(String)
      .join("\n");
    expect(printed).not.toContain(TOKEN);
  });
});

describe("cancelJoinRequest", () => {
  const headers = { Authorization: "Bearer jwt" };

  it("sends the DELETE and is true when the server confirms", async () => {
    fetchMock.mockResolvedValue(json(200, { success: true }));

    await expect(cancelJoinRequest(TOKEN, "c1", headers)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(`/api/share/${TOKEN}?collaboratorId=c1`, { method: "DELETE", headers });
  });

  it("is false and logs the status when the server refuses", async () => {
    fetchMock.mockResolvedValue(json(500, { error: "Join request cancel failed" }));

    await expect(cancelJoinRequest(TOKEN, "c1", headers)).resolves.toBe(false);
    expect(console.error).toHaveBeenCalledWith("[Invite] Cancel join request failed, collaboratorId:", "c1", "status:", 500);
  });

  it("is false and logs the error when the connection drops", async () => {
    const offline = new TypeError("Failed to fetch");
    fetchMock.mockRejectedValue(offline);

    await expect(cancelJoinRequest(TOKEN, "c1", headers)).resolves.toBe(false);
    expect(console.warn).toHaveBeenCalledWith("[Invite] Failed to cancel join request, collaboratorId:", "c1", offline);
  });
});
```

- [ ] **Step 2: run them, expected FAIL**

`npx vitest run __tests__/unit/invite-requests.test.ts`. Expected: the file fails to load with `Failed to resolve import "@/src/utils/invite-requests"`, because the module does not exist yet.

- [ ] **Step 3: implementation**

Create `src/utils/invite-requests.ts`:
```ts
/** What the invite page shows after asking to join a list. */
export type JoinOutcome =
  | { kind: "pending"; listId: string; listName: string; collaboratorId: string }
  | { kind: "member"; listId: string }
  | { kind: "invalid"; message: string }
  | { kind: "retry" };

/**
 * Asks to join the list behind an invite link. A server failure (5xx), a rate limit (429) or a
 * dropped connection is "retry": the link may be fine. Only the route's own refusals (404, 410,
 * 400) are "invalid". The token is in the URL, so it is never logged.
 */
export async function requestToJoin(token: string, initData: string): Promise<JoinOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/share/${token}`, {
      method: "POST",
      headers: {
        "x-telegram-init-data": initData,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    console.warn("[Invite] Join request did not reach the server:", err);
    return { kind: "retry" };
  }

  if (res.status >= 500 || res.status === 429) {
    console.error("[Invite] Join request failed, status:", res.status);
    return { kind: "retry" };
  }

  let data: { status?: string; listId?: string; listName?: string; collaboratorId?: string; error?: string };
  try {
    data = await res.json();
  } catch (err) {
    console.error("[Invite] Join response was not JSON, status:", res.status, err);
    return { kind: "retry" };
  }

  if (res.ok || data.status === "already_pending") {
    return {
      kind: "pending",
      listId: data.listId || "",
      listName: data.listName || "",
      collaboratorId: data.collaboratorId || "",
    };
  }
  if (data.status === "already_approved" && data.listId) {
    return { kind: "member", listId: data.listId };
  }
  return { kind: "invalid", message: data.error || "This invite is no longer valid." };
}

/** Withdraws a pending join request. True only when the server confirmed it. */
export async function cancelJoinRequest(
  token: string,
  collaboratorId: string,
  headers: Record<string, string>
): Promise<boolean> {
  try {
    const res = await fetch(`/api/share/${token}?collaboratorId=${collaboratorId}`, {
      method: "DELETE",
      headers,
    });
    if (!res.ok) {
      console.error("[Invite] Cancel join request failed, collaboratorId:", collaboratorId, "status:", res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[Invite] Failed to cancel join request, collaboratorId:", collaboratorId, err);
    return false;
  }
}
```
(The "invalid" fallback text `"This invite is no longer valid."` is the page's existing fallback, moved as is. Translating the server's English error texts is the out-of-scope string cleanup.)

`app/invite/[token]/page.tsx`. Imports, current:
```tsx
import { Loader2 } from "lucide-react";
import TelegramProvider, { useTelegram } from "@/components/TelegramProvider";
```
replacement:
```tsx
import { Loader2, RefreshCw } from "lucide-react";
import TelegramProvider, { useTelegram } from "@/components/TelegramProvider";
import { requestToJoin, cancelJoinRequest } from "@/src/utils/invite-requests";
```
Status union, current:
```tsx
    "loading" | "waiting" | "approved" | "declined" | "error" | "already"
  >("loading");
```
replacement:
```tsx
    "loading" | "waiting" | "approved" | "declined" | "error" | "already" | "retry"
  >("loading");
```
Accept, current (from `const [collaboratorId, setCollaboratorId] = useState("");` through the end of `acceptInvite`'s `useCallback`):
```tsx
  const [collaboratorId, setCollaboratorId] = useState("");

  const acceptInvite = useCallback(async () => {
    try {
      const res = await fetch(`/api/share/${token}`, {
        method: "POST",
        headers: {
          "x-telegram-init-data": initData!,
          "Content-Type": "application/json",
        },
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.status === "already_approved") {
          setListId(data.listId);
          setStatus("already");
          router.push(`/list/${data.listId}`);
          return;
        }
        if (data.status === "already_pending") {
          setListName(data.listName || "");
          setListId(data.listId || "");
          setCollaboratorId(data.collaboratorId || "");
          setStatus("waiting");
          return;
        }
        setErrorMessage(data.error || "This invite is no longer valid.");
        setStatus("error");
        return;
      }

      setListName(data.listName || "");
      setListId(data.listId || "");
      setCollaboratorId(data.collaboratorId || "");
      setStatus("waiting");
    } catch (err) {
      console.error("[Invite] Failed to accept invite:", err);
      setErrorMessage("Something went wrong. Please try again.");
      setStatus("error");
    }
  }, [token, initData, router]);
```
replacement:
```tsx
  const [collaboratorId, setCollaboratorId] = useState("");
  const [cancelFailed, setCancelFailed] = useState(false);

  const acceptInvite = useCallback(async () => {
    const outcome = await requestToJoin(token, initData!);
    switch (outcome.kind) {
      case "member":
        setListId(outcome.listId);
        setStatus("already");
        router.push(`/list/${outcome.listId}`);
        return;
      case "pending":
        setListName(outcome.listName);
        setListId(outcome.listId);
        setCollaboratorId(outcome.collaboratorId);
        setStatus("waiting");
        return;
      case "invalid":
        setErrorMessage(outcome.message);
        setStatus("error");
        return;
      case "retry":
        setStatus("retry");
        return;
    }
  }, [token, initData, router]);

  const retryInvite = () => {
    setStatus("loading");
    void acceptInvite();
  };
```
Cancel, current:
```tsx
  const cancelRequest = async () => {
    if (!collaboratorId) return;
    const jwt = jwtRef.current;
```
replacement:
```tsx
  const cancelRequest = async () => {
    if (!collaboratorId) return;
    setCancelFailed(false);
    const jwt = jwtRef.current;
```
current:
```tsx
    if (Object.keys(headers).length === 0) return;
    try {
      await fetch(`/api/share/${token}?collaboratorId=${collaboratorId}`, {
        method: "DELETE",
        headers,
      });
    } catch (err) {
      console.warn("[Invite] Failed to cancel join request, collaboratorId:", collaboratorId, err);
    }
    router.push("/");
  };
```
replacement:
```tsx
    if (Object.keys(headers).length === 0) {
      console.warn("[Invite] No credentials to cancel the join request, collaboratorId:", collaboratorId);
      setCancelFailed(true);
      return;
    }
    // Go home only once the server confirmed; otherwise the request would stay pending
    // while the invitee believes it is withdrawn.
    if (!(await cancelJoinRequest(token, collaboratorId, headers))) {
      setCancelFailed(true);
      return;
    }
    router.push("/");
  };
```
New retry screen: insert directly above `  if (status === "waiting") {`. It mirrors the home page's loadError Retry button (`app/page.tsx:421-433`) and the existing secondary button style:
```tsx
  if (status === "retry") {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen px-6 text-center">
        <p className="text-tg-hint mb-6">{t('errors.generic')}</p>
        <div className="flex flex-col items-center gap-3">
          <button
            onClick={retryInvite}
            className="flex items-center gap-2 px-6 py-3.5 rounded-2xl bg-tg-button text-tg-button-text font-medium active:scale-[0.98]"
          >
            <RefreshCw className="w-4 h-4" />
            {t('common.retry')}
          </button>
          <button
            onClick={() => router.push("/")}
            className="px-6 py-3.5 rounded-2xl bg-tg-secondary-bg text-tg-text font-medium active:scale-[0.98]"
          >
            {t('common.goHome')}
          </button>
        </div>
      </div>
    );
  }

```
Inline cancel error, in the waiting screen. Current:
```tsx
          {t('share.cancelRequest')}
        </button>
      </div>
```
replacement:
```tsx
          {t('share.cancelRequest')}
        </button>
        {cancelFailed && (
          <p role="alert" className="mt-3 text-sm text-tg-destructive text-center">
            {t('errors.generic')}
          </p>
        )}
      </div>
```
(`text-tg-destructive` is the existing error-text token used by `components/CategoriesSheet.tsx:157`. The parent is already `text-center`, so the text stays centred and RTL-safe. All four keys exist in en/he/ru: `errors.generic`, `common.retry`, `common.goHome`, `share.cancelRequest`.)

- [ ] **Step 4: update existing tests/mocks**

None. No existing test covers the invite page. `no-silent-catches.test.ts` scans the new module: both catches log the error object.

- [ ] **Step 5: run tests, expected PASS**

```bash
npx vitest run __tests__/unit/invite-requests.test.ts __tests__/unit/no-silent-catches.test.ts
npx tsc --noEmit
npx eslint "app/invite/[token]/page.tsx" src/utils/invite-requests.ts __tests__/unit/invite-requests.test.ts
```

- [ ] **Step 6: make it bite**

1. In `src/utils/invite-requests.ts`, change `if (res.status >= 500 || res.status === 429) {` to `if (false) {`. Run `npx vitest run __tests__/unit/invite-requests.test.ts`: the three "a 500 / 503 / 429 answer is 'try again'" cases go red. Restore.
2. Change cancel's `if (!res.ok) {` to `if (false) {`. Red: "cancelJoinRequest > is false and logs the status when the server refuses". Restore.
3. Page wiring has no automated test (no DOM environment in this repo). Check by reading: `router.push("/")` in `cancelRequest` comes after the `if (!(await cancelJoinRequest(...))) { ...; return; }` guard.

- [ ] **Step 7: commit**

```bash
git add src/utils/invite-requests.ts "app/invite/[token]/page.tsx" __tests__/unit/invite-requests.test.ts
git commit -m "$(cat <<'EOF'
fix(invite): try again on server failures, leave only after a confirmed cancel

A 5xx, 429, non-JSON answer or dropped connection on the invite page now
shows "Something went wrong. Please try again." with Retry and Go home,
instead of the final "Invite not valid" screen. A genuinely dead link
still shows "Invite not valid". Cancel goes home only after the server
confirms the delete; otherwise the waiting screen stays, with the error
under the Cancel button.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
)"
```

### Task 7a: Client background saves, list page (helpers, item undo, clear / unmark, type switch)

**Files:**
- Create: `src/utils/http.ts`, `src/utils/item-restore.ts`
- Modify: `src/hooks/useItemHandlers.ts`, `app/list/[id]/page.tsx`, `components/list/ToastContainer.tsx`
- Test (create): `__tests__/unit/throw-if-not-ok.test.ts`, `__tests__/unit/item-restore.test.ts`, `__tests__/unit/list-background-saves.test.ts`
- Test (modify): `__tests__/unit/list-type-switch.test.ts`, `__tests__/unit/categories-sheet-wiring.test.ts` (comment only)

No earlier task touches these files. Not touched: `src/utils/executor-factory.ts` and every inline `execute` closure in `useItemHandlers.ts`. The parity tests (`mutation-request-parity.test.ts`, `executor-factory.test.ts`) must stay green with no edits.

**Interfaces:**
- Consumes: nothing from earlier tasks. Browser code only, with no server helpers.
- Produces:
  - `export function throwIfNotOk(res: Response, verb: string): void` in `src/utils/http.ts`. The signature is the one fixed in shared-context.md. It throws `Error("<verb> failed: <status>")` for a non-2xx response.
  - `export type RestoreBody = { itemId: string } & Record<string, unknown>` in `src/utils/item-restore.ts`.
  - `export async function restoreItemsOnServer(listId: string, jwt: string | null, bodies: RestoreBody[]): Promise<string[]>` in `src/utils/item-restore.ts`. It sends one `PATCH /api/lists/{listId}/items` per body, in parallel, and checks each one with `throwIfNotOk(res, "Restore")`. It logs each failure as `console.error("[ItemRestore] Undo restore failed:", { listId, itemId }, reason)`. It never rejects, and resolves with the failed item ids in input order.
  - Task 7b imports `throwIfNotOk`. Task 8 may import it too.
  - Verbs used, none containing "fetch" or "network": `Restore`, `Clear completed`, `Unmark all`, `Type change`.

**Sites:**

| site (file:line today) | today on failure | change | user-visible result |
|---|---|---|---|
| src/hooks/useItemHandlers.ts:234 (undo delete item) | Floating PATCH. Nothing is checked or caught, and the item shows as restored but stays deleted on the server. | `restoreOrRevert([{ itemId, deleted_at: null }], removeAgain)` | On failure the item leaves the screen again and "Failed to sync change" shows. |
| src/hooks/useItemHandlers.ts:526 (undo remove duplicates) | N floating PATCHes | `restoreOrRevert(duplicates → bodies, removeAgain)` | Only the duplicates whose restore failed leave again, with one syncError toast. |
| src/hooks/useItemHandlers.ts:585 (undo clear completed) | N floating PATCHes | `restoreOrRevert(cleared → bodies, removeAgain)` | Only the failed items leave again, with one syncError toast. |
| src/hooks/useItemHandlers.ts:598 (clear completed POST) | `res.ok` is never read and there is no try/catch, so a network error is an unhandled rejection | try/catch + `throwIfNotOk(res, "Clear completed")`. On failure: log, clear the undo toast, merge the cleared items back (skipping ids already present), syncError | Items come back right away with their completion time, and "Failed to sync change" shows (product call 4A). |
| src/hooks/useItemHandlers.ts:635 (undo unmark all) | N floating PATCHes | `restoreOrRevert(ids → {completed:true}, uncheck failed)` | Only the failed items are unchecked again, with one syncError toast. |
| src/hooks/useItemHandlers.ts:648 (unmark all POST) | Same as 598 | try/catch + `throwIfNotOk(res, "Unmark all")`. On failure: log, clear the undo toast, re-check from a map of `completed_at` captured before the flip, syncError | The items go back to done with their original times, and the toast shows. |
| app/list/[id]/page.tsx:371 (type switch) | `.then` ignores `res.ok`: the optimistic type stays and `loadCategories` runs | capture `previousType`, `throwIfNotOk(res, "Type change")` before `loadCategories`. The catch reverts the type and shows `errors.generic` | The type control flips back and "Something went wrong. Please try again." shows above the settings sheet. |
| components/list/ToastContainer.tsx:30 (error toast `z-30`) | The error toast draws under the z-50 settings sheet, so the type-switch error above would go unseen | the error toast becomes `z-[60]` | The error toast is visible over the settings sheet. |

**Same-class sweep of these files:** every other `fetch` in `useItemHandlers.ts` is either inside an `addMutation` execute, which already throws `"<Verb> failed: <status>"`, or is `sendSignal`, which already checks `res.ok` and catches. `app/list/[id]/page.tsx` has no other fetch. Nothing was missed.

- [ ] **Step 1: write the failing tests**

Create these three files exactly as given.

`__tests__/unit/throw-if-not-ok.test.ts` (complete file):

```ts
import { describe, it, expect } from "vitest";
import { throwIfNotOk } from "@/src/utils/http";

const res = (status: number) => ({ ok: status >= 200 && status < 300, status }) as Response;

// useMutationQueue reads the status with this pattern: 4xx drops the change, 5xx retries it.
const QUEUE_STATUS = /:\s*(\d{3})$/;

describe("throwIfNotOk", () => {
  it("lets a 2xx response through", () => {
    expect(() => throwIfNotOk(res(200), "Save")).not.toThrow();
    expect(() => throwIfNotOk(res(204), "Save")).not.toThrow();
  });

  it("throws '<verb> failed: <status>' for any other status", () => {
    expect(() => throwIfNotOk(res(500), "Clear completed")).toThrow(new Error("Clear completed failed: 500"));
    expect(() => throwIfNotOk(res(404), "Restore")).toThrow(new Error("Restore failed: 404"));
  });

  it("ends with the status the offline queue parses", () => {
    for (const status of [400, 403, 404, 500, 503]) {
      const message = (() => {
        try {
          throwIfNotOk(res(status), "Restore");
          return "";
        } catch (err) {
          return (err as Error).message;
        }
      })();
      expect(message.match(QUEUE_STATUS)?.[1]).toBe(String(status));
    }
  });
});
```

`__tests__/unit/item-restore.test.ts` (complete file):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { restoreItemsOnServer } from "@/src/utils/item-restore";

let fetchMock: ReturnType<typeof vi.fn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Each item id picks how the server answers its restore.
  fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const { itemId } = JSON.parse(init.body);
    if (itemId === "refused") return { ok: false, status: 500 };
    if (itemId === "gone") return { ok: false, status: 404 };
    if (itemId === "offline") throw new TypeError("Failed to fetch");
    return { ok: true, status: 200 };
  });
  vi.stubGlobal("fetch", fetchMock);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("restoreItemsOnServer", () => {
  it("sends one PATCH per item, with its body and the session token", async () => {
    await restoreItemsOnServer("L", "jwt", [
      { itemId: "a", deleted_at: null },
      { itemId: "b", completed: true },
    ]);

    const headers = { Authorization: "Bearer jwt", "Content-Type": "application/json" };
    expect(fetchMock.mock.calls).toEqual([
      ["/api/lists/L/items", { method: "PATCH", headers, body: JSON.stringify({ itemId: "a", deleted_at: null }) }],
      ["/api/lists/L/items", { method: "PATCH", headers, body: JSON.stringify({ itemId: "b", completed: true }) }],
    ]);
  });

  it("returns exactly the ids whose restore was refused or not sent, and logs each one", async () => {
    const failed = await restoreItemsOnServer("L", "jwt", [
      { itemId: "a", deleted_at: null },
      { itemId: "refused", deleted_at: null },
      { itemId: "gone", deleted_at: null },
      { itemId: "offline", deleted_at: null },
      { itemId: "b", deleted_at: null },
    ]);

    expect(failed).toEqual(["refused", "gone", "offline"]);
    expect(errorSpy).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledWith(
      "[ItemRestore] Undo restore failed:",
      { listId: "L", itemId: "refused" },
      expect.objectContaining({ message: "Restore failed: 500" })
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[ItemRestore] Undo restore failed:",
      { listId: "L", itemId: "gone" },
      expect.objectContaining({ message: "Restore failed: 404" })
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[ItemRestore] Undo restore failed:",
      { listId: "L", itemId: "offline" },
      expect.any(TypeError)
    );
  });

  it("returns no ids and logs nothing when every restore lands", async () => {
    const failed = await restoreItemsOnServer("L", "jwt", [{ itemId: "a", deleted_at: null }]);

    expect(failed).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
```

`__tests__/unit/list-background-saves.test.ts` (complete file):

```ts
/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";

// useItemHandlers only uses useCallback, and React's own throws outside a render.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (fn: unknown) => fn,
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

import { useItemHandlers } from "@/src/hooks/useItemHandlers";
import ToastContainer from "@/components/list/ToastContainer";
import type { ItemData } from "@/src/types";

const DONE_A = "2026-10-20T09:00:00.000Z";
const DONE_B = "2026-10-21T18:30:00.000Z";

function item(over: Partial<ItemData> & { id: string }): ItemData {
  return {
    text: over.id, completed: false, completed_at: null, deleted_at: null, skipped_at: null,
    ordered_at: null, recurring: false, position: 1, created_by: null, creator_name: null,
    edited_by: null, editor_name: null, ...over,
  };
}

// How the fake server answers one request: a status, a network failure, or held until released.
type Reply = number | "neterr" | "hold";
type Undo = { message: string; undo: () => void; timeout: NodeJS.Timeout } | null;

// The list page around the real hook: items, the undo toast and the error toast live here,
// and fetch is a fake server. Keys: "PATCH <itemId>", "POST clear-completed", "POST unmark-completed".
function world(initial: ItemData[]) {
  let items = initial;
  let undoAction: Undo = null;
  let errorToast: string | null = null;
  const replies = new Map<string, Reply[]>();
  const held = new Map<string, (status: number) => void>();
  const sent: { key: string; body: unknown }[] = [];

  vi.stubGlobal("window", {});
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { method: string; body?: string }) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    const key = url.endsWith("/items") ? `${init.method} ${body.itemId}` : `${init.method} ${url.slice(url.lastIndexOf("/") + 1)}`;
    sent.push({ key, body });
    const reply = replies.get(key)?.shift() ?? 200;
    if (reply === "neterr") throw new TypeError("Failed to fetch");
    const status = reply === "hold" ? await new Promise<number>((resolve) => held.set(key, resolve)) : reply;
    return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
  }));

  const jwtRef = { current: "jwt" as string | null };
  // A fresh call reads the latest items, as a re-render would.
  const h = () =>
    useItemHandlers({
      listId: "L",
      jwtRef,
      userId: "u",
      items,
      setItems: (u) => { items = typeof u === "function" ? u(items) : u; },
      addMutation: () => {},
      setUndoAction: (u) => { undoAction = typeof u === "function" ? u(undoAction) : u; },
      setDuplicateWarning: () => {},
      setReminderToast: () => {},
      setErrorToast: (u) => { errorToast = typeof u === "function" ? u(errorToast) : u; },
      t: (key) => key,
    });

  return {
    h,
    when: (key: string, ...r: Reply[]) => replies.set(key, r),
    release: (key: string, status: number) => held.get(key)!(status),
    ids: () => items.map((i) => i.id).sort(),
    item: (id: string) => items.find((i) => i.id === id),
    undoAction: () => undoAction,
    errorToast: () => errorToast,
    sent,
  };
}

// Let queued promise chains run without moving the clock.
const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
};

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Clear completed fails", () => {
  const listItems = () => [
    item({ id: "a" }),
    item({ id: "b", completed: true, completed_at: DONE_A }),
    item({ id: "c", completed: true, completed_at: DONE_B }),
  ];

  it("a server error puts the cleared items back as they were, drops the undo and says so", async () => {
    const w = world(listItems());
    w.when("POST clear-completed", 500);

    await w.h().handleClearCompleted();

    expect(w.ids()).toEqual(["a", "b", "c"]);
    expect(w.item("b")).toMatchObject({ completed: true, completed_at: DONE_A, deleted_at: null });
    expect(w.item("c")).toMatchObject({ completed: true, completed_at: DONE_B, deleted_at: null });
    expect(w.undoAction()).toBeNull();
    expect(w.errorToast()).toBe("items.syncError");
    expect(errorSpy).toHaveBeenCalledWith(
      "[List] Clear completed failed:",
      { listId: "L" },
      expect.objectContaining({ message: "Clear completed failed: 500" })
    );
  });

  it("a clear that could not be sent does the same, without rejecting", async () => {
    const w = world(listItems());
    w.when("POST clear-completed", "neterr");

    await expect(w.h().handleClearCompleted()).resolves.toBeUndefined();

    expect(w.ids()).toEqual(["a", "b", "c"]);
    expect(w.errorToast()).toBe("items.syncError");
    expect(errorSpy).toHaveBeenCalledWith("[List] Clear completed failed:", { listId: "L" }, expect.any(TypeError));
  });

  it("a clear that fails after Undo was tapped shows each item once", async () => {
    const w = world(listItems());
    w.when("POST clear-completed", "hold");

    const clearing = w.h().handleClearCompleted();
    await settle();
    w.undoAction()!.undo();
    await settle();
    w.release("POST clear-completed", 500);
    await clearing;

    expect(w.ids()).toEqual(["a", "b", "c"]);
    expect(w.errorToast()).toBe("items.syncError");
  });

  it("a clear the server accepted stays cleared, with its undo and no error", async () => {
    const w = world(listItems());

    await w.h().handleClearCompleted();

    expect(w.ids()).toEqual(["a"]);
    expect(w.undoAction()?.message).toBe("items.clearedCount");
    expect(w.errorToast()).toBeNull();
  });
});

describe("Unmark all done fails", () => {
  const listItems = () => [
    item({ id: "a", completed: true, completed_at: DONE_A }),
    item({ id: "b", completed: true, completed_at: DONE_B }),
    item({ id: "c" }),
  ];

  it("a server error re-checks the items with their original completion time, drops the undo and says so", async () => {
    const w = world(listItems());
    w.when("POST unmark-completed", 500);

    await w.h().handleUnmarkAllDone();

    expect(w.item("a")).toMatchObject({ completed: true, completed_at: DONE_A });
    expect(w.item("b")).toMatchObject({ completed: true, completed_at: DONE_B });
    expect(w.item("c")).toMatchObject({ completed: false, completed_at: null });
    expect(w.undoAction()).toBeNull();
    expect(w.errorToast()).toBe("items.syncError");
    expect(errorSpy).toHaveBeenCalledWith(
      "[List] Unmark all failed:",
      { listId: "L" },
      expect.objectContaining({ message: "Unmark all failed: 500" })
    );
  });

  it("an unmark that could not be sent does the same, without rejecting", async () => {
    const w = world(listItems());
    w.when("POST unmark-completed", "neterr");

    await expect(w.h().handleUnmarkAllDone()).resolves.toBeUndefined();

    expect(w.item("a")).toMatchObject({ completed: true, completed_at: DONE_A });
    expect(w.errorToast()).toBe("items.syncError");
  });

  it("an unmark the server accepted stays unmarked, with no error", async () => {
    const w = world(listItems());

    await w.h().handleUnmarkAllDone();

    expect(w.item("a")).toMatchObject({ completed: false, completed_at: null });
    expect(w.errorToast()).toBeNull();
  });
});

describe("Undo restores on the list page", () => {
  it("Undo of a delete whose restore fails takes the item off the screen again and says so", async () => {
    const w = world([item({ id: "a" }), item({ id: "b" })]);
    w.when("PATCH b", 500);

    await w.h().handleDelete("b");
    await vi.advanceTimersByTimeAsync(200); // the exit animation
    expect(w.ids()).toEqual(["a"]);
    w.undoAction()!.undo();
    expect(w.ids()).toEqual(["a", "b"]);
    await settle();

    expect(w.sent).toContainEqual({ key: "PATCH b", body: { itemId: "b", deleted_at: null } });
    expect(w.ids()).toEqual(["a"]);
    expect(w.errorToast()).toBe("items.syncError");
    expect(errorSpy).toHaveBeenCalledWith(
      "[ItemRestore] Undo restore failed:",
      { listId: "L", itemId: "b" },
      expect.objectContaining({ message: "Restore failed: 500" })
    );
  });

  it("Undo of a delete whose restore lands keeps the item, with no error", async () => {
    const w = world([item({ id: "a" }), item({ id: "b" })]);

    await w.h().handleDelete("b");
    await vi.advanceTimersByTimeAsync(200);
    w.undoAction()!.undo();
    await settle();

    expect(w.ids()).toEqual(["a", "b"]);
    expect(w.errorToast()).toBeNull();
  });

  it("Undo of a duplicates removal takes off again only the duplicate whose restore failed", async () => {
    const w = world([
      item({ id: "m1", text: "milk", position: 3 }),
      item({ id: "m2", text: "milk", position: 2 }),
      item({ id: "m3", text: "milk", position: 1 }),
    ]);
    w.when("PATCH m3", 500);

    w.h().handleRemoveDuplicates("milk");
    expect(w.ids()).toEqual(["m1"]);
    w.undoAction()!.undo();
    await settle();

    expect(w.ids()).toEqual(["m1", "m2"]);
    expect(w.errorToast()).toBe("items.syncError");
  });

  it("Undo of a clear takes off again only the items whose restore failed", async () => {
    const w = world([
      item({ id: "b", completed: true, completed_at: DONE_A }),
      item({ id: "c", completed: true, completed_at: DONE_B }),
    ]);
    w.when("PATCH c", "neterr");

    await w.h().handleClearCompleted();
    w.undoAction()!.undo();
    await settle();

    expect(w.ids()).toEqual(["b"]);
    expect(w.errorToast()).toBe("items.syncError");
  });

  it("Undo of unmark all unchecks again only the item whose restore failed", async () => {
    const w = world([
      item({ id: "a", completed: true, completed_at: DONE_A }),
      item({ id: "b", completed: true, completed_at: DONE_B }),
    ]);
    w.when("PATCH b", 500);

    await w.h().handleUnmarkAllDone();
    w.undoAction()!.undo();
    await settle();

    expect(w.sent).toContainEqual({ key: "PATCH b", body: { itemId: "b", completed: true } });
    expect(w.item("a")).toMatchObject({ completed: true });
    expect(w.item("b")).toMatchObject({ completed: false, completed_at: null });
    expect(w.errorToast()).toBe("items.syncError");
  });
});

type El = ReactElement<Record<string, unknown> & { children?: unknown }>;

function find(node: unknown, match: (el: El) => boolean): El | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, match);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const el = node as El;
  return match(el) ? el : find(el.props.children, match);
}

const zOf = (className: unknown) => Number(/\bz-\[?(\d+)\]?/.exec(String(className))![1]);

describe("the list page's error toast", () => {
  it("draws above the page's sheets (the settings sheet sits at z-50), so a failure raised from one is seen", () => {
    const tree = ToastContainer({ reminderToast: null, duplicateWarning: null, errorToast: "errors.generic", undoAction: null });
    const toast = find(tree, (el) => el.type === "div" && find(el.props.children, (c) => c.props.children === "errors.generic") !== undefined);

    expect(toast).toBeDefined();
    expect(zOf(toast!.props.className)).toBeGreaterThan(50);
  });
});
```

Modify `__tests__/unit/list-type-switch.test.ts`. The old test "a switch that could not be sent loads nothing and fails quietly" asserted that nothing visible happens. It is replaced by the tests below, which keep its no-unhandled-rejection check.

**__tests__/unit/list-type-switch.test.ts, edit 1 (today around line 72).** Current:

```ts
import ListPage from "@/app/list/[id]/page";
import ListHeader from "@/components/list/ListHeader";
import CompletedItemsSection from "@/components/list/CompletedItemsSection";
import { DragDropProvider } from "@dnd-kit/react";

type El = ReactElement<Record<string, unknown> & { children?: unknown }>;
```

Replace with:

```ts
import ListPage from "@/app/list/[id]/page";
import ListHeader from "@/components/list/ListHeader";
import CompletedItemsSection from "@/components/list/CompletedItemsSection";
import ToastContainer from "@/components/list/ToastContainer";
import { DragDropProvider } from "@dnd-kit/react";

type El = ReactElement<Record<string, unknown> & { children?: unknown }>;
```

**__tests__/unit/list-type-switch.test.ts, edit 2 (today around line 117).** Current:

```ts
  (button!.props.onClick as () => void)();
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
```

Replace with:

```ts
  (button!.props.onClick as () => void)();
}

// What the page's error toast says right now.
const errorToast = () => find(render(), (el) => el.type === ToastContainer)!.props.errorToast;

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
```

**__tests__/unit/list-type-switch.test.ts, edit 3 (today around line 143).** Current:

```ts
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("switching a list's type in settings", () => {
```

Replace with:

```ts
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("switching a list's type in settings", () => {
```

**__tests__/unit/list-type-switch.test.ts, edit 4 (today around line 169).** Current:

```ts
    expect(loadCategories).not.toHaveBeenCalled();
  });

  it("a switch that could not be sent loads nothing and fails quietly", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
```

Replace with:

```ts
    expect(loadCategories).not.toHaveBeenCalled();
  });

  it("a switch the server refused puts the old type back, loads nothing, and says so", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    chooseType("grocery");
    patch.resolve({ ok: false, status: 500 });
    await settle();

    expect(setListType.mock.calls).toEqual([["grocery"], ["regular"]]);
    expect(loadCategories).not.toHaveBeenCalled();
    expect(errorToast()).toBe("errors.generic");
    expect(errorSpy).toHaveBeenCalledWith(
      "[List] Failed to update list type, listId:", "L", "type:", "grocery",
      expect.objectContaining({ message: "Type change failed: 500" })
    );
  });

  it("a switch that could not be sent puts the old type back and says so, with no unhandled rejection", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
```

**__tests__/unit/list-type-switch.test.ts, edit 5 (today around line 182).** Current:

```ts
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(loadCategories).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });
});

describe("the list page", () => {
```

Replace with:

```ts
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(setListType.mock.calls).toEqual([["grocery"], ["regular"]]);
    expect(loadCategories).not.toHaveBeenCalled();
    expect(errorToast()).toBe("errors.generic");
    expect(unhandled).toEqual([]);
  });

  it("a switch the server accepted keeps the new type and shows no error", async () => {
    chooseType("grocery");
    patch.resolve({ ok: true, status: 200 });
    await settle();

    expect(setListType.mock.calls).toEqual([["grocery"]]);
    expect(errorToast()).toBeNull();
  });
});

describe("the list page", () => {
```

- [ ] **Step 2: run them, expect FAIL**

```bash
npx vitest run __tests__/unit/throw-if-not-ok.test.ts __tests__/unit/item-restore.test.ts __tests__/unit/list-background-saves.test.ts __tests__/unit/list-type-switch.test.ts
```

Expected failures:
- `throw-if-not-ok` and `item-restore` fail to load with `Cannot find module '@/src/utils/http'` / `'@/src/utils/item-restore'`.
- In `list-background-saves`, 10 tests fail. The clear and unmark tests keep the optimistic state (`expected [ 'a' ] to deeply equal [ 'a', 'b', 'c' ]`), and the network variants reject with `TypeError: Failed to fetch`. The undo tests keep failed items on screen. The z-index test fails with `expected 30 to be greater than 50`.
- In `list-type-switch`, the two revert tests fail with `expected [ [ 'grocery' ] ] to deeply equal [ [ 'grocery' ], [ 'regular' ] ]`.
- The control tests pass already: a successful clear, a successful unmark, a successful undo, and the accepted type switch.

- [ ] **Step 3: implementation**

`src/utils/http.ts` (complete file):

```ts
/** Throws "<verb> failed: <status>" for a non-2xx response, the format useMutationQueue parses. `verb` must not contain the words "fetch" or "network" (the queue's offline heuristic matches them). */
export function throwIfNotOk(res: Response, verb: string): void {
  if (!res.ok) throw new Error(`${verb} failed: ${res.status}`);
}
```

`src/utils/item-restore.ts` (complete file):

```ts
import { throwIfNotOk } from "@/src/utils/http";

/** One item PATCH body an Undo sends, e.g. { itemId, deleted_at: null } or { itemId, completed: true }. */
export type RestoreBody = { itemId: string } & Record<string, unknown>;

/**
 * Sends an Undo's item PATCHes in parallel and checks each response. Every failure is
 * logged with its list and item id. Never rejects: resolves with the ids that failed.
 */
export async function restoreItemsOnServer(
  listId: string,
  jwt: string | null,
  bodies: RestoreBody[]
): Promise<string[]> {
  const results = await Promise.allSettled(
    bodies.map((body) =>
      fetch(`/api/lists/${listId}/items`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }).then((res) => throwIfNotOk(res, "Restore"))
    )
  );

  const failed: string[] = [];
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      const { itemId } = bodies[i];
      console.error("[ItemRestore] Undo restore failed:", { listId, itemId }, result.reason);
      failed.push(itemId);
    }
  });
  return failed;
}
```

`src/hooks/useItemHandlers.ts`: apply each edit in order. Edit 2 adds `showSyncError`, `restoreOrRevert` and `removeAgain` at the top of the hook body. They must come before every handler that lists them in its deps. The `addMutation({...})` calls and their `execute` closures are unchanged.

**src/hooks/useItemHandlers.ts, edit 1 (today around line 8).** Current:

```ts
import { computeUnmarkCompleted } from "@/src/utils/unmark-completed";
import { computeClearCompleted } from "@/src/utils/clear-completed";
import { computeUnskipAll } from "@/src/utils/unskip-all";

interface UseItemHandlersParams {
  listId: string;
```

Replace with:

```ts
import { computeUnmarkCompleted } from "@/src/utils/unmark-completed";
import { computeClearCompleted } from "@/src/utils/clear-completed";
import { computeUnskipAll } from "@/src/utils/unskip-all";
import { throwIfNotOk } from "@/src/utils/http";
import { restoreItemsOnServer, type RestoreBody } from "@/src/utils/item-restore";

interface UseItemHandlersParams {
  listId: string;
```

**src/hooks/useItemHandlers.ts, edit 2 (today around line 40).** Current:

```ts
  setErrorToast,
  t,
}: UseItemHandlersParams) {
  const addSingleItem = useCallback(
    (text: string) => {
      const tempId = `temp-${Date.now()}-${Math.random()}`;
```

Replace with:

```ts
  setErrorToast,
  t,
}: UseItemHandlersParams) {
  // One toast for a background save that failed and was put back on screen.
  const showSyncError = useCallback(() => {
    setErrorToast(t("items.syncError"));
    setTimeout(() => setErrorToast(null), 3000);
  }, [setErrorToast, t]);

  // Sends an Undo's item PATCHes. `revert` puts the items whose restore failed back to
  // how they were before the Undo, so the screen matches the server.
  const restoreOrRevert = useCallback(
    (bodies: RestoreBody[], revert: (failed: Set<string>) => void) => {
      void restoreItemsOnServer(listId, jwtRef.current, bodies).then((failed) => {
        if (failed.length === 0) return;
        revert(new Set(failed));
        showSyncError();
      });
    },
    [listId, jwtRef, showSyncError]
  );

  // Revert for a restore of deleted items: they leave the screen again.
  const removeAgain = useCallback(
    (failed: Set<string>) => setItems((prev) => prev.filter((i) => !failed.has(i.id))),
    [setItems]
  );

  const addSingleItem = useCallback(
    (text: string) => {
      const tempId = `temp-${Date.now()}-${Math.random()}`;
```

**src/hooks/useItemHandlers.ts, edit 3 (today around line 229).** Current:

```ts
          setUndoAction(null);
          if (deletedItem) {
            setItems((prev) => [...prev, deletedItem]);
            // Restore on server
            const jwt = jwtRef.current;
            fetch(`/api/lists/${listId}/items`, {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${jwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                itemId,
                deleted_at: null,
              }),
            });
          }
        },
        timeout,
```

Replace with:

```ts
          setUndoAction(null);
          if (deletedItem) {
            setItems((prev) => [...prev, deletedItem]);
            // Restore on server; if that fails, the item leaves the screen again.
            restoreOrRevert([{ itemId, deleted_at: null }], removeAgain);
          }
        },
        timeout,
```

**src/hooks/useItemHandlers.ts, edit 4 (today around line 266).** Current:

```ts
        },
      });
    },
    [jwtRef, listId, items, addMutation, t, setItems, setUndoAction]
  );

  const handleEditItem = useCallback(
```

Replace with:

```ts
        },
      });
    },
    [jwtRef, listId, items, addMutation, t, setItems, setUndoAction, restoreOrRevert, removeAgain]
  );

  const handleEditItem = useCallback(
```

**src/hooks/useItemHandlers.ts, edit 5 (today around line 520).** Current:

```ts
          clearTimeout(timeout);
          setUndoAction(null);
          setItems((prev) => [...prev, ...duplicatesToRemove]);
          // Restore on server
          const currentJwt = jwtRef.current;
          for (const item of duplicatesToRemove) {
            fetch(`/api/lists/${listId}/items`, {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${currentJwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ itemId: item.id, deleted_at: null }),
            });
          }
        },
        timeout,
      });
```

Replace with:

```ts
          clearTimeout(timeout);
          setUndoAction(null);
          setItems((prev) => [...prev, ...duplicatesToRemove]);
          // Restore on server; duplicates whose restore fails leave the screen again.
          restoreOrRevert(
            duplicatesToRemove.map((item) => ({ itemId: item.id, deleted_at: null })),
            removeAgain
          );
        },
        timeout,
      });
```

**src/hooks/useItemHandlers.ts, edit 6 (today around line 558).** Current:

```ts
        });
      }
    },
    [jwtRef, listId, items, addMutation, t, setItems, setUndoAction]
  );

  const handleClearCompleted = useCallback(async () => {
```

Replace with:

```ts
        });
      }
    },
    [jwtRef, listId, items, addMutation, t, setItems, setUndoAction, restoreOrRevert, removeAgain]
  );

  const handleClearCompleted = useCallback(async () => {
```

**src/hooks/useItemHandlers.ts, edit 7 (today around line 579).** Current:

```ts
        clearTimeout(timeout);
        setUndoAction(null);
        setItems((prev) => [...prev, ...completedItems]);
        // Restore on server
        const currentJwt = jwtRef.current;
        for (const item of completedItems) {
          fetch(`/api/lists/${listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${currentJwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId: item.id, deleted_at: null }),
          });
        }
      },
      timeout,
    });

    await fetch(`/api/lists/${listId}/items/clear-completed`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
    });
  }, [jwtRef, listId, items, t, setItems, setUndoAction]);

  const handleUnmarkAllDone = useCallback(async () => {
    const jwt = jwtRef.current;
```

Replace with:

```ts
        clearTimeout(timeout);
        setUndoAction(null);
        setItems((prev) => [...prev, ...completedItems]);
        // Restore on server; items whose restore fails leave the screen again.
        restoreOrRevert(
          completedItems.map((item) => ({ itemId: item.id, deleted_at: null })),
          removeAgain
        );
      },
      timeout,
    });

    try {
      const res = await fetch(`/api/lists/${listId}/items/clear-completed`, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
      });
      throwIfNotOk(res, "Clear completed");
    } catch (err) {
      // Not in the offline queue: put the items back so the screen matches the server.
      console.error("[List] Clear completed failed:", { listId }, err);
      clearTimeout(timeout);
      setUndoAction((prev) => (prev?.timeout === timeout ? null : prev));
      // Skip items already back on screen (an Undo tapped before this failed).
      setItems((prev) => {
        const present = new Set(prev.map((i) => i.id));
        return [...prev, ...completedItems.filter((i) => !present.has(i.id))];
      });
      showSyncError();
    }
  }, [jwtRef, listId, items, t, setItems, setUndoAction, restoreOrRevert, removeAgain, showSyncError]);

  const handleUnmarkAllDone = useCallback(async () => {
    const jwt = jwtRef.current;
```

**src/hooks/useItemHandlers.ts, edit 8 (today around line 607).** Current:

```ts

    const { affectedIds } = computeUnmarkCompleted(items);
    if (affectedIds.length === 0) return;

    const tg = getTelegramWebApp();
    tg?.HapticFeedback?.impactOccurred("light");
```

Replace with:

```ts

    const { affectedIds } = computeUnmarkCompleted(items);
    if (affectedIds.length === 0) return;
    // Completion times before the flip, put back if the server refuses it.
    const completedAtById = new Map(
      items.filter((i) => affectedIds.includes(i.id)).map((i) => [i.id, i.completed_at] as const)
    );

    const tg = getTelegramWebApp();
    tg?.HapticFeedback?.impactOccurred("light");
```

**src/hooks/useItemHandlers.ts, edit 9 (today around line 629).** Current:

```ts
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

  const sendSignal = useCallback(
    async (endpoint: "remind" | "ready", successKey: string) => {
```

Replace with:

```ts
              : i
          )
        );
        // Restore on server; items whose restore fails are unchecked again.
        restoreOrRevert(
          affectedIds.map((id) => ({ itemId: id, completed: true })),
          (failed) =>
            setItems((prev) =>
              prev.map((i) => (failed.has(i.id) ? { ...i, completed: false, completed_at: null } : i))
            )
        );
      },
      timeout,
    });

    try {
      const res = await fetch(`/api/lists/${listId}/items/unmark-completed`, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
      });
      throwIfNotOk(res, "Unmark all");
    } catch (err) {
      // Not in the offline queue: re-check the items so the screen matches the server.
      console.error("[List] Unmark all failed:", { listId }, err);
      clearTimeout(timeout);
      setUndoAction((prev) => (prev?.timeout === timeout ? null : prev));
      setItems((prev) =>
        prev.map((i) =>
          completedAtById.has(i.id)
            ? { ...i, completed: true, completed_at: completedAtById.get(i.id) ?? null }
            : i
        )
      );
      showSyncError();
    }
  }, [jwtRef, listId, items, t, setItems, setUndoAction, restoreOrRevert, showSyncError]);

  const sendSignal = useCallback(
    async (endpoint: "remind" | "ready", successKey: string) => {
```

**app/list/[id]/page.tsx, edit 1 (today around line 26).** Current:

```tsx
import { normalizeForCompare } from "@/src/utils/text-normalize";
import { SORTING_GROUP, countByCategory } from "@/src/utils/list-helpers";
import { createExecutorFactory } from "@/src/utils/executor-factory";
import { DragDropProvider } from "@dnd-kit/react";

const executorFactory = createExecutorFactory();
```

Replace with:

```tsx
import { normalizeForCompare } from "@/src/utils/text-normalize";
import { SORTING_GROUP, countByCategory } from "@/src/utils/list-helpers";
import { createExecutorFactory } from "@/src/utils/executor-factory";
import { throwIfNotOk } from "@/src/utils/http";
import { DragDropProvider } from "@dnd-kit/react";

const executorFactory = createExecutorFactory();
```

**app/list/[id]/page.tsx, edit 2 (today around line 365).** Current:

```tsx
                <button
                  key={tp}
                  onClick={() => {
                    setListType(tp);
                    const jwt = jwtRef.current;
                    if (jwt) {
```

Replace with:

```tsx
                <button
                  key={tp}
                  onClick={() => {
                    const previousType = listType;
                    setListType(tp);
                    const jwt = jwtRef.current;
                    if (jwt) {
```

**app/list/[id]/page.tsx, edit 3 (today around line 373).** Current:

```tsx
                        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
                        body: JSON.stringify({ id: listId, type: tp }),
                      })
                        // Nothing loaded categories while the list was another type.
                        .then(() => (tp === "grocery" ? loadCategories() : undefined))
                        .catch((err) => {
                          console.error("[List] Failed to update list type, listId:", listId, "type:", tp, err);
                        });
                    }
                  }}
```

Replace with:

```tsx
                        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
                        body: JSON.stringify({ id: listId, type: tp }),
                      })
                        .then((res) => {
                          throwIfNotOk(res, "Type change");
                          // Nothing loaded categories while the list was another type.
                          return tp === "grocery" ? loadCategories() : undefined;
                        })
                        .catch((err) => {
                          console.error("[List] Failed to update list type, listId:", listId, "type:", tp, err);
                          setListType(previousType);
                          setErrorToast(t('errors.generic'));
                          setTimeout(() => setErrorToast(null), 3000);
                        });
                    }
                  }}
```

**components/list/ToastContainer.tsx, edit 1 (today around line 25).** Current:

```tsx

  return (
    <>
      {/* Error toast */}
      {errorToast && !undoAction && (
        <div className="fixed bottom-8 start-5 end-5 bg-tg-destructive text-white rounded-2xl py-3.5 px-5 z-30 shadow-xl shadow-black/10 dark:shadow-black/30 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <span className="text-sm">{errorToast}</span>
        </div>
      )}
```

Replace with:

```tsx

  return (
    <>
      {/* Error toast. Above the page's z-50 sheets: a failure can be raised from one. */}
      {errorToast && !undoAction && (
        <div className="fixed bottom-8 start-5 end-5 bg-tg-destructive text-white rounded-2xl py-3.5 px-5 z-[60] shadow-xl shadow-black/10 dark:shadow-black/30 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <span className="text-sm">{errorToast}</span>
        </div>
      )}
```

- [ ] **Step 4: update existing tests that the change makes stale**

- `__tests__/unit/list-type-switch.test.ts`: covered in Step 1. A rejected PATCH now reverts the type and raises `errors.generic`, so the old "fails quietly" test was replaced, not loosened. The two success tests already resolve `{ ok: true, status: 200 }` and need no change.
- `__tests__/unit/categories-sheet-wiring.test.ts`: change one comment line, because the error toast no longer draws at z-30. No assertion changes.

**__tests__/unit/categories-sheet-wiring.test.ts, edit 1 (today around line 29).** Current:

```ts
  });

  it("the sheet shows its own error, because it covers the page's toasts", () => {
    // ToastContainer draws at z-30, under the sheet's z-50 overlay, so a toast would go unseen.
    expect(sheet).toMatch(/runCategoryAction\(jwtRef\.current, action, \(\) => \{\s*undo\?\.\(\);\s*setError\(t\("categories\.error"\)\);\s*\}\)/);
    expect(sheet).toMatch(/\{error && \(\s*<p ref=\{errorRef\} role="alert"[^>]*>\{error\}<\/p>\s*\)\}/);
  });
```

Replace with:

```ts
  });

  it("the sheet shows its own error, because it covers the page's toasts", () => {
    // ToastContainer's undo and info toasts draw at z-30, under the sheet's z-50 overlay, so they would go unseen.
    expect(sheet).toMatch(/runCategoryAction\(jwtRef\.current, action, \(\) => \{\s*undo\?\.\(\);\s*setError\(t\("categories\.error"\)\);\s*\}\)/);
    expect(sheet).toMatch(/\{error && \(\s*<p ref=\{errorRef\} role="alert"[^>]*>\{error\}<\/p>\s*\)\}/);
  });
```

- [ ] **Step 5: run tests, expect PASS**

```bash
npx vitest run __tests__/unit/throw-if-not-ok.test.ts __tests__/unit/item-restore.test.ts __tests__/unit/list-background-saves.test.ts __tests__/unit/list-type-switch.test.ts __tests__/unit/categories-sheet-wiring.test.ts __tests__/unit/mutation-request-parity.test.ts __tests__/unit/executor-factory.test.ts __tests__/unit/no-silent-catches.test.ts __tests__/unit/restore-skipped-flow.test.ts __tests__/unit/grouped-list-wiring.test.ts
npx tsc --noEmit
npx eslint src/utils/http.ts src/utils/item-restore.ts src/hooks/useItemHandlers.ts "app/list/[id]/page.tsx" components/list/ToastContainer.tsx __tests__/unit/throw-if-not-ok.test.ts __tests__/unit/item-restore.test.ts __tests__/unit/list-background-saves.test.ts __tests__/unit/list-type-switch.test.ts __tests__/unit/categories-sheet-wiring.test.ts
```

Expected: 10 files and 92 tests pass. `tsc` exits 0, and eslint reports 0 problems. This was verified on a copy of the tree at f441470.

- [ ] **Step 6: make it bite**

For each line below: remove or change it, run the named test file, see the named tests go red, then restore it. All 12 were verified red.

| change | test file | goes red |
|---|---|---|
| `src/utils/http.ts`: delete the `if (!res.ok) throw …` line | throw-if-not-ok | "throws '<verb> failed: <status>'…", "ends with the status the offline queue parses" |
| `src/utils/item-restore.ts`: delete `.then((res) => throwIfNotOk(res, "Restore"))` | item-restore | "returns exactly the ids whose restore was refused or not sent…" |
| `useItemHandlers.ts`: delete `throwIfNotOk(res, "Clear completed");` | list-background-saves | "a server error puts the cleared items back…", "a clear that fails after Undo…" |
| `useItemHandlers.ts`: replace the merge `return [...prev, ...completedItems.filter((i) => !present.has(i.id))];` with `return [...prev, ...completedItems];` | list-background-saves | "a clear that fails after Undo was tapped shows each item once" |
| `useItemHandlers.ts`: delete the `setUndoAction((prev) => (prev?.timeout === timeout ? null : prev));` in the clear catch | list-background-saves | "a server error puts the cleared items back…" |
| `useItemHandlers.ts`: delete `throwIfNotOk(res, "Unmark all");` | list-background-saves | "a server error re-checks the items…" |
| `useItemHandlers.ts`: replace `completed_at: completedAtById.get(i.id) ?? null` with `completed_at: new Date().toISOString()` | list-background-saves | both unmark failure tests |
| `useItemHandlers.ts`: delete `revert(new Set(failed));` in `restoreOrRevert` | list-background-saves | all four "Undo …" failure tests |
| `app/list/[id]/page.tsx`: delete `throwIfNotOk(res, "Type change");` | list-type-switch | "a switch the server refused…" |
| `app/list/[id]/page.tsx`: delete `setListType(previousType);` | list-type-switch | both revert tests |
| `app/list/[id]/page.tsx`: delete `setErrorToast(t('errors.generic'));` | list-type-switch | both revert tests |
| `ToastContainer.tsx`: `z-[60]` back to `z-30` on the error toast | list-background-saves | "draws above the page's sheets…" |

- [ ] **Step 7: commit**

```bash
git add src/utils/http.ts src/utils/item-restore.ts src/hooks/useItemHandlers.ts "app/list/[id]/page.tsx" components/list/ToastContainer.tsx __tests__/unit/throw-if-not-ok.test.ts __tests__/unit/item-restore.test.ts __tests__/unit/list-background-saves.test.ts __tests__/unit/list-type-switch.test.ts __tests__/unit/categories-sheet-wiring.test.ts
git commit -F - <<'EOF'
fix(list): undo, clear and unmark show the server's truth when a save fails

Undo restores on the list page go through restoreItemsOnServer, which
checks every PATCH. Items whose restore failed are put back the way they
were, and one "Failed to sync change" toast shows. Clear completed and
unmark all check the response: on failure the items come back with their
original completion time. The list type switch reverts on a refused save.
The error toast now draws above the settings sheet.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
```

---

### Task 7b: Client background saves, home page, language and share dialog

**Files:**
- Modify: `app/page.tsx`, `src/hooks/useLocaleSync.ts`, `components/TelegramProvider.tsx` (the `setLanguage` type only), `components/ShareDialog.tsx`, `messages/en.json`, `messages/he.json`, `messages/ru.json`
- Test (create): `__tests__/unit/home-background-saves.test.ts`, `__tests__/unit/share-dialog-errors.test.ts`, `__tests__/unit/locale-sync.test.ts`

Task 8 edits `app/page.tsx` (the `fetchLists` log lines) and `components/TelegramProvider.tsx` (user fetch, `removeAllChannels`) after this task. 7b does not touch those lines.

**Interfaces:**
- Consumes `throwIfNotOk(res: Response, verb: string): void` from Task 7a (`@/src/utils/http`).
- Produces:
  - `setLanguage: (lang: SupportedLocale) => Promise<boolean>` on the `useTelegram()` context and from `useLocaleSync`. It resolves `false` when nothing was saved: a non-2xx response, a network error, or no session token. The language stays applied either way.
  - The new i18n key `lists.deleteFailed`.
  - Verbs used: `Delete`, `Restore`, `Undo archive`, `Edit`, `Create list`, `Language save`, `Share load`, `Link create`.

**Sites:**

| site (file:line today) | today on failure | change | user-visible result |
|---|---|---|---|
| app/page.tsx:390 (DELETE list) | Floating fetch, never checked. The list reappears on the next refresh. | `.then((res) => throwIfNotOk(res, "Delete")).catch(...)`: log, clear the undo timer, show the `lists.deleteFailed` toast, then, if still on the same tab, `putBack()` (guarded by `some()`) and a silent `fetchLists` | The card returns to its slot, and "Couldn't delete the list" shows. After Undo it appears only once. |
| app/page.tsx:377 (undo-delete restore PATCH) | Floating fetch | `.then(throwIfNotOk "Restore").catch(...)`: log, `errors.generic` toast, and a silent `fetchLists` if still on the same tab | "Something went wrong. Please try again." shows, and the list shows what the server holds. |
| app/page.tsx:215 (undo archive) | `void post(...)` | `.then(throwIfNotOk "Undo archive").catch(...)` with the same handling | Same as above. |
| app/page.tsx:310 (edit sheet PATCH) | No else branch, and no feedback | `throwIfNotOk(res, "Edit")` in the try. The catch logs `{ listId }` and shows `errors.generic` | The sheet stays open with the user's input, and the toast shows above the sheet. |
| app/page.tsx:285 (create list `alert()`) | Native English alert, and an unguarded `res.json()` on the error body | `throwIfNotOk(res, "Create list")`. The catch logs and shows `errors.generic`, and the error body is no longer read | The generic toast shows above the sheet, and the sheet keeps the name. |
| app/page.tsx:631 (language caller) | Closes the sheet whatever happened | `const saved = await setLanguage(lang)`. If it is false, show `errors.generic` | The language stays chosen, and the toast says it was not saved (product call 6A). |
| app/page.tsx:640 (home toast `z-30`) | Draws under the z-50 edit and create sheets | `z-[60]` | The new feedback is visible over the sheets. |
| src/hooks/useLocaleSync.ts:26 | `res.ok` is never read, and there is no token check | returns `Promise<boolean>`, warns when there is no token, `throwIfNotOk(res, "Language save")`, logs `{ lang }` | Feeds the caller above. |
| components/TelegramProvider.tsx:56,77 | type is `Promise<void>` | type becomes `Promise<boolean>`, and the context default is `async () => false` | none |
| components/ShareDialog.tsx:42 (load) | Non-ok is silent, which reads as "nobody has access" | `throwIfNotOk(res, "Share load")`, log `{ listId }`, `setError(true)`. It is cleared at the start of each load | `errors.generic` shows inline in red, inside the dialog. |
| components/ShareDialog.tsx:68 (generate link) | Non-ok is silent | `throwIfNotOk(res, "Link create")`, log, `setError(true)`. It is cleared at the start of each attempt | Same inline line, and the button can be tapped again. |
| messages/{en,he,ru}.json | none | add `lists.deleteFailed` | en "Couldn't delete the list", he "לא הצלחנו למחוק את הרשימה", ru "Не удалось удалить список" |

**Same-class sweep of these files:** the `fetchLists` non-ok and the TelegramProvider user fetches and `removeAllChannels` belong to Task 8 (group 9). The ShareDialog clipboard catch already logs. Nothing else was found.

- [ ] **Step 1: write the failing tests**

Create these three files exactly as given.

`__tests__/unit/home-background-saves.test.ts` (complete file):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";

// Calls the real home page component as a plain function with slot-based stand-ins for
// React's hooks: state and refs persist across renders, callbacks and effects follow their
// deps, and effects run after the render that queued them, as in React. Buttons are pressed
// by calling their handlers from the returned element tree. Nothing renders to a DOM.
type Slot = { value?: unknown; current?: unknown; deps?: unknown[]; cleanup?: void | (() => void) };
const R = vi.hoisted(() => ({ slots: [] as Slot[], i: 0, effects: [] as (() => void)[] }));
vi.mock("react", async (importOriginal) => {
  const same = (a?: unknown[], b?: unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
  return {
    ...(await importOriginal<typeof import("react")>()),
    useState: (init: unknown) => {
      const i = R.i++;
      if (!R.slots[i]) R.slots[i] = { value: typeof init === "function" ? (init as () => unknown)() : init };
      const slot = R.slots[i];
      const set = (u: unknown) => {
        slot.value = typeof u === "function" ? (u as (p: unknown) => unknown)(slot.value) : u;
      };
      return [slot.value, set];
    },
    useRef: (v: unknown) => {
      const i = R.i++;
      if (!R.slots[i]) R.slots[i] = { current: v };
      return R.slots[i];
    },
    useCallback: (fn: unknown, deps: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && same(s.deps, deps)) return s.value;
      R.slots[i] = { value: fn, deps };
      return fn;
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && deps && same(s.deps, deps)) return;
      R.slots[i] = { deps };
      R.effects.push(() => {
        if (typeof s?.cleanup === "function") s.cleanup();
        R.slots[i].cleanup = fn();
      });
    },
  };
});

// Stable across renders, like the real hooks' return values.
const H = vi.hoisted(() => ({
  t: (key: string) => key,
  router: { push: () => {} },
  jwtRef: { current: "jwt" as string | null },
  onRefreshNeededRef: { current: null as unknown },
  setLanguage: (async () => true) as (lang: string) => Promise<boolean>,
}));
vi.mock("next-intl", () => ({ useTranslations: () => H.t }));
vi.mock("next/navigation", () => ({ useRouter: () => H.router }));
vi.mock("@/components/TelegramProvider", () => ({
  default: ({ children }: { children: unknown }) => children,
  useTelegram: () => ({
    isReady: true,
    locale: "en",
    setLanguage: H.setLanguage,
    jwtRef: H.jwtRef,
    onRefreshNeededRef: H.onRefreshNeededRef,
    homeScreenStatus: null,
    addToHomeScreen: () => {},
  }),
}));
vi.mock("@/src/hooks/useListsDragDrop", () => ({
  useListsDragDrop: () => ({ handleDragStart: () => {}, handleDragEnd: () => {}, shouldSuppressClick: () => false }),
}));
vi.mock("@dnd-kit/react", () => ({ DragDropProvider: () => null }));
vi.mock("@/components/ListCard", () => ({ default: () => null }));
vi.mock("@/components/SortableListCard", () => ({ default: () => null }));
vi.mock("@/components/EmptyState", () => ({ default: () => null }));
vi.mock("@/components/OfflineIndicator", () => ({ default: () => null }));
vi.mock("@/components/IconColorPicker", () => ({ default: () => null }));

import HomePage from "@/app/page";
import SortableListCard from "@/components/SortableListCard";
import { Globe } from "lucide-react";

type El = ReactElement<Record<string, unknown> & { children?: unknown }>;

// The page's own component: HomePage wraps it in the (stubbed) TelegramProvider.
const HomeContent = ((HomePage() as El).props.children as El).type as () => El;

const render = () => {
  R.i = 0;
  R.effects = [];
  const tree = HomeContent();
  for (const run of R.effects) run();
  return tree;
};

function find(node: unknown, match: (el: El) => boolean): El | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, match);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const el = node as El;
  return match(el) ? el : find(el.props.children, match);
}

function findAll(node: unknown, match: (el: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, out);
    return out;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return out;
  const el = node as El;
  if (match(el)) out.push(el);
  return findAll(el.props.children, match, out);
}

const listIds = () => findAll(render(), (el) => el.type === SortableListCard).map((el) => el.props.id);
const card = (id: string) => find(render(), (el) => el.type === SortableListCard && el.props.id === id)!;
const press = (el: El, handler: string, ...args: unknown[]) => (el.props[handler] as (...a: unknown[]) => unknown)(...args);
// A sheet defined in app/page.tsx, found by its component name.
const sheet = (name: string) =>
  find(render(), (el) => typeof el.type === "function" && (el.type as { name: string }).name === name);
const toastBox = () => find(render(), (el) => el.type === "div" && String(el.props.className).startsWith("fixed bottom-8 start-5"));
// The bottom toast: its message, and whether it offers Undo.
const toast = () => {
  const box = toastBox();
  if (!box) return null;
  const undo = find(box, (el) => el.type === "button");
  return {
    message: find(box, (el) => el.type === "span")!.props.children,
    undo: undo ? (undo.props.onClick as () => void) : undefined,
  };
};
const zOf = (className: unknown) => Number(/\bz-\[?(\d+)\]?/.exec(String(className))![1]);

// Let queued promise chains run without moving the clock.
const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
};

type Reply = number | "neterr" | "hold";
const LIST = (id: string) => ({
  id, name: id, type: "regular", icon: null, color: null,
  active_count: 0, completed_count: 0, is_shared: false, role: "owner",
});

// The fake server. Keys are "<METHOD> <url>"; a reply is a status, a network failure, or
// held until released. GET /api/lists answers with server.lists as it is at reply time.
let server: { lists: ReturnType<typeof LIST>[] };
let replies: Map<string, Reply[]>;
let held: Map<string, (status: number) => void>;
let calls: string[];
let alertMock: ReturnType<typeof vi.fn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  R.slots = [];
  R.i = 0;
  vi.useFakeTimers();
  server = { lists: ["A", "B", "C"].map(LIST) };
  replies = new Map();
  held = new Map();
  calls = [];
  const storage = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  };
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("sessionStorage", storage());
  alertMock = vi.fn();
  // No Telegram WebApp: the delete confirm falls back to window.confirm, answered yes.
  vi.stubGlobal("window", { confirm: () => true, alert: alertMock });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push(key);
    const reply = replies.get(key)?.shift() ?? 200;
    if (reply === "neterr") throw new TypeError("Failed to fetch");
    const status = reply === "hold" ? await new Promise<number>((resolve) => held.set(key, resolve)) : reply;
    const body = key === "GET /api/lists" ? server.lists.map((l) => ({ ...l })) : { id: "new-list" };
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }));
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  H.setLanguage = async () => true;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// First load of the home screen with lists A, B, C.
async function boot() {
  render();
  await settle();
  expect(listIds()).toEqual(["A", "B", "C"]);
}

describe("Home: delete a list", () => {
  it("a delete the server refused puts the card back where it was and says so", async () => {
    await boot();
    replies.set("DELETE /api/lists?id=B", [500]);
    replies.set("GET /api/lists", ["hold"]); // the quiet resync stays in flight: what's on screen is the page's own repair

    press(card("B"), "onDelete");
    expect(listIds()).toEqual(["A", "C"]);
    expect(toast()?.message).toBe("lists.deleted");
    await settle();

    expect(listIds()).toEqual(["A", "B", "C"]);
    expect(toast()).toEqual({ message: "lists.deleteFailed", undo: undefined });
    expect(errorSpy).toHaveBeenCalledWith(
      "[Home] Delete list failed:",
      { listId: "B" },
      expect.objectContaining({ message: "Delete failed: 500" })
    );
    expect(calls.filter((c) => c === "GET /api/lists")).toHaveLength(2); // the first load, then the resync
  });

  it("a delete that could not be sent does the same", async () => {
    await boot();
    replies.set("DELETE /api/lists?id=B", ["neterr"]);
    replies.set("GET /api/lists", ["hold"]);

    press(card("B"), "onDelete");
    await settle();

    expect(listIds()).toEqual(["A", "B", "C"]);
    expect(toast()).toEqual({ message: "lists.deleteFailed", undo: undefined });
    expect(errorSpy).toHaveBeenCalledWith("[Home] Delete list failed:", { listId: "B" }, expect.any(TypeError));
  });

  it("a delete that fails after Undo was tapped shows the card once", async () => {
    await boot();
    replies.set("DELETE /api/lists?id=B", ["hold"]);
    replies.set("GET /api/lists", ["hold"]);

    press(card("B"), "onDelete");
    toast()!.undo!();
    expect(listIds()).toEqual(["A", "B", "C"]);
    await settle();
    held.get("DELETE /api/lists?id=B")!(500);
    await settle();

    expect(listIds()).toEqual(["A", "B", "C"]);
    expect(toast()?.message).toBe("lists.deleteFailed");
  });

  it("a failed Undo says so and shows what the server has", async () => {
    await boot();
    press(card("B"), "onDelete");
    await settle();
    server.lists = ["A", "C"].map(LIST); // B is deleted on the server
    replies.set("PATCH /api/lists", [500]);

    toast()!.undo!();
    expect(listIds()).toEqual(["A", "B", "C"]);
    await settle();

    expect(listIds()).toEqual(["A", "C"]);
    expect(toast()).toEqual({ message: "errors.generic", undo: undefined });
    expect(errorSpy).toHaveBeenCalledWith(
      "[Home] Undo delete failed:",
      { listId: "B" },
      expect.objectContaining({ message: "Restore failed: 500" })
    );
  });
});

describe("Home: Undo of an archive", () => {
  it("a failed Undo says so and shows what the server has", async () => {
    await boot();
    press(card("B"), "onArchive");
    await settle();
    server.lists = ["A", "C"].map(LIST); // B is archived on the server
    replies.set("POST /api/lists/archive", [500]);

    toast()!.undo!();
    expect(listIds()).toEqual(["A", "B", "C"]);
    await settle();

    expect(listIds()).toEqual(["A", "C"]);
    expect(toast()).toEqual({ message: "errors.generic", undo: undefined });
    expect(errorSpy).toHaveBeenCalledWith(
      "[Home] Undo archive failed:",
      { listId: "B" },
      expect.objectContaining({ message: "Undo archive failed: 500" })
    );
  });
});

describe("Home: edit sheet", () => {
  it("a save the server refused keeps the sheet open with the user's input and says so, above the sheet", async () => {
    await boot();
    press(card("B"), "onEdit");
    press(sheet("EditListSheet")!, "onNameChange", "Renamed");
    replies.set("PATCH /api/lists", [500]);

    press(sheet("EditListSheet")!, "onSubmit");
    await settle();

    const open = sheet("EditListSheet");
    expect(open?.props.name).toBe("Renamed");
    expect(card("B").props.name).toBe("B");
    expect(toast()).toEqual({ message: "errors.generic", undo: undefined });
    expect(errorSpy).toHaveBeenCalledWith(
      "[Home] Edit list failed:",
      { listId: "B" },
      expect.objectContaining({ message: "Edit failed: 500" })
    );
    const sheetRoot = (open!.type as (p: unknown) => El)(open!.props);
    expect(zOf(toastBox()!.props.className)).toBeGreaterThan(zOf(sheetRoot.props.className));
  });

  it("a save that could not be sent keeps the sheet open and says so", async () => {
    await boot();
    press(card("B"), "onEdit");
    replies.set("PATCH /api/lists", ["neterr"]);

    press(sheet("EditListSheet")!, "onSubmit");
    await settle();

    expect(sheet("EditListSheet")).toBeDefined();
    expect(toast()).toEqual({ message: "errors.generic", undo: undefined });
  });

  it("a save the server accepted renames the card and closes the sheet", async () => {
    await boot();
    press(card("B"), "onEdit");
    press(sheet("EditListSheet")!, "onNameChange", "Renamed");

    press(sheet("EditListSheet")!, "onSubmit");
    await settle();

    expect(sheet("EditListSheet")).toBeUndefined();
    expect(card("B").props.name).toBe("Renamed");
    expect(toast()).toBeNull();
  });
});

describe("Home: create a list", () => {
  const openCreate = () => {
    const fab = find(render(), (el) => el.type === "button" && String(el.props.className).includes("fixed bottom-8 end-6"))!;
    press(fab, "onClick");
    press(sheet("CreateListSheet")!, "onChange", "Milk");
  };

  it("a create the server refused shows the generic error toast instead of an English alert", async () => {
    await boot();
    openCreate();
    replies.set("POST /api/lists", [400]);

    press(sheet("CreateListSheet")!, "onSubmit");
    await settle();

    expect(alertMock).not.toHaveBeenCalled();
    expect(sheet("CreateListSheet")?.props.value).toBe("Milk");
    expect(toast()).toEqual({ message: "errors.generic", undo: undefined });
    expect(errorSpy).toHaveBeenCalledWith(
      "[Home] Create list failed:",
      expect.objectContaining({ message: "Create list failed: 400" })
    );
  });

  it("a create that could not be sent says so too", async () => {
    await boot();
    openCreate();
    replies.set("POST /api/lists", ["neterr"]);

    press(sheet("CreateListSheet")!, "onSubmit");
    await settle();

    expect(toast()).toEqual({ message: "errors.generic", undo: undefined });
  });
});

describe("Home: language", () => {
  const chooseHebrew = async () => {
    const globe = find(render(), (el) => el.type === "button" && find(el.props.children, (c) => c.type === Globe) !== undefined)!;
    press(globe, "onClick");
    await press(sheet("LanguageSheet")!, "onSelect", "he");
  };

  it("a language that could not be saved stays chosen, and the page says so", async () => {
    const setLanguage = vi.fn(async () => false);
    H.setLanguage = setLanguage;
    await boot();

    await chooseHebrew();

    expect(setLanguage.mock.calls).toEqual([["he"]]);
    expect(sheet("LanguageSheet")).toBeUndefined();
    expect(toast()).toEqual({ message: "errors.generic", undo: undefined });
  });

  it("a saved language shows no error", async () => {
    await boot();

    await chooseHebrew();

    expect(sheet("LanguageSheet")).toBeUndefined();
    expect(toast()).toBeNull();
  });
});
```

`__tests__/unit/share-dialog-errors.test.ts` (complete file):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";

// Calls the real ShareDialog as a plain function with slot-based stand-ins for React's
// hooks: state persists across renders, callbacks and effects follow their deps, and
// effects run after the render that queued them. Nothing renders to a DOM.
type Slot = { value?: unknown; deps?: unknown[] };
const R = vi.hoisted(() => ({ slots: [] as Slot[], i: 0, effects: [] as (() => void)[] }));
vi.mock("react", async (importOriginal) => {
  const same = (a?: unknown[], b?: unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
  return {
    ...(await importOriginal<typeof import("react")>()),
    useState: (init: unknown) => {
      const i = R.i++;
      if (!R.slots[i]) R.slots[i] = { value: typeof init === "function" ? (init as () => unknown)() : init };
      const slot = R.slots[i];
      const set = (u: unknown) => {
        slot.value = typeof u === "function" ? (u as (p: unknown) => unknown)(slot.value) : u;
      };
      return [slot.value, set];
    },
    useCallback: (fn: unknown, deps: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && same(s.deps, deps)) return s.value;
      R.slots[i] = { value: fn, deps };
      return fn;
    },
    useEffect: (fn: () => void, deps?: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && deps && same(s.deps, deps)) return;
      R.slots[i] = { deps };
      R.effects.push(fn);
    },
  };
});

const H = vi.hoisted(() => ({ jwtRef: { current: "jwt" as string | null } }));
vi.mock("next-intl", () => ({
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
}));
vi.mock("@/components/TelegramProvider", () => ({ useTelegram: () => ({ jwtRef: H.jwtRef }) }));

import ShareDialog from "@/components/ShareDialog";

type El = ReactElement<Record<string, unknown> & { children?: unknown }>;

const render = () => {
  R.i = 0;
  R.effects = [];
  const tree = ShareDialog({ listId: "L", listName: "Groceries", isOpen: true, onClose: () => {} }) as El;
  for (const run of R.effects) run();
  return tree;
};

function find(node: unknown, match: (el: El) => boolean): El | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, match);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const el = node as El;
  return match(el) ? el : find(el.props.children, match);
}

const text = (node: unknown): string =>
  Array.isArray(node)
    ? node.map(text).join("")
    : typeof node === "string"
      ? node
      : node && typeof node === "object" && "props" in node
        ? text((node as El).props.children)
        : "";

const alertText = () => {
  const el = find(render(), (e) => e.props.role === "alert");
  return el ? text(el.props.children) : null;
};
const generateButton = () =>
  find(render(), (el) => el.type === "button" && text(el.props.children).includes("share.generateLink"));

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

type Reply = number | "neterr";
const LINK = "https://t.me/bot/app?startapp=invite";
let replies: Map<string, Reply[]>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  R.slots = [];
  R.i = 0;
  replies = new Map();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const reply = replies.get(key)?.shift() ?? 200;
    if (reply === "neterr") throw new TypeError("Failed to fetch");
    const body = key === "POST /api/share" ? { link: LINK } : { collaborators: [], activeLink: null };
    return { ok: reply >= 200 && reply < 300, status: reply, json: async () => body };
  }));
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ShareDialog failures", () => {
  it("a collaborator load the server refused shows the generic error inline", async () => {
    replies.set("GET /api/share?listId=L", [500]);
    render();
    await settle();

    expect(alertText()).toBe("errors.generic");
    expect(errorSpy).toHaveBeenCalledWith(
      "[ShareDialog] Failed to load:",
      { listId: "L" },
      expect.objectContaining({ message: "Share load failed: 500" })
    );
  });

  it("a collaborator load that could not be sent shows it too", async () => {
    replies.set("GET /api/share?listId=L", ["neterr"]);
    render();
    await settle();

    expect(alertText()).toBe("errors.generic");
    expect(errorSpy).toHaveBeenCalledWith("[ShareDialog] Failed to load:", { listId: "L" }, expect.any(TypeError));
  });

  it("a load that worked shows no error", async () => {
    render();
    await settle();

    expect(alertText()).toBeNull();
  });

  it("a link the server refused to create shows the generic error and lets the owner try again", async () => {
    render();
    await settle();
    replies.set("POST /api/share", [500]);

    await (generateButton()!.props.onClick as () => Promise<void>)();

    expect(alertText()).toBe("errors.generic");
    expect(generateButton()?.props.disabled).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      "[ShareDialog] Failed to generate link:",
      { listId: "L" },
      expect.objectContaining({ message: "Link create failed: 500" })
    );
  });

  it("a retry that works clears the error and shows the link", async () => {
    replies.set("GET /api/share?listId=L", [500]);
    render();
    await settle();
    expect(alertText()).toBe("errors.generic");

    await (generateButton()!.props.onClick as () => Promise<void>)();

    expect(alertText()).toBeNull();
    expect(text(render())).toContain(LINK);
  });
});
```

`__tests__/unit/locale-sync.test.ts` (complete file):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// useLocaleSync only uses useState and useCallback; React's own throw outside a render.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (init: unknown) => [init, () => {}],
  useCallback: (fn: unknown) => fn,
}));
// src/lib/i18n.ts pulls in next-intl/server, which does not load in node.
vi.mock("@/src/lib/i18n", () => ({ isRtl: (lang: string) => lang === "he" }));

import { useLocaleSync } from "@/src/hooks/useLocaleSync";

const reply = (status: number) => ({ ok: status >= 200 && status < 300, status, json: async () => ({}) });

let html: { dir?: string; lang?: string };
let fetchMock: ReturnType<typeof vi.fn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  html = {};
  vi.stubGlobal("document", { documentElement: html });
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("setLanguage", () => {
  it("resolves true once the server saved the language", async () => {
    fetchMock.mockResolvedValue(reply(200));
    const { setLanguage } = useLocaleSync({ current: "jwt" });

    await expect(setLanguage("he")).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith("/api/user", {
      method: "PATCH",
      headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" },
      body: JSON.stringify({ language: "he" }),
    });
    expect(html).toEqual({ dir: "rtl", lang: "he" });
  });

  it("resolves false and logs when the server refused, keeping the language on screen", async () => {
    fetchMock.mockResolvedValue(reply(500));
    const { setLanguage } = useLocaleSync({ current: "jwt" });

    await expect(setLanguage("he")).resolves.toBe(false);

    expect(html).toEqual({ dir: "rtl", lang: "he" });
    expect(errorSpy).toHaveBeenCalledWith(
      "[LocaleSync] Language save failed:",
      { lang: "he" },
      expect.objectContaining({ message: "Language save failed: 500" })
    );
  });

  it("resolves false and logs when the request could not be sent", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const { setLanguage } = useLocaleSync({ current: "jwt" });

    await expect(setLanguage("ru")).resolves.toBe(false);

    expect(errorSpy).toHaveBeenCalledWith("[LocaleSync] Language save failed:", { lang: "ru" }, expect.any(TypeError));
  });

  it("resolves false with a warning, and sends nothing, without a session", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { setLanguage } = useLocaleSync({ current: null });

    await expect(setLanguage("he")).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("[LocaleSync] No session token, language not saved:", { lang: "he" });
    expect(html).toEqual({ dir: "rtl", lang: "he" });
  });
});
```

- [ ] **Step 2: run them, expect FAIL**

```bash
npx vitest run __tests__/unit/home-background-saves.test.ts __tests__/unit/share-dialog-errors.test.ts __tests__/unit/locale-sync.test.ts
```

Expected: 18 failures and 3 passes. The 3 that pass are the controls: an accepted edit, a saved language, and a load that worked.
- **Home delete:** fails with `expected [ 'A', 'C' ] to deeply equal [ 'A', 'B', 'C' ]`.
- **Home Undo:** the failed restores keep `B` on screen.
- **Edit, create and language:** fail with `expected null to deeply equal { message: 'errors.generic', … }`.
- **setLanguage:** fails with `expected undefined to be true/false`.
- **ShareDialog:** fails with `expected null to be 'errors.generic'`.

- [ ] **Step 3: implementation**

`app/page.tsx`: apply each edit in order. Edit 2 adds `showToast` just above `handleReorderFailed`, so it exists before `handleSetArchived`, `handleEditSubmit`, `handleDeleteList` and the language sheet use it. `handleReorderFailed` and the archive failure handler keep their own inline toast code: same shape, no edit.

**app/page.tsx, edit 1 (today around line 13).** Current:

```tsx
import OfflineIndicator from "@/components/OfflineIndicator";
import IconColorPicker from "@/components/IconColorPicker";
import { getTelegramWebApp } from "@/src/types/telegram";
import type { SupportedLocale } from "@/src/lib/i18n";
import type { ListColor, ListIconName, ListType } from "@/src/lib/list-icons";

```

Replace with:

```tsx
import OfflineIndicator from "@/components/OfflineIndicator";
import IconColorPicker from "@/components/IconColorPicker";
import { getTelegramWebApp } from "@/src/types/telegram";
import { throwIfNotOk } from "@/src/utils/http";
import type { SupportedLocale } from "@/src/lib/i18n";
import type { ListColor, ListIconName, ListType } from "@/src/lib/list-icons";

```

**app/page.tsx, edit 2 (today around line 155).** Current:

```tsx
    if (isReady) fetchLists();
  }, [isReady, fetchLists]);

  const handleReorderFailed = useCallback(() => {
    setToast((prev) => {
      if (prev) clearTimeout(prev.timeout);
```

Replace with:

```tsx
    if (isReady) fetchLists();
  }, [isReady, fetchLists]);

  // A message-only bottom toast for a failed background save; replaces any toast showing.
  const showToast = useCallback((key: string) => {
    setToast((prev) => {
      if (prev) clearTimeout(prev.timeout);
      return {
        message: t(key),
        timeout: setTimeout(() => setToast(null), 4000),
      };
    });
  }, [t]);

  const handleReorderFailed = useCallback(() => {
    setToast((prev) => {
      if (prev) clearTimeout(prev.timeout);
```

**app/page.tsx, edit 3 (today around line 212).** Current:

```tsx
                return next;
              });
            }
            void post(!archived, jwtRef.current);
          },
          timeout,
        };
```

Replace with:

```tsx
                return next;
              });
            }
            post(!archived, jwtRef.current)
              .then((res) => throwIfNotOk(res, "Undo archive"))
              .catch((e) => {
                console.error("[Home] Undo archive failed:", { listId: list.id }, e);
                showToast("errors.generic");
                // silent: show the server's state without the full-page error view
                if (stillSameView()) fetchLists({ silent: true });
              });
          },
          timeout,
        };
```

**app/page.tsx, edit 4 (today around line 238).** Current:

```tsx
          fetchLists({ silent: true });
        });
    },
    [lists, view, jwtRef, t, fetchLists]
  );

  const { handleDragStart, handleDragEnd, shouldSuppressClick } = useListsDragDrop({
```

Replace with:

```tsx
          fetchLists({ silent: true });
        });
    },
    [lists, view, jwtRef, t, fetchLists, showToast]
  );

  const { handleDragStart, handleDragEnd, shouldSuppressClick } = useListsDragDrop({
```

**app/page.tsx, edit 5 (today around line 274).** Current:

```tsx
          color: newListColor,
        }),
      });
      if (res.ok) {
        const list = await res.json();
        setNewListName("");
        setNewListType("regular");
        setNewListIcon(null);
        setNewListColor(null);
        setShowCreate(false);
        router.push(`/list/${list.id}`);
      } else {
        const err = await res.json();
        alert(err.error || "Failed to create list");
      }
    } catch (e) {
      console.error("[Home] Create list error:", e);
    } finally {
      setCreating(false);
    }
```

Replace with:

```tsx
          color: newListColor,
        }),
      });
      throwIfNotOk(res, "Create list");
      const list = await res.json();
      setNewListName("");
      setNewListType("regular");
      setNewListIcon(null);
      setNewListColor(null);
      setShowCreate(false);
      router.push(`/list/${list.id}`);
    } catch (e) {
      // The sheet stays open with the user's input, so Create can be tapped again.
      console.error("[Home] Create list failed:", e);
      showToast("errors.generic");
    } finally {
      setCreating(false);
    }
```

**app/page.tsx, edit 6 (today around line 305).** Current:

```tsx
  const handleEditSubmit = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!editName.trim() || !jwt || !editTargetRef.current) return;
    setEditSaving(true);
    try {
      const res = await fetch("/api/lists", {
```

Replace with:

```tsx
  const handleEditSubmit = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!editName.trim() || !jwt || !editTargetRef.current) return;
    const listId = editTargetRef.current;
    setEditSaving(true);
    try {
      const res = await fetch("/api/lists", {
```

**app/page.tsx, edit 7 (today around line 320).** Current:

```tsx
          color: editColor,
        }),
      });
      if (res.ok) {
        setLists((prev) =>
          prev.map((l) =>
            l.id === editTargetRef.current
              ? { ...l, name: editName.trim(), icon: editIcon, color: editColor }
              : l
          )
        );
        setShowEdit(false);
      }
    } catch (e) {
      console.error("[Home] Edit error:", e);
    } finally {
      setEditSaving(false);
    }
  }, [editName, editIcon, editColor, jwtRef]);

  const handleDeleteList = useCallback((listToDelete: ListData) => {
    const jwt = jwtRef.current;
```

Replace with:

```tsx
          color: editColor,
        }),
      });
      throwIfNotOk(res, "Edit");
      setLists((prev) =>
        prev.map((l) =>
          l.id === editTargetRef.current
            ? { ...l, name: editName.trim(), icon: editIcon, color: editColor }
            : l
        )
      );
      setShowEdit(false);
    } catch (e) {
      // The sheet stays open with the user's input, so Save can be tapped again.
      console.error("[Home] Edit list failed:", { listId }, e);
      showToast("errors.generic");
    } finally {
      setEditSaving(false);
    }
  }, [editName, editIcon, editColor, jwtRef, showToast]);

  const handleDeleteList = useCallback((listToDelete: ListData) => {
    const jwt = jwtRef.current;
```

**app/page.tsx, edit 8 (today around line 348).** Current:

```tsx
      // Optimistic removal — remember the slot so undo restores it in place
      const deletedIndex = lists.findIndex((l) => l.id === listToDelete.id);
      setLists((prev) => prev.filter((l) => l.id !== listToDelete.id));

      // Clear any existing undo
      setToast((prev) => {
```

Replace with:

```tsx
      // Optimistic removal — remember the slot so undo restores it in place
      const deletedIndex = lists.findIndex((l) => l.id === listToDelete.id);
      setLists((prev) => prev.filter((l) => l.id !== listToDelete.id));
      // A failure must not write this view's card into another tab's lists.
      const actionView = view;
      const stillSameView = () => viewRef.current === actionView;
      // Back at the slot it was removed from, unless it is already there: Undo and a
      // failed delete can both put it back.
      const putBack = () =>
        setLists((prev) => {
          if (prev.some((l) => l.id === listToDelete.id)) return prev;
          const next = [...prev];
          next.splice(deletedIndex === -1 ? next.length : deletedIndex, 0, listToDelete);
          return next;
        });

      // Clear any existing undo
      setToast((prev) => {
```

**app/page.tsx, edit 9 (today around line 363).** Current:

```tsx
          clearTimeout(timeout);
          setToast(null);
          // Restore optimistically, back at the position it was removed from
          setLists((prev) => {
            const next = [...prev];
            next.splice(
              deletedIndex === -1 ? next.length : deletedIndex,
              0,
              listToDelete
            );
            return next;
          });
          // Restore on server
          const currentJwt = jwtRef.current;
          fetch("/api/lists", {
```

Replace with:

```tsx
          clearTimeout(timeout);
          setToast(null);
          // Restore optimistically, back at the position it was removed from
          putBack();
          // Restore on server
          const currentJwt = jwtRef.current;
          fetch("/api/lists", {
```

**app/page.tsx, edit 10 (today around line 381).** Current:

```tsx
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ id: listToDelete.id, restore: true }),
          });
        },
        timeout,
      });
```

Replace with:

```tsx
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ id: listToDelete.id, restore: true }),
          })
            .then((res) => throwIfNotOk(res, "Restore"))
            .catch((e) => {
              console.error("[Home] Undo delete failed:", { listId: listToDelete.id }, e);
              showToast("errors.generic");
              // silent: show the server's state without the full-page error view
              if (stillSameView()) fetchLists({ silent: true });
            });
        },
        timeout,
      });
```

**app/page.tsx, edit 11 (today around line 390).** Current:

```tsx
      fetch(`/api/lists?id=${listToDelete.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${jwt}` },
      });
    };

    // Use Telegram native confirm if available, fallback to window.confirm
```

Replace with:

```tsx
      fetch(`/api/lists?id=${listToDelete.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${jwt}` },
      })
        .then((res) => throwIfNotOk(res, "Delete"))
        .catch((e) => {
          console.error("[Home] Delete list failed:", { listId: listToDelete.id }, e);
          clearTimeout(timeout);
          showToast("lists.deleteFailed");
          if (!stillSameView()) return;
          putBack();
          // silent: show the server's state without the full-page error view
          fetchLists({ silent: true });
        });
    };

    // Use Telegram native confirm if available, fallback to window.confirm
```

**app/page.tsx, edit 12 (today around line 403).** Current:

```tsx
        doDelete();
      }
    }
  }, [lists, jwtRef, t]);

  if (loading) {
    return (
```

Replace with:

```tsx
        doDelete();
      }
    }
  }, [lists, view, jwtRef, t, showToast, fetchLists]);

  if (loading) {
    return (
```

**app/page.tsx, edit 13 (today around line 628).** Current:

```tsx
        <LanguageSheet
          currentLocale={locale}
          onSelect={async (lang) => {
            await setLanguage(lang);
            setShowLanguage(false);
          }}
          onClose={() => setShowLanguage(false)}
        />
```

Replace with:

```tsx
        <LanguageSheet
          currentLocale={locale}
          onSelect={async (lang) => {
            const saved = await setLanguage(lang);
            setShowLanguage(false);
            // The chosen language stays on screen; the toast says it wasn't saved.
            if (!saved) showToast("errors.generic");
          }}
          onClose={() => setShowLanguage(false)}
        />
```

**app/page.tsx, edit 14 (today around line 637).** Current:

```tsx

      {/* Bottom toast */}
      {toast && (
        <div className="fixed bottom-8 start-5 end-5 bg-foreground text-background rounded-2xl py-3.5 px-5 flex items-center justify-between z-30 shadow-xl shadow-black/10 dark:shadow-black/30 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <span className="text-sm">{toast.message}</span>
          {toast.undo && (
            <button
```

Replace with:

```tsx

      {/* Bottom toast */}
      {toast && (
        <div className="fixed bottom-8 start-5 end-5 bg-foreground text-background rounded-2xl py-3.5 px-5 flex items-center justify-between z-[60] shadow-xl shadow-black/10 dark:shadow-black/30 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <span className="text-sm">{toast.message}</span>
          {toast.undo && (
            <button
```

**src/hooks/useLocaleSync.ts, edit 1 (today around line 2).** Current:

```ts

import { useState, useCallback } from "react";
import { isRtl, type SupportedLocale } from "@/src/lib/i18n";

export function useLocaleSync(jwtRef: React.RefObject<string | null>) {
  const [locale, setLocale] = useState<SupportedLocale>("en");
```

Replace with:

```ts

import { useState, useCallback } from "react";
import { isRtl, type SupportedLocale } from "@/src/lib/i18n";
import { throwIfNotOk } from "@/src/utils/http";

export function useLocaleSync(jwtRef: React.RefObject<string | null>) {
  const [locale, setLocale] = useState<SupportedLocale>("en");
```

**src/hooks/useLocaleSync.ts, edit 2 (today around line 17).** Current:

```ts
    }
  }, []);

  const setLanguage = useCallback(
    async (lang: SupportedLocale) => {
      applyLocale(lang);
      const token = jwtRef.current;
      if (!token) return;
      try {
        await fetch("/api/user", {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
```

Replace with:

```ts
    }
  }, []);

  // Applies the language at once, then saves it. Resolves false when it was not saved.
  const setLanguage = useCallback(
    async (lang: SupportedLocale): Promise<boolean> => {
      applyLocale(lang);
      const token = jwtRef.current;
      if (!token) {
        console.warn("[LocaleSync] No session token, language not saved:", { lang });
        return false;
      }
      try {
        const res = await fetch("/api/user", {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
```

**src/hooks/useLocaleSync.ts, edit 3 (today around line 31).** Current:

```ts
          },
          body: JSON.stringify({ language: lang }),
        });
      } catch (e) {
        console.error("[TelegramProvider] Language update error:", e);
      }
    },
    [applyLocale, jwtRef]
```

Replace with:

```ts
          },
          body: JSON.stringify({ language: lang }),
        });
        throwIfNotOk(res, "Language save");
        return true;
      } catch (e) {
        console.error("[LocaleSync] Language save failed:", { lang }, e);
        return false;
      }
    },
    [applyLocale, jwtRef]
```

**components/TelegramProvider.tsx, edit 1 (today around line 53).** Current:

```tsx
  jwt: string | null;
  jwtRef: React.RefObject<string | null>;
  locale: SupportedLocale;
  setLanguage: (lang: SupportedLocale) => Promise<void>;
  supabaseClient: SupabaseClient | null;
  supabaseClientRef: React.RefObject<SupabaseClient | null>;
  isReady: boolean;
```

Replace with:

```tsx
  jwt: string | null;
  jwtRef: React.RefObject<string | null>;
  locale: SupportedLocale;
  /** Resolves false when the language could not be saved (it stays applied on screen). */
  setLanguage: (lang: SupportedLocale) => Promise<boolean>;
  supabaseClient: SupabaseClient | null;
  supabaseClientRef: React.RefObject<SupabaseClient | null>;
  isReady: boolean;
```

**components/TelegramProvider.tsx, edit 2 (today around line 74).** Current:

```tsx
  jwt: null,
  jwtRef: { current: null },
  locale: "en",
  setLanguage: async () => {},
  supabaseClient: null,
  supabaseClientRef: { current: null },
  isReady: false,
```

Replace with:

```tsx
  jwt: null,
  jwtRef: { current: null },
  locale: "en",
  setLanguage: async () => false,
  supabaseClient: null,
  supabaseClientRef: { current: null },
  isReady: false,
```

**components/ShareDialog.tsx, edit 1 (today around line 5).** Current:

```tsx
import { X, Copy, Check, Link2 } from "lucide-react";
import { getTelegramWebApp } from "@/src/types/telegram";
import { useTelegram } from "./TelegramProvider";

interface Collaborator {
  id: string;
```

Replace with:

```tsx
import { X, Copy, Check, Link2 } from "lucide-react";
import { getTelegramWebApp } from "@/src/types/telegram";
import { useTelegram } from "./TelegramProvider";
import { throwIfNotOk } from "@/src/utils/http";

interface Collaborator {
  id: string;
```

**components/ShareDialog.tsx, edit 2 (today around line 29).** Current:

```tsx
}: ShareDialogProps) {
  const { jwtRef } = useTelegram();
  const t = useTranslations('share');
  const [permission, setPermission] = useState<"view" | "edit">("edit");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [loading, setLoading] = useState(false);

  const loadCollaborators = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    try {
      const res = await fetch(`/api/share?listId=${listId}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (res.ok) {
        const data = await res.json();
        setCollaborators(data.collaborators || []);
        if (data.activeLink) {
          setInviteLink(data.activeLink);
        }
      }
    } catch (e) {
      console.error("[ShareDialog] Failed to load:", e);
    }
  }, [jwtRef, listId]);

```

Replace with:

```tsx
}: ShareDialogProps) {
  const { jwtRef } = useTelegram();
  const t = useTranslations('share');
  const tErrors = useTranslations('errors');
  const [permission, setPermission] = useState<"view" | "edit">("edit");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [loading, setLoading] = useState(false);
  // A load or link request failed. Shown inline: the dialog covers the page's toasts.
  const [error, setError] = useState(false);

  const loadCollaborators = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    setError(false);
    try {
      const res = await fetch(`/api/share?listId=${listId}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      throwIfNotOk(res, "Share load");
      const data = await res.json();
      setCollaborators(data.collaborators || []);
      if (data.activeLink) {
        setInviteLink(data.activeLink);
      }
    } catch (e) {
      console.error("[ShareDialog] Failed to load:", { listId }, e);
      setError(true);
    }
  }, [jwtRef, listId]);

```

**components/ShareDialog.tsx, edit 3 (today around line 64).** Current:

```tsx
    const jwt = jwtRef.current;
    if (!jwt) return;
    setLoading(true);
    try {
      const res = await fetch("/api/share", {
        method: "POST",
```

Replace with:

```tsx
    const jwt = jwtRef.current;
    if (!jwt) return;
    setLoading(true);
    setError(false);
    try {
      const res = await fetch("/api/share", {
        method: "POST",
```

**components/ShareDialog.tsx, edit 4 (today around line 73).** Current:

```tsx
        },
        body: JSON.stringify({ listId, permission }),
      });
      if (res.ok) {
        const { link } = await res.json();
        setInviteLink(link);
      }
    } catch (e) {
      console.error("[ShareDialog] Failed to generate link:", e);
    } finally {
      setLoading(false);
    }
```

Replace with:

```tsx
        },
        body: JSON.stringify({ listId, permission }),
      });
      throwIfNotOk(res, "Link create");
      const { link } = await res.json();
      setInviteLink(link);
    } catch (e) {
      console.error("[ShareDialog] Failed to generate link:", { listId }, e);
      setError(true);
    } finally {
      setLoading(false);
    }
```

**components/ShareDialog.tsx, edit 5 (today around line 139).** Current:

```tsx
          </button>
        </div>

        {/* Generate or show link */}
        {inviteLink ? (
          <div className="flex gap-2 mb-6">
```

Replace with:

```tsx
          </button>
        </div>

        {error && (
          <p role="alert" className="mb-4 text-sm text-tg-destructive">{tErrors('generic')}</p>
        )}

        {/* Generate or show link */}
        {inviteLink ? (
          <div className="flex gap-2 mb-6">
```

The messages: add one line after `"archiveFailed"` in the `lists` object of each file. These are the exact strings from the spec.

**messages/en.json, edit 1 (today around line 63).** Current:

```json
    "listArchived": "List archived",
    "listUnarchived": "List unarchived",
    "archiveFailed": "Couldn't archive the list",
    "emptyArchived": "No archived lists",
    "reorderFailed": "Couldn't save the new order"
  },
```

Replace with:

```json
    "listArchived": "List archived",
    "listUnarchived": "List unarchived",
    "archiveFailed": "Couldn't archive the list",
    "deleteFailed": "Couldn't delete the list",
    "emptyArchived": "No archived lists",
    "reorderFailed": "Couldn't save the new order"
  },
```

**messages/he.json, edit 1 (today around line 63).** Current:

```json
    "listArchived": "הרשימה הועברה לארכיון",
    "listUnarchived": "הרשימה הוצאה מהארכיון",
    "archiveFailed": "לא הצלחנו להעביר את הרשימה לארכיון",
    "emptyArchived": "אין רשימות בארכיון",
    "reorderFailed": "לא הצלחנו לשמור את הסדר החדש"
  },
```

Replace with:

```json
    "listArchived": "הרשימה הועברה לארכיון",
    "listUnarchived": "הרשימה הוצאה מהארכיון",
    "archiveFailed": "לא הצלחנו להעביר את הרשימה לארכיון",
    "deleteFailed": "לא הצלחנו למחוק את הרשימה",
    "emptyArchived": "אין רשימות בארכיון",
    "reorderFailed": "לא הצלחנו לשמור את הסדר החדש"
  },
```

**messages/ru.json, edit 1 (today around line 63).** Current:

```json
    "listArchived": "Список отправлен в архив",
    "listUnarchived": "Список возвращён из архива",
    "archiveFailed": "Не удалось отправить список в архив",
    "emptyArchived": "Нет списков в архиве",
    "reorderFailed": "Не удалось сохранить новый порядок"
  },
```

Replace with:

```json
    "listArchived": "Список отправлен в архив",
    "listUnarchived": "Список возвращён из архива",
    "archiveFailed": "Не удалось отправить список в архив",
    "deleteFailed": "Не удалось удалить список",
    "emptyArchived": "Нет списков в архиве",
    "reorderFailed": "Не удалось сохранить новый порядок"
  },
```

- [ ] **Step 4: update existing tests that the change makes stale**

None. `locale-parity.test.ts` stays green because all 3 files gain the same key. `user-update.test.ts` only checks that TelegramProvider never mentions a time zone. Nothing else imports `setLanguage`, the home page or ShareDialog. The other tests stub ShareDialog to `() => null`.

- [ ] **Step 5: run tests, expect PASS**

```bash
npx vitest run __tests__/unit/home-background-saves.test.ts __tests__/unit/share-dialog-errors.test.ts __tests__/unit/locale-sync.test.ts __tests__/unit/locale-parity.test.ts __tests__/unit/no-silent-catches.test.ts __tests__/unit/user-update.test.ts __tests__/unit/reminders-ui-removed.test.ts
npx vitest run
npx tsc --noEmit
npx eslint app/page.tsx src/hooks/useLocaleSync.ts components/TelegramProvider.tsx components/ShareDialog.tsx __tests__/unit/home-background-saves.test.ts __tests__/unit/share-dialog-errors.test.ts __tests__/unit/locale-sync.test.ts
```

Expected: the targeted files pass, with 52 tests. The full suite passed with 78 files and 602 tests on a copy of the tree at f441470 plus 7a. On the real tree, the count includes the tests that tasks 1 to 6 added. `tsc` exits 0, and eslint reports 0 problems.

- [ ] **Step 6: make it bite**

All 15 were verified red.

| change | test file | goes red |
|---|---|---|
| `app/page.tsx`: delete `.then((res) => throwIfNotOk(res, "Delete"))` | home-background-saves | "a delete the server refused…", "a delete that fails after Undo…" |
| `app/page.tsx`: delete `if (prev.some((l) => l.id === listToDelete.id)) return prev;` in `putBack` | home-background-saves | "a delete that fails after Undo was tapped shows the card once" |
| `app/page.tsx`: delete `showToast("lists.deleteFailed");` | home-background-saves | all three delete-failure tests |
| `app/page.tsx`: delete `putBack();` in the DELETE catch | home-background-saves | "a delete the server refused…", "a delete that could not be sent…" |
| `app/page.tsx`: delete `.then((res) => throwIfNotOk(res, "Restore"))` (undo delete) | home-background-saves | "Home: delete a list > a failed Undo…" |
| `app/page.tsx`: delete `.then((res) => throwIfNotOk(res, "Undo archive"))` | home-background-saves | "Home: Undo of an archive > a failed Undo…" |
| `app/page.tsx`: delete `throwIfNotOk(res, "Edit");` | home-background-saves | "a save the server refused keeps the sheet open…" |
| `app/page.tsx`: delete `throwIfNotOk(res, "Create list");` | home-background-saves | "a create the server refused…" |
| `app/page.tsx`: delete `if (!saved) showToast("errors.generic");` | home-background-saves | "a language that could not be saved…" |
| `app/page.tsx`: toast `z-[60]` back to `z-30` | home-background-saves | "a save the server refused … above the sheet" |
| `useLocaleSync.ts`: delete `throwIfNotOk(res, "Language save");` | locale-sync | "resolves false and logs when the server refused…" |
| `useLocaleSync.ts`: delete `return false;` in the no-token branch | locale-sync | "resolves false with a warning…" |
| `ShareDialog.tsx`: delete `throwIfNotOk(res, "Share load");` | share-dialog-errors | "a collaborator load the server refused…", "a retry that works…" |
| `ShareDialog.tsx`: delete `throwIfNotOk(res, "Link create");` | share-dialog-errors | "a link the server refused to create…" |
| `ShareDialog.tsx`: delete `setError(false);` in `generateLink` | share-dialog-errors | "a retry that works clears the error and shows the link" |

Visual check (the spec's toast-stacking risk): the z-index tests compare the rendered classes. After deploy, the owner should confirm on the phone that the toast shows above the edit sheet. To trigger it, save while offline.

- [ ] **Step 7: commit**

```bash
git add app/page.tsx src/hooks/useLocaleSync.ts components/TelegramProvider.tsx components/ShareDialog.tsx messages/en.json messages/he.json messages/ru.json __tests__/unit/home-background-saves.test.ts __tests__/unit/share-dialog-errors.test.ts __tests__/unit/locale-sync.test.ts
git commit -F - <<'EOF'
fix(home): failed list saves, language and share dialog tell the user

Deleting a list checks the server's answer: on failure the card returns
to its slot and a new "Couldn't delete the list" toast shows. A failed
Undo of a delete or archive shows the generic error and quietly reloads
the server's state. The edit sheet stays open with the user's input on
failure, and creating a list shows the generic toast instead of an
English alert. setLanguage now reports whether the language was saved.
The share dialog shows the generic error inline when it cannot load or
create a link. Home toasts draw above the sheets.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
```

### Task 8: Client reads and cleanup

Only one change is visible to users. When `/api/lists` fails while a list opens, the list page shows its existing Retry screen. Today it shows a list with no header, and a grocery list opens as a regular one. Every other site only gains a log line and keeps its behaviour. Realtime channel removal goes through one new logged helper.

Runs after Task 7. Task 7 creates `src/utils/http.ts` (`throwIfNotOk`) and edits other parts of `app/page.tsx` and `components/TelegramProvider.tsx`: the delete, undo, edit and create handlers on the home page, and the `setLanguage` type at the context interface and its default. This task touches neither of those areas. Anchor every edit below on the quoted code, not on line numbers.

**Files:**
- Create: `src/lib/realtime-cleanup.ts`
- Modify: `src/hooks/useListData.ts`
- Modify: `src/hooks/useRealtimeList.ts`
- Modify: `src/hooks/useJWTRefresh.ts`
- Modify: `components/TelegramProvider.tsx`
- Modify: `app/page.tsx` (only the `fetchLists` non-ok branch)
- Test, create: `__tests__/unit/realtime-cleanup.test.ts`
- Test, create: `__tests__/unit/jwt-refresh-logging.test.ts`
- Test, create: `__tests__/unit/telegram-provider-bootstrap.test.ts`
- Test, create: `__tests__/unit/home-fetch-lists.test.ts`
- Test, modify: `__tests__/unit/list-data-categories.test.ts` (adds a `console.warn` spy and appends one describe block)

**Interfaces:**
- Consumes, from Task 7 (`src/utils/http.ts`): `export function throwIfNotOk(res: Response, verb: string): void`. It throws `` `${verb} failed: ${res.status}` ``. The verbs used here are "Load lists", "Auto-unskip" and "Auto-respawn". None of them contains "fetch" or "network", and none of these calls is inside an executor or an inline `execute` closure.
- Produces (`src/lib/realtime-cleanup.ts`):
  - `export function removeChannelLogged(client: SupabaseClient, channel: RealtimeChannel, context: Record<string, unknown>): void`
  - `export function removeAllChannelsLogged(client: SupabaseClient): void`

  Both are fire-and-forget. They read Supabase's `"ok" | "timed out" | "error"` answer, `console.warn` anything but `"ok"`, and catch a rejection with the error object. Nothing later relies on them except the guard test in this task.

**Log levels.** Background reads that heal on the next load use `console.warn`. The two user loads in TelegramProvider use `console.error`, matching their existing catch logs, because the app then runs without a userId until it is reopened. Every line logs IDs and status only. It never logs the JWT, the stored web token or initData. The tests assert this.

**Sites:**

| site (as of today) | today on failure | change | user-visible result |
|---|---|---|---|
| `src/hooks/useListData.ts:67` (`findList`, inventory `:64`) | A non-ok `/api/lists` or `?archived=1` returns `undefined` with no log. The header stays blank, a grocery list opens as "regular" so its categories never load, and the items still render | `throwIfNotOk(res, "Load lists")`. The existing `fetchItems` catch logs `[List] Fetch error:` with the Error and sets `error` | The existing Retry screen. A 200 without the list still falls through to the archived lookup |
| `src/hooks/useListData.ts:143` (items GET non-ok in `fetchItems`; **missed by the inventory**) | `setError(true)` with no log of the status | `console.warn("[List] Load items failed:", { listId, status })` | none (the Retry screen already shows) |
| `src/hooks/useListData.ts:38` (`loadCategories`, inventory `:35`) | A non-ok is silent, and the comment claims it is logged | else-branch `console.warn("[List] Categories load failed:", { listId, status })`; comment fixed | none |
| `src/hooks/useListData.ts:111` (auto-unskip PATCH) | The `.catch` sees only a rejection, and a 4xx/5xx is never read | `.then((res) => throwIfNotOk(res, "Auto-unskip"))` before the existing `.catch`, whose warn now also covers non-ok | none |
| `src/hooks/useListData.ts:127` (auto-respawn PATCH) | same | `.then((res) => throwIfNotOk(res, "Auto-respawn"))` | none |
| `src/hooks/useListData.ts:161` (`refreshItems`, inventory `:158`) | `if (!res.ok) return;` silently | warn `[List] Background refresh failed:` `{ listId, status }`, then return (it still resolves; whether to rethrow is out of scope, see rulings) | none |
| `src/hooks/useListData.ts:217` (`retrySorting`, inventory `:214`) | `if (!res.ok) return;` silently | warn `[List] Sorting retry failed:` `{ listId, status }`, then return | none |
| `src/hooks/useJWTRefresh.ts:22` (inventory `:21`) | 401/429/5xx all collapse to `null` with no log | warn `[TelegramProvider] Token request failed:` `{ mode: "bearer" \| "initData", status }`; still returns `null` (the logout behaviour is out of scope) | none |
| `components/TelegramProvider.tsx:220` (web GET `/api/user`, inventory `:217`) | non-ok: no else branch, no log | else-branch `console.error("[TelegramProvider] Web user load failed:", { status })` | none |
| `components/TelegramProvider.tsx:323` (Mini App POST `/api/user`, inventory `:319`) | same | else-branch `console.error("[TelegramProvider] User registration failed:", { status })` | none |
| `components/TelegramProvider.tsx:142` (`removeAllChannels`) | Promise of results neither read nor caught | `removeAllChannelsLogged(oldClient)` | none |
| `src/hooks/useRealtimeList.ts:123` (resubscribe timeout) | `removeChannel` result ignored | `removeChannelLogged(client, channel, { listId, reason: "resubscribe timed out" })` | none |
| `src/hooks/useRealtimeList.ts:141` (resubscribe CHANNEL_ERROR/TIMED_OUT) | same | `removeChannelLogged(client, channel, { listId, reason: \`resubscribe ${status}\` })` | none |
| `src/hooks/useRealtimeList.ts:159` (replace channel) | same | capture `channelRef.current` in `stale`, null the ref, `removeChannelLogged(supabaseClient, stale, { listId, reason: "replaced" })` | none |
| `src/hooks/useRealtimeList.ts:184` (effect cleanup) | same | capture `channelRef.current` in `channel` before nulling it, `removeChannelLogged(client, channel, { listId, reason: "cleanup" })` | none |
| `app/page.tsx:139-141` (`fetchLists` non-ok, inventory `:113`) | non-ok is never logged; with `silent` it is dropped with no trace | after the existing stale-generation check: warn `[Home] Load lists failed:` `{ view, silent, status }`, then `if (!silent) setError(true)` | none (same screens as today) |

No site was dropped. Every inventory claim matched the code. Only line numbers moved: the inventory points at the `fetch(` line, and the table points at the `res.ok` check.

---

- [ ] **Step 1: Write the failing tests**

Create `__tests__/unit/realtime-cleanup.test.ts`:

```ts
/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

// Runs the real useRealtimeList with slot-based stand-ins for React's hooks: refs persist
// across calls, effects are recorded and run by the test. Nothing renders.
type Effect = { fn: () => void | (() => void); deps?: unknown[] };
const R = vi.hoisted(() => ({ slots: [] as { current: unknown }[], effects: [] as Effect[], i: 0 }));
vi.mock("react", () => ({
  useRef: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { current: init };
    return R.slots[i];
  },
  useCallback: (fn: unknown) => (R.i++, fn),
  useEffect: (fn: Effect["fn"], deps?: unknown[]) => {
    R.effects.push({ fn, deps });
    R.i++;
  },
}));

import { removeChannelLogged, removeAllChannelsLogged } from "@/src/lib/realtime-cleanup";
import { useRealtimeList } from "@/src/hooks/useRealtimeList";

type Removal = "ok" | "timed out" | "error";
type FakeChannel = { topic: string; on: () => FakeChannel; subscribe: (cb: (s: string, e?: Error) => void) => FakeChannel; cb?: (s: string, e?: Error) => void };

function fakeClient(removal: () => Promise<Removal>) {
  const channels: FakeChannel[] = [];
  const client = {
    channel: vi.fn((name: string) => {
      const ch: FakeChannel = {
        topic: `realtime:${name}`,
        on: () => ch,
        subscribe: (cb) => {
          ch.cb = cb;
          return ch;
        },
      };
      channels.push(ch);
      return ch;
    }),
    removeChannel: vi.fn(removal),
    removeAllChannels: vi.fn(async () => [] as Removal[]),
  };
  return { client, channels, sb: client as unknown as SupabaseClient };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  R.slots = [];
  R.effects = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("removeChannelLogged", () => {
  const channel = { topic: "realtime:list:L:1" } as unknown as RealtimeChannel;

  it.each(["error", "timed out"] as const)("warns with the context when Supabase answers %s", async (answer) => {
    const { client, sb } = fakeClient(async () => answer);
    removeChannelLogged(sb, channel, { listId: "L", reason: "cleanup" });
    await settle();
    expect(client.removeChannel).toHaveBeenCalledWith(channel);
    expect(console.warn).toHaveBeenCalledWith("[Realtime] Remove channel failed:", { listId: "L", reason: "cleanup" }, answer);
  });

  it("warns with the error object when the removal rejects", async () => {
    const boom = new Error("socket gone");
    const { sb } = fakeClient(async () => {
      throw boom;
    });
    removeChannelLogged(sb, channel, { listId: "L", reason: "cleanup" });
    await settle();
    expect(console.warn).toHaveBeenCalledWith("[Realtime] Remove channel failed:", { listId: "L", reason: "cleanup" }, boom);
  });

  it("stays silent on ok", async () => {
    const { sb } = fakeClient(async () => "ok");
    removeChannelLogged(sb, channel, { listId: "L", reason: "cleanup" });
    await settle();
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("removeAllChannelsLogged", () => {
  it("warns with the answers that were not ok", async () => {
    const { client, sb } = fakeClient(async () => "ok");
    client.removeAllChannels.mockResolvedValue(["ok", "timed out", "error"]);
    removeAllChannelsLogged(sb);
    await settle();
    expect(console.warn).toHaveBeenCalledWith("[Realtime] Remove all channels failed:", { total: 3 }, ["timed out", "error"]);
  });

  it("warns with the error object when the removal rejects", async () => {
    const boom = new Error("socket gone");
    const { client, sb } = fakeClient(async () => "ok");
    client.removeAllChannels.mockRejectedValue(boom);
    removeAllChannelsLogged(sb);
    await settle();
    expect(console.warn).toHaveBeenCalledWith("[Realtime] Remove all channels failed:", boom);
  });

  it("stays silent when every channel answers ok", async () => {
    const { client, sb } = fakeClient(async () => "ok");
    client.removeAllChannels.mockResolvedValue(["ok", "ok"]);
    removeAllChannelsLogged(sb);
    await settle();
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("useRealtimeList removes channels through the logged helper", () => {
  const ref: { current: SupabaseClient | null } = { current: null };
  const render = (client: SupabaseClient | null) => {
    R.i = 0;
    R.effects = [];
    ref.current = client;
    return useRealtimeList(client, ref, "L", () => {});
  };
  // The subscribe effect is the one that depends on the client.
  const subscribeEffect = () => R.effects.find((e) => e.deps?.includes(ref))!;

  it("logs a failed removal when the list closes", async () => {
    const { client, channels, sb } = fakeClient(async () => "error");
    render(sb);
    const cleanup = subscribeEffect().fn() as () => void;
    channels[0].cb!("SUBSCRIBED");
    cleanup();
    await settle();
    expect(client.removeChannel).toHaveBeenCalledWith(channels[0]);
    expect(console.warn).toHaveBeenCalledWith("[Realtime] Remove channel failed:", { listId: "L", reason: "cleanup" }, "error");
  });

  it("logs a failed removal of the channel it replaces", async () => {
    const { client, channels, sb } = fakeClient(async () => "timed out");
    render(sb);
    subscribeEffect().fn();
    channels[0].cb!("SUBSCRIBED");
    render(sb);
    subscribeEffect().fn();
    await settle();
    expect(client.removeChannel).toHaveBeenCalledWith(channels[0]);
    expect(console.warn).toHaveBeenCalledWith("[Realtime] Remove channel failed:", { listId: "L", reason: "replaced" }, "timed out");
  });

  it("logs a failed removal of a channel whose resubscribe errored", async () => {
    const { client, channels, sb } = fakeClient(async () => "error");
    const { resubscribe } = render(sb);
    const done = resubscribe();
    channels[0].cb!("CHANNEL_ERROR", new Error("denied"));
    await expect(done).rejects.toThrow("Channel subscribe failed: CHANNEL_ERROR");
    await settle();
    expect(client.removeChannel).toHaveBeenCalledWith(channels[0]);
    expect(console.warn).toHaveBeenCalledWith("[Realtime] Remove channel failed:", { listId: "L", reason: "resubscribe CHANNEL_ERROR" }, "error");
  });

  it("logs a failed removal of a channel whose resubscribe timed out", async () => {
    vi.useFakeTimers();
    const boom = new Error("socket gone");
    const { client, channels, sb } = fakeClient(async () => {
      throw boom;
    });
    const { resubscribe } = render(sb);
    const done = resubscribe();
    const settled = expect(done).rejects.toThrow("Resubscribe timed out");
    await vi.advanceTimersByTimeAsync(10000);
    await settled;
    expect(client.removeChannel).toHaveBeenCalledWith(channels[0]);
    expect(console.warn).toHaveBeenCalledWith("[Realtime] Remove channel failed:", { listId: "L", reason: "resubscribe timed out" }, boom);
  });
});

// The helpers are the one code path for channel removal: a bare call drops Supabase's
// "error" / "timed out" answer on the floor.
describe("no bare channel removal in app code", () => {
  const ROOT = process.cwd();
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "node_modules" ? [] : walk(path);
      return /\.(ts|tsx)$/.test(name) ? [relative(ROOT, path)] : [];
    });

  it("every removeChannel / removeAllChannels call goes through src/lib/realtime-cleanup.ts", () => {
    const bare = ["app", "src", "components", "lib"]
      .flatMap((d) => walk(join(ROOT, d)))
      .filter((f) => f !== join("src", "lib", "realtime-cleanup.ts"))
      .flatMap((f) =>
        readFileSync(join(ROOT, f), "utf8")
          .split("\n")
          .flatMap((line, n) => (/\.(removeChannel|removeAllChannels)\(/.test(line) ? [`${f}:${n + 1}`] : []))
      );
    expect(bare).toEqual([]);
  });
});
```

Create `__tests__/unit/jwt-refresh-logging.test.ts`:

```ts
/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Runs the real useJWTRefresh with slot-based stand-ins for React's hooks.
const R = vi.hoisted(() => ({ slots: [] as { value: unknown }[], i: 0 }));
vi.mock("react", () => ({
  useState: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: init };
    const slot = R.slots[i];
    return [slot.value, (v: unknown) => { slot.value = v; }];
  },
  useRef: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: { current: init } };
    return R.slots[i].value;
  },
  useCallback: (fn: unknown) => (R.i++, fn),
}));

import { useJWTRefresh } from "@/src/hooks/useJWTRefresh";

const render = () => {
  R.i = 0;
  return useJWTRefresh();
};
const INIT_DATA = "query_id=q&user=%7B%7D&hash=secret-hash";
const OLD_JWT = "old.jwt.value";

function stubToken(reply: { ok: boolean; status: number; token?: string }) {
  const f = vi.fn(async () => ({ ok: reply.ok, status: reply.status, json: async () => ({ token: reply.token }) }));
  vi.stubGlobal("fetch", f);
  return f;
}
// Every argument of every console call, flattened to text.
const logged = () =>
  [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls]
    .flat()
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");

beforeEach(() => {
  R.slots = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useJWTRefresh logs a refused token request", () => {
  it("logs the status of a refused Mini App sign-in, never the initData", async () => {
    stubToken({ ok: false, status: 401 });
    await expect(render().fetchToken(INIT_DATA)).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalledWith("[TelegramProvider] Token request failed:", { mode: "initData", status: 401 });
    expect(logged()).not.toContain("secret-hash");
  });

  it("logs the status of a refused token refresh, never the token", async () => {
    const f = stubToken({ ok: false, status: 503 });
    const hook = render();
    hook.jwtRef.current = OLD_JWT;
    await expect(hook.fetchToken(null)).resolves.toBeNull();
    expect(f).toHaveBeenCalledWith("/api/auth/token", { headers: { Authorization: `Bearer ${OLD_JWT}` } });
    expect(console.warn).toHaveBeenCalledWith("[TelegramProvider] Token request failed:", { mode: "bearer", status: 503 });
    expect(logged()).not.toContain(OLD_JWT);
  });

  it("logs nothing and keeps the new token when the server says yes", async () => {
    stubToken({ ok: true, status: 200, token: "new.jwt" });
    const hook = render();
    await expect(hook.fetchToken(INIT_DATA)).resolves.toBe("new.jwt");
    expect(hook.jwtRef.current).toBe("new.jwt");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("sends nothing and logs nothing with neither a token nor initData", async () => {
    const f = stubToken({ ok: true, status: 200, token: "x" });
    await expect(render().fetchToken(null)).resolves.toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });
});
```

Create `__tests__/unit/telegram-provider-bootstrap.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Calls the real TelegramProvider as a plain function with slot-based stand-ins for React's
// hooks (state and refs persist; effects are recorded and the test runs the bootstrap one).
// The extracted hooks and the Supabase client are stubbed.
type Effect = { fn: () => void | (() => void); deps?: unknown[] };
const R = vi.hoisted(() => ({ slots: [] as { value: unknown }[], effects: [] as Effect[], i: 0 }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: init };
    const slot = R.slots[i];
    return [slot.value, (v: unknown) => { slot.value = v; }];
  },
  useRef: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: { current: init } };
    return R.slots[i].value;
  },
  useCallback: (fn: unknown) => (R.i++, fn),
  useEffect: (fn: Effect["fn"], deps?: unknown[]) => {
    R.i++;
    R.effects.push({ fn, deps });
  },
}));

const H = vi.hoisted(() => ({
  jwtRef: { current: null as string | null },
  fetchToken: (async () => null) as (initData: string | null) => Promise<string | null>,
  orchestratorParams: null as null | { recreateSupabaseClient: (token: string) => void },
  clients: [] as unknown[],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("next-intl", () => ({ NextIntlClientProvider: () => null }));
vi.mock("@/src/lib/supabase", () => ({ createBrowserClient: () => H.clients.shift() }));
vi.mock("@/src/hooks/useJWTRefresh", () => ({
  useJWTRefresh: () => ({ jwt: null, jwtRef: H.jwtRef, fetchToken: H.fetchToken, clearJwt: () => {} }),
}));
vi.mock("@/src/hooks/useLocaleSync", () => ({
  useLocaleSync: () => ({ locale: "en", applyLocale: () => {}, setLanguage: async () => {} }),
}));
vi.mock("@/src/hooks/useHomeScreen", () => ({
  useHomeScreen: () => ({ homeScreenStatus: null, setHomeScreenStatus: () => {}, addToHomeScreen: () => {} }),
}));
vi.mock("@/src/hooks/useReconnectOrchestrator", () => ({
  useReconnectOrchestrator: (params: { recreateSupabaseClient: (token: string) => void }) => {
    H.orchestratorParams = params;
    return { connectionStatus: "connecting", retryCount: 0, reconnect: () => {}, runReconnectRef: { current: () => {} }, setOrchestratorState: () => {} };
  },
}));

import TelegramProvider from "@/components/TelegramProvider";

const INIT_DATA = "query_id=q&user=%7B%7D&hash=secret-hash";

const fakeClient = (removeAll: () => Promise<string[]>) => ({
  realtime: { disconnect: vi.fn() },
  removeAllChannels: vi.fn(removeAll),
});

// Renders once and runs the bootstrap effect (the one with no dependencies).
function boot() {
  R.i = 0;
  R.effects = [];
  TelegramProvider({ children: null });
  R.effects.find((e) => e.deps?.length === 0)!.fn();
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const logged = () =>
  [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls]
    .flat()
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");

function stubStorage(values: Record<string, string>) {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => values[k] ?? null,
    setItem: () => {},
    removeItem: () => {},
  });
}

beforeEach(() => {
  R.slots = [];
  H.jwtRef.current = null;
  H.clients = [fakeClient(async () => [])];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TelegramProvider logs a failed user load", () => {
  it("Mini App: a refused registration is logged with its status, never the initData", async () => {
    H.fetchToken = async () => "fresh.jwt";
    stubStorage({});
    vi.stubGlobal("window", {
      Telegram: {
        WebApp: {
          initData: INIT_DATA,
          initDataUnsafe: { user: { id: 1, first_name: "A", language_code: "en" } },
          ready: () => {},
          expand: () => {},
          onEvent: () => {},
          offEvent: () => {},
        },
      },
      location: { pathname: "/" },
    });
    const f = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "Failed to register user" }) }));
    vi.stubGlobal("fetch", f);

    boot();
    await settle();

    expect(f).toHaveBeenCalledWith("/api/user", { method: "POST", headers: { "x-telegram-init-data": INIT_DATA } });
    expect(console.error).toHaveBeenCalledWith("[TelegramProvider] User registration failed:", { status: 500 });
    expect(logged()).not.toContain("secret-hash");
  });

  it("web app: a refused user load is logged with its status, never the token", async () => {
    H.fetchToken = async () => "fresh.jwt";
    stubStorage({ web_auth_token: "stored.jwt" });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("document", { documentElement: { classList: { add: () => {}, remove: () => {} } } });
    const f = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    vi.stubGlobal("fetch", f);

    boot();
    await settle();

    expect(f).toHaveBeenCalledWith("/api/user", { headers: { Authorization: "Bearer fresh.jwt" } });
    expect(console.error).toHaveBeenCalledWith("[TelegramProvider] Web user load failed:", { status: 503 });
    expect(logged()).not.toContain("fresh.jwt");
    expect(logged()).not.toContain("stored.jwt");
  });
});

describe("TelegramProvider logs a failed cleanup of the old client's channels", () => {
  it("warns with the answers that were not ok when the client is recreated", async () => {
    const first = fakeClient(async () => ["ok", "timed out"]);
    H.clients = [first, fakeClient(async () => [])];
    R.i = 0;
    TelegramProvider({ children: null });
    const recreate = H.orchestratorParams!.recreateSupabaseClient;

    recreate("t1");
    recreate("t2");
    await settle();

    expect(first.realtime.disconnect).toHaveBeenCalled();
    expect(first.removeAllChannels).toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("[Realtime] Remove all channels failed:", { total: 2 }, ["timed out"]);
  });
});
```

Create `__tests__/unit/home-fetch-lists.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";

// Calls the real home page component as a plain function with slot-based stand-ins for
// React's hooks (state and refs persist; effects are recorded, and the test runs only the
// one that registers fetchLists with the reconnect orchestrator). Children are stubbed.
type Effect = { fn: () => void | (() => void); deps?: unknown[] };
const R = vi.hoisted(() => ({ slots: [] as { value: unknown }[], effects: [] as Effect[], i: 0 }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: typeof init === "function" ? (init as () => unknown)() : init };
    const slot = R.slots[i];
    const set = (u: unknown) => { slot.value = typeof u === "function" ? (u as (p: unknown) => unknown)(slot.value) : u; };
    return [slot.value, set];
  },
  useRef: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: { current: init } };
    return R.slots[i].value;
  },
  useCallback: (fn: unknown) => (R.i++, fn),
  useMemo: (fn: () => unknown) => (R.i++, fn()),
  useEffect: (fn: Effect["fn"], deps?: unknown[]) => {
    R.i++;
    R.effects.push({ fn, deps });
  },
}));

const T = vi.hoisted(() => ({
  jwtRef: { current: "jwt" as string | null },
  onRefreshNeededRef: { current: null as null | ((opts?: { silent?: boolean }) => Promise<void>) },
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key, useLocale: () => "en" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/components/TelegramProvider", () => ({
  default: ({ children }: { children: unknown }) => children,
  useTelegram: () => ({
    isReady: true,
    locale: "en",
    setLanguage: async () => true,
    jwtRef: T.jwtRef,
    onRefreshNeededRef: T.onRefreshNeededRef,
    homeScreenStatus: null,
    addToHomeScreen: () => {},
  }),
}));
vi.mock("@/src/hooks/useListsDragDrop", () => ({
  useListsDragDrop: () => ({ handleDragStart: () => {}, handleDragEnd: () => {}, shouldSuppressClick: () => false }),
}));
vi.mock("@dnd-kit/react", () => ({ DragDropProvider: () => null }));
vi.mock("@/components/ListCard", () => ({ default: () => null }));
vi.mock("@/components/SortableListCard", () => ({ default: () => null }));
vi.mock("@/components/EmptyState", () => ({ default: () => null }));
vi.mock("@/components/OfflineIndicator", () => ({ default: () => null }));
vi.mock("@/components/IconColorPicker", () => ({ default: () => null }));

import HomePage from "@/app/page";

type El = ReactElement<Record<string, unknown> & { children?: unknown }>;
const HomeContent = (HomePage() as El).props.children as El;
const Content = HomeContent.type as () => El;

const render = () => {
  R.i = 0;
  R.effects = [];
  return Content();
};
// Runs the effect that hands fetchLists to the orchestrator, and returns fetchLists.
function fetchLists() {
  render();
  R.effects.find((e) => e.deps?.includes(T.onRefreshNeededRef))!.fn();
  return T.onRefreshNeededRef.current!;
}
const text = (node: unknown): string =>
  Array.isArray(node)
    ? node.map(text).join(" ")
    : node && typeof node === "object" && "props" in node
      ? text((node as El).props.children)
      : typeof node === "string" ? node : "";

const reply = (status: number, body: unknown = { error: "Server error" }) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
  R.slots = [];
  T.onRefreshNeededRef.current = null;
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("home fetchLists logs a refused load", () => {
  it("logs the status and shows the Retry screen", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(500)));
    await fetchLists()();
    expect(console.warn).toHaveBeenCalledWith("[Home] Load lists failed:", { view: "active", silent: false, status: 500 });
    expect(text(render())).toContain("lists.loadError");
  });

  it("a silent resync logs the status and keeps the lists on screen", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(200, [{ id: "a", name: "A" }, { id: "b", name: "B" }])));
    await fetchLists()();
    vi.stubGlobal("fetch", vi.fn(async () => reply(503)));
    await fetchLists()({ silent: true });
    expect(console.warn).toHaveBeenCalledWith("[Home] Load lists failed:", { view: "active", silent: true, status: 503 });
    expect(text(render())).not.toContain("lists.loadError");
  });

  it("an answer that a newer load overtook is dropped without a log", async () => {
    const pending: ((r: unknown) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => pending.push(resolve))));
    const load = fetchLists();
    const first = load({ silent: true });
    const second = load({ silent: true });
    pending[0](reply(500));
    await first;
    expect(console.warn).not.toHaveBeenCalled();
    pending[1](reply(502));
    await second;
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith("[Home] Load lists failed:", { view: "active", silent: true, status: 502 });
  });
});
```

Modify `__tests__/unit/list-data-categories.test.ts`. The new tests assert on `console.warn`, and the existing "an error response changes nothing" test now warns too. Replace the `beforeEach`:

```ts
beforeEach(() => {
  R.slots = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});
```

with:

```ts
beforeEach(() => {
  R.slots = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
```

Then append this block at the end of the file. It reuses the file's `render`, `jwtRef`, `dairy` and React stub:

```ts
// A failed read is logged with its status. Only a failed list lookup changes the screen:
// without the list's details the header is blank and a grocery list opens as a regular one,
// so it shows the Retry screen instead.
describe("useListData failed reads", () => {
  type Reply = number | unknown;
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  const fail = (status: number) => ({ ok: false, status, json: async () => ({ error: "Server error" }) });
  const groceries = { id: "L", name: "Groceries", type: "grocery" };
  const milk = { id: "a", text: "milk", completed: false, completed_at: null, deleted_at: null, skipped_at: null, ordered_at: null, recurring: false, position: 1, category_id: null };

  // Each route answers with a body (200) or a bare status number (an error response).
  function stubRoutes(routes: { lists?: Reply; archived?: Reply; items?: Reply; categories?: Reply; patch?: Reply }) {
    const reply = (r: Reply) => (typeof r === "number" ? fail(r) : ok(r));
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && url === "/api/lists/L/items") return reply(routes.patch ?? { ok: true });
      if (url === "/api/lists") return reply(routes.lists ?? [groceries]);
      if (url === "/api/lists?archived=1") return reply(routes.archived ?? []);
      if (url.startsWith("/api/lists/L/items")) return reply(routes.items ?? { items: [milk] });
      if (url === "/api/lists/L/categories") return reply(routes.categories ?? { categories: [] });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", f);
    return f;
  }
  const urls = (f: ReturnType<typeof stubRoutes>) => f.mock.calls.map(([url]) => url);

  it("a failed list lookup shows the Retry screen and never loads the items", async () => {
    const f = stubRoutes({ lists: 500 });
    await render().fetchItems();
    const state = render();
    expect(state.error).toBe(true);
    expect(state.loading).toBe(false);
    expect(state.listName).toBe("");
    expect(urls(f)).toEqual(["/api/lists"]);
    expect(console.error).toHaveBeenCalledWith("[List] Fetch error:", expect.objectContaining({ message: "Load lists failed: 500" }));
  });

  it("a failed archived lookup shows the Retry screen too", async () => {
    const f = stubRoutes({ lists: [], archived: 503 });
    await render().fetchItems();
    expect(render().error).toBe(true);
    expect(urls(f)).toEqual(["/api/lists", "/api/lists?archived=1"]);
    expect(console.error).toHaveBeenCalledWith("[List] Fetch error:", expect.objectContaining({ message: "Load lists failed: 503" }));
  });

  it("a list missing from a good answer is still looked up among the archived lists", async () => {
    const f = stubRoutes({ lists: [{ id: "other", name: "Other" }], archived: [groceries] });
    await render().fetchItems();
    const state = render();
    expect(state.error).toBe(false);
    expect(state.listName).toBe("Groceries");
    expect(state.listType).toBe("grocery");
    expect(state.items.map((i) => i.id)).toEqual(["a"]);
    expect(urls(f)).toContain("/api/lists/L/categories");
  });

  it("a failed items load is logged with its status and shows the Retry screen", async () => {
    stubRoutes({ items: 500 });
    await render().fetchItems();
    expect(render().error).toBe(true);
    expect(console.warn).toHaveBeenCalledWith("[List] Load items failed:", { listId: "L", status: 500 });
  });

  it("a failed categories load is logged with its status and changes nothing", async () => {
    stubRoutes({ categories: { categories: [dairy] } });
    await render().fetchItems();
    stubRoutes({ categories: 500 });
    await render().loadCategories();
    expect(render().categories.map((c) => c.id)).toEqual(["dairy"]);
    expect(console.warn).toHaveBeenCalledWith("[List] Categories load failed:", { listId: "L", status: 500 });
  });

  it("a failed background refresh is logged with its status and keeps the items", async () => {
    stubRoutes({});
    await render().fetchItems();
    stubRoutes({ items: 502 });
    await expect(render().refreshItems()).resolves.toBeUndefined();
    expect(render().items.map((i) => i.id)).toEqual(["a"]);
    expect(console.warn).toHaveBeenCalledWith("[List] Background refresh failed:", { listId: "L", status: 502 });
  });

  it("a failed Sorting retry is logged with its status and asks for nothing else", async () => {
    stubRoutes({});
    await render().fetchItems();
    const f = stubRoutes({ items: 500 });
    await render().retrySorting();
    expect(urls(f)).toEqual(["/api/lists/L/items?limit=500"]);
    expect(console.warn).toHaveBeenCalledWith("[List] Sorting retry failed:", { listId: "L", status: 500 });
  });

  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const fiveHoursAgo = () => new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();

  it("an auto-unskip the server refuses is logged with its status", async () => {
    stubRoutes({ items: { items: [{ ...milk, skipped_at: fiveHoursAgo() }] }, patch: 500 });
    await render().fetchItems();
    await settle();
    expect(render().items[0].skipped_at).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      "[List] Auto-unskip PATCH failed for item a in list L:",
      expect.objectContaining({ message: "Auto-unskip failed: 500" })
    );
  });

  it("an auto-respawn the server refuses is logged with its status", async () => {
    stubRoutes({ items: { items: [{ ...milk, recurring: true, completed: true, completed_at: fiveHoursAgo() }] }, patch: 500 });
    await render().fetchItems();
    await settle();
    expect(render().items[0].completed).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(
      "[List] Auto-respawn PATCH failed for item a in list L:",
      expect.objectContaining({ message: "Auto-respawn failed: 500" })
    );
  });

  it("logs nothing when every read succeeds", async () => {
    stubRoutes({ items: { items: [{ ...milk, skipped_at: fiveHoursAgo() }] } });
    await render().fetchItems();
    await render().refreshItems();
    await render().retrySorting();
    await settle();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run:

```bash
npx vitest run __tests__/unit/realtime-cleanup.test.ts __tests__/unit/jwt-refresh-logging.test.ts __tests__/unit/telegram-provider-bootstrap.test.ts __tests__/unit/home-fetch-lists.test.ts __tests__/unit/list-data-categories.test.ts
```

Expected:
- `realtime-cleanup.test.ts` fails to load, because `@/src/lib/realtime-cleanup` does not exist yet.
- `telegram-provider-bootstrap.test.ts` fails to load for the same reason. If you create the helper first, the cleanup test fails instead, because the warn is never called (the bare `removeAllChannels` result is dropped).
- `jwt-refresh-logging`: 2 fail, both "expected warn to be called" on the bearer and initData cases. The "says yes" and "neither" cases pass.
- `home-fetch-lists`: all 3 fail. Nothing is warned today.
- `list-data-categories`:
  - 8 of the new tests fail. The two lookup tests fail because `error` stays false and the items URL is requested.
  - The warn tests fail because there is no warn.
  - The auto-unskip and auto-respawn tests fail because no warn is called: a 500 resolves, so the `.catch` never runs.
  - "still looked up among the archived lists" and "logs nothing when every read succeeds" already pass. They pin behaviour that must not change.
  - All 14 old tests pass.

- [ ] **Step 3: Implementation**

**3a. Create `src/lib/realtime-cleanup.ts`:**

```ts
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

type RemoveResult = "ok" | "timed out" | "error";

/**
 * Removes a realtime channel without waiting for it. Supabase answers "ok", "timed out" or
 * "error" instead of throwing, and a channel that did not answer "ok" stays subscribed, so
 * anything but "ok" is logged with `context` (IDs and why it was removed, never a token).
 */
export function removeChannelLogged(
  client: SupabaseClient,
  channel: RealtimeChannel,
  context: Record<string, unknown>
): void {
  client.removeChannel(channel).then(
    (result: RemoveResult) => {
      if (result !== "ok") console.warn("[Realtime] Remove channel failed:", context, result);
    },
    (err) => console.warn("[Realtime] Remove channel failed:", context, err)
  );
}

/** Removes every channel of a client without waiting, logging the answers that were not "ok". */
export function removeAllChannelsLogged(client: SupabaseClient): void {
  client.removeAllChannels().then(
    (results: RemoveResult[]) => {
      const failed = results.filter((r) => r !== "ok");
      if (failed.length > 0) {
        console.warn("[Realtime] Remove all channels failed:", { total: results.length }, failed);
      }
    },
    (err) => console.warn("[Realtime] Remove all channels failed:", err)
  );
}
```

**3b. `src/hooks/useListData.ts`.**

Imports. Current:

```ts
import { sortCategories } from "@/src/utils/category-state";
```

Replace with:

```ts
import { sortCategories } from "@/src/utils/category-state";
import { throwIfNotOk } from "@/src/utils/http";
```

`loadCategories` comment. Current:

```ts
  // The list works without categories (items show under "Sorting…"), so a failed request
  // is only logged: it must never turn into the list's error screen.
```

Replace with:

```ts
  // The list works without categories (items show under "Sorting…"), so a failed request
  // (an error status or no answer at all) is only logged: it must never turn into the
  // list's error screen.
```

`loadCategories` non-ok. Current:

```ts
      if (res.ok) {
        const { categories: fetched } = await res.json();
        setCategories(sortCategories(fetched ?? []));
      }
```

Replace with:

```ts
      if (res.ok) {
        const { categories: fetched } = await res.json();
        setCategories(sortCategories(fetched ?? []));
      } else {
        console.warn("[List] Categories load failed:", { listId, status: res.status });
      }
```

`findList`. Current:

```ts
        if (!res.ok) return undefined;
        const all: ListSummary[] = await res.json();
```

Replace with:

```ts
        // A failed lookup throws to the Retry screen below: without the list's details the
        // header is blank and a grocery list would open as a regular one.
        throwIfNotOk(res, "Load lists");
        const all: ListSummary[] = await res.json();
```

The archived-fallback comment and the `??` chain stay as they are. A 200 without the list still returns `undefined` from `all.find`, so the archived lookup still runs.

Auto-unskip. Current:

```ts
              body: JSON.stringify({ itemId: base.id, skipped: false }),
            }).catch((err) => {
              console.warn(`[List] Auto-unskip PATCH failed for item ${base.id} in list ${listId}:`, err);
            });
```

Replace with:

```ts
              body: JSON.stringify({ itemId: base.id, skipped: false }),
            })
              .then((res) => throwIfNotOk(res, "Auto-unskip"))
              .catch((err) => {
                console.warn(`[List] Auto-unskip PATCH failed for item ${base.id} in list ${listId}:`, err);
              });
```

Auto-respawn. Current:

```ts
              body: JSON.stringify({ itemId: base.id, restoreRecurring: true }),
            }).catch((err) => {
              console.warn(`[List] Auto-respawn PATCH failed for item ${base.id} in list ${listId}:`, err);
            });
```

Replace with:

```ts
              body: JSON.stringify({ itemId: base.id, restoreRecurring: true }),
            })
              .then((res) => throwIfNotOk(res, "Auto-respawn"))
              .catch((err) => {
                console.warn(`[List] Auto-respawn PATCH failed for item ${base.id} in list ${listId}:`, err);
              });
```

`fetchItems` items non-ok. Current:

```ts
        if (currentListType === "grocery") await loadCategories();
      } else {
        setError(true);
      }
```

Replace with:

```ts
        if (currentListType === "grocery") await loadCategories();
      } else {
        console.warn("[List] Load items failed:", { listId, status: res.status });
        setError(true);
      }
```

`refreshItems`. Current:

```ts
      if (!res.ok) return;
      const { items: fetchedItems } = await res.json();
```

Replace with:

```ts
      if (!res.ok) {
        console.warn("[List] Background refresh failed:", { listId, status: res.status });
        return;
      }
      const { items: fetchedItems } = await res.json();
```

`retrySorting`. Current:

```ts
      if (!res.ok) return;
      const { items: fetched } = await res.json();
```

Replace with:

```ts
      if (!res.ok) {
        console.warn("[List] Sorting retry failed:", { listId, status: res.status });
        return;
      }
      const { items: fetched } = await res.json();
```

The three item GETs keep their exact `fetch(\`/api/lists/${listId}/items${ITEMS_URL_SUFFIX}\`, {\n headers` shape, so `search-completed-items.test.ts` ("every item GET … with the 500 limit", which counts 3) stays green.

**3c. `src/hooks/useRealtimeList.ts`.**

Imports. Current:

```ts
import type { RealtimeChange } from "@/src/types";
```

Replace with:

```ts
import type { RealtimeChange } from "@/src/types";
import { removeChannelLogged } from "@/src/lib/realtime-cleanup";
```

Resubscribe timeout. Current:

```ts
        // Clean up the failed channel to prevent orphaned subscriptions
        client.removeChannel(channel);
```

Replace with:

```ts
        // Clean up the failed channel to prevent orphaned subscriptions
        removeChannelLogged(client, channel, { listId, reason: "resubscribe timed out" });
```

Resubscribe error branch. Current:

```ts
          clearTimeout(timeout);
          client.removeChannel(channel);
          reject(new Error(`Channel subscribe failed: ${status}`));
```

Replace with:

```ts
          clearTimeout(timeout);
          removeChannelLogged(client, channel, { listId, reason: `resubscribe ${status}` });
          reject(new Error(`Channel subscribe failed: ${status}`));
```

Replace channel. Current:

```ts
      // Clean up any existing channel
      if (channelRef.current) {
        supabaseClient.removeChannel(channelRef.current);
        channelRef.current = null;
      }
```

Replace with:

```ts
      // Clean up any existing channel
      const stale = channelRef.current;
      if (stale) {
        channelRef.current = null;
        removeChannelLogged(supabaseClient, stale, { listId, reason: "replaced" });
      }
```

Effect cleanup. Current:

```ts
    return () => {
      if (channelRef.current) {
        // Use the ref client since supabaseClient from closure may be stale
        const client = clientRefForCleanup.current;
        if (client) {
          client.removeChannel(channelRef.current);
        }
        channelRef.current = null;
      }
    };
```

Replace with:

```ts
    return () => {
      const channel = channelRef.current;
      if (channel) {
        channelRef.current = null;
        // Use the ref client since supabaseClient from closure may be stale
        const client = clientRefForCleanup.current;
        if (client) {
          removeChannelLogged(client, channel, { listId, reason: "cleanup" });
        }
      }
    };
```

`realtime-subscribe-logging.test.ts` slices the source after `channel.subscribe((status` and checks that the warn comes before `if (settled) return;`. Both are untouched, so it stays green.

**3d. `src/hooks/useJWTRefresh.ts`.** Current:

```ts
        const headers: Record<string, string> = {};
        if (jwtRef.current) {
          headers["Authorization"] = `Bearer ${jwtRef.current}`;
        } else if (initDataStr) {
          headers["x-telegram-init-data"] = initDataStr;
        } else {
          return null;
        }

        const res = await fetch("/api/auth/token", { headers });
        if (!res.ok) return null;
```

Replace with:

```ts
        const headers: Record<string, string> = {};
        let mode: "bearer" | "initData";
        if (jwtRef.current) {
          headers["Authorization"] = `Bearer ${jwtRef.current}`;
          mode = "bearer";
        } else if (initDataStr) {
          headers["x-telegram-init-data"] = initDataStr;
          mode = "initData";
        } else {
          return null;
        }

        const res = await fetch("/api/auth/token", { headers });
        if (!res.ok) {
          // The mode and status only: the token and initData are credentials.
          console.warn("[TelegramProvider] Token request failed:", { mode, status: res.status });
          return null;
        }
```

**3e. `components/TelegramProvider.tsx`.** Task 7 will already have changed the `setLanguage` type in `TelegramContextType` and the default context. Leave those alone.

Imports. Current:

```ts
import { createBrowserClient } from "@/src/lib/supabase";
```

Replace with:

```ts
import { createBrowserClient } from "@/src/lib/supabase";
import { removeAllChannelsLogged } from "@/src/lib/realtime-cleanup";
```

`recreateSupabaseClient`. Current:

```ts
        oldClient.realtime.disconnect();
        oldClient.removeAllChannels();
```

Replace with:

```ts
        oldClient.realtime.disconnect();
        removeAllChannelsLogged(oldClient);
```

After a disconnect, realtime-js resolves each leave as "ok" without a round trip (`RealtimeChannel.unsubscribe`: `if (!this._canPush()) leavePush.trigger('ok')`), so this logs only a real failure, not every token refresh.

Web user load. Current:

```ts
                username: userData.username,
              });
            }
          }
        } catch (e) {
          console.error("[TelegramProvider] Web user registration error:", e);
```

Replace with:

```ts
                username: userData.username,
              });
            }
          } else {
            console.error("[TelegramProvider] Web user load failed:", { status: userRes.status });
          }
        } catch (e) {
          console.error("[TelegramProvider] Web user registration error:", e);
```

Mini App registration. Current:

```ts
            // normalized to "en" by resolveLocale and clobber the user's explicit choice.
          }
        } catch (e) {
          console.error("[TelegramProvider] User registration error:", e);
```

Replace with:

```ts
            // normalized to "en" by resolveLocale and clobber the user's explicit choice.
          } else {
            console.error("[TelegramProvider] User registration failed:", { status: userRes.status });
          }
        } catch (e) {
          console.error("[TelegramProvider] User registration error:", e);
```

**3f. `app/page.tsx` `fetchLists`.** Task 7 does not edit this function. Current:

```ts
      } else if (!silent) {
        setError(true);
      }
    } catch (e) {
      console.error("[Home] Fetch lists error:", e);
```

Replace with:

```ts
      } else {
        console.warn("[Home] Load lists failed:", { view: requestedView, silent, status: res.status });
        if (!silent) setError(true);
      }
    } catch (e) {
      console.error("[Home] Fetch lists error:", e);
```

This `else` belongs to `if (res.ok)`, which runs only after `if (gen !== fetchGenRef.current) return;`, so a stale response is still dropped without a log.

- [ ] **Step 4: Existing tests and mocks**

No existing mock has to change. These were checked against the sandbox run:
- `list-data-categories.test.ts`: its `json()` helper already answers `ok: true` for `/api/lists`. The only edit is the warn spy from Step 1.
- `search-completed-items.test.ts`: still counts 3 item GETs.
- `realtime-subscribe-logging.test.ts` and `category-realtime-wiring.test.ts`: the anchors they check are unchanged.
- `user-update.test.ts` ("TelegramProvider never reads the device time zone"): nothing about the time zone is added.
- `list-type-switch.test.ts` and `grouped-list-wiring.test.ts`: they stub `useListData` and `TelegramProvider` wholesale.
- `no-silent-catches.test.ts`: every new `.then(ok, fn)` and `.catch` logs its error parameter.

If a test fails here, fix the test's fixture. Never remove a new check.

- [ ] **Step 5: Run tests, typecheck and lint, expected PASS**

```bash
npx vitest run __tests__/unit/realtime-cleanup.test.ts __tests__/unit/jwt-refresh-logging.test.ts __tests__/unit/telegram-provider-bootstrap.test.ts __tests__/unit/home-fetch-lists.test.ts __tests__/unit/list-data-categories.test.ts __tests__/unit/realtime-subscribe-logging.test.ts __tests__/unit/category-realtime-wiring.test.ts __tests__/unit/search-completed-items.test.ts __tests__/unit/user-update.test.ts __tests__/unit/no-silent-catches.test.ts __tests__/unit/reminders-ui-removed.test.ts
npx vitest run
npx tsc --noEmit
npx eslint src/lib/realtime-cleanup.ts src/hooks/useRealtimeList.ts src/hooks/useListData.ts src/hooks/useJWTRefresh.ts components/TelegramProvider.tsx app/page.tsx __tests__/unit/realtime-cleanup.test.ts __tests__/unit/list-data-categories.test.ts __tests__/unit/jwt-refresh-logging.test.ts __tests__/unit/telegram-provider-bootstrap.test.ts __tests__/unit/home-fetch-lists.test.ts
```

Expected: all green, tsc silent, eslint 0 problems. In a sandbox copy with a stand-in `src/utils/http.ts`, the full suite passed (76 files, 592 tests) and tsc and eslint were clean. `realtime-cleanup.test.ts` and `jwt-refresh-logging.test.ts` need their `react-hooks/rules-of-hooks` disable line. The provider and home tests must not carry one, or eslint warns that the directive is unused.

- [ ] **Step 6: Make it bite**

Make one change at a time, run the named test, see it go red, then restore the line. All 21 were confirmed red in the sandbox.

| remove or alter | test that must go red |
|---|---|
| `useListData.ts`: `throwIfNotOk(res, "Load lists");` → `if (!res.ok) return undefined;` | `list-data-categories` (2 red: both lookup tests) |
| `useListData.ts`: delete `console.warn("[List] Load items failed:", …)` | `list-data-categories` "a failed items load …" |
| `useListData.ts`: delete `console.warn("[List] Categories load failed:", …)` | `list-data-categories` "a failed categories load …" |
| `useListData.ts`: delete `console.warn("[List] Background refresh failed:", …)` | `list-data-categories` "a failed background refresh …" |
| `useListData.ts`: delete `console.warn("[List] Sorting retry failed:", …)` | `list-data-categories` "a failed Sorting retry …" |
| `useListData.ts`: delete `.then((res) => throwIfNotOk(res, "Auto-unskip"))` | `list-data-categories` "an auto-unskip the server refuses …" |
| `useListData.ts`: delete `.then((res) => throwIfNotOk(res, "Auto-respawn"))` | `list-data-categories` "an auto-respawn the server refuses …" |
| `useJWTRefresh.ts`: delete the `Token request failed` warn | `jwt-refresh-logging` (2 red) |
| `TelegramProvider.tsx`: delete the `Web user load failed` error | `telegram-provider-bootstrap` "web app …" |
| `TelegramProvider.tsx`: delete the `User registration failed` error | `telegram-provider-bootstrap` "Mini App …" |
| `TelegramProvider.tsx`: `removeAllChannelsLogged(oldClient);` → `oldClient.removeAllChannels();` | `telegram-provider-bootstrap` (cleanup case) **and** `realtime-cleanup` (guard) |
| `app/page.tsx`: delete the `[Home] Load lists failed:` warn | `home-fetch-lists` (3 red) |
| `useRealtimeList.ts`: each of the 4 `removeChannelLogged(...)` → bare `client.removeChannel(channel)` / `supabaseClient.removeChannel(stale)` (one at a time) | `realtime-cleanup` (2 red each: that path's hook test + the guard) |
| `realtime-cleanup.ts`: delete `if (result !== "ok") console.warn(...)` | `realtime-cleanup` (5 red) |
| `realtime-cleanup.ts`: removeChannel rejection handler → `() => {}` | `realtime-cleanup` (2 red; also turns `no-silent-catches` red) |
| `realtime-cleanup.ts`: `if (failed.length > 0) {` → `if (false) {` | `realtime-cleanup` "warns with the answers that were not ok" |
| `realtime-cleanup.ts`: removeAllChannels rejection handler → `() => {}` | `realtime-cleanup` "removeAllChannelsLogged … rejects" |

Command per row: `npx vitest run __tests__/unit/<name>.test.ts`. Restore the line after each run, then rerun the Step 5 commands once at the end.

- [ ] **Step 7: Commit**

```bash
git add src/lib/realtime-cleanup.ts src/hooks/useListData.ts src/hooks/useRealtimeList.ts src/hooks/useJWTRefresh.ts components/TelegramProvider.tsx app/page.tsx __tests__/unit/realtime-cleanup.test.ts __tests__/unit/jwt-refresh-logging.test.ts __tests__/unit/telegram-provider-bootstrap.test.ts __tests__/unit/home-fetch-lists.test.ts __tests__/unit/list-data-categories.test.ts
git commit -m "$(cat <<'MSG'
fix(client): log failed reads and channel removal; a failed list lookup shows Retry

Opening a list when /api/lists fails now shows the existing Retry screen
instead of a header-less list where a grocery list opens as regular.
Every other client read (list loads, categories, refresh, Sorting retry,
auto-unskip/respawn, token, user load) only gains a status log line.
Realtime channel removal goes through removeChannelLogged /
removeAllChannelsLogged, which log Supabase's "error"/"timed out"
answer; a guard test keeps bare calls out.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
MSG
)"
```
