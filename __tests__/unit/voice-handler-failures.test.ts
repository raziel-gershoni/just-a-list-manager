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
