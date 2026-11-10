import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AnyMock } from "../helpers/mock-fn";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

// A quantity said by voice lands in items.quantity on a grocery list only. On any other list the
// amount stays in the name, as it was before quantities existed. Same harness as
// voice-handler-failures.test.ts: the real handleVoiceMessage and real messages, with Gemini, Redis,
// the recycler, Telegram and the database faked.
const h = vi.hoisted(() => ({
  sent: [] as { chatId: number; text: string }[],
  db: null as null | { client: unknown; calls: unknown[] },
  process: null as null | AnyMock,
  fuzzy: null as null | AnyMock,
  recycle: null as null | AnyMock,
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

type Item = { action: "add" | "remove"; text: string; targetList: string | null; quantity: string | null };
const ok = (data: unknown): FakeResult => ({ data, error: null });

// One grocery list and one regular list, nothing archived, items at position 3.
function world() {
  return fakeSupabase((call: FakeCall) => {
    if (call.table === "users") return ok({ id: "u1", language: "en" });
    if (call.table === "lists") {
      return ok([
        { id: "G1", name: "Groceries", type: "grocery" },
        { id: "R1", name: "Home", type: "regular" },
      ]);
    }
    if (call.table === "collaborators") return ok([]);
    if (call.table === "user_list_state") return ok([]);
    if (call.table === "items" && call.op === "select" && call.cols === "position") return ok([{ position: 3 }]);
    if (call.table === "items" && call.op === "insert") return ok({ id: "new-item" });
    throw new Error(`unexpected call ${call.table} ${call.op}`);
  });
}

const inserts = () => (h.db!.calls as FakeCall[]).filter((c) => c.table === "items" && c.op === "insert");
const oldMilk = { id: "old-milk", text: "milk", completed: true, completed_at: null, deleted_at: null, position: 1 };

async function speak(items: Item[]) {
  h.process!.mockResolvedValue({ items });
  await handleVoiceMessage(42, 7, { file_id: "f1", file_unique_id: "u-f1", duration: 3 }, { id: 7, first_name: "A", language_code: "en" });
}

beforeEach(() => {
  h.sent = [];
  h.db = world();
  h.process = vi.fn();
  h.fuzzy = vi.fn().mockResolvedValue([]);
  h.recycle = vi.fn().mockResolvedValue(oldMilk);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("voice: quantity on a grocery list", () => {
  it("a new item is inserted with its quantity and receipted as 'name, quantity'", async () => {
    await speak([{ action: "add", text: "milk", targetList: "Groceries", quantity: "2 L" }]);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].values).toMatchObject({ list_id: "G1", text: "milk", quantity: "2 L" });
    expect(h.sent.map((m) => m.text)).toEqual(["Added to Groceries:\n- milk, 2 L"]);
  });

  it("an item with no quantity is inserted without a quantity key", async () => {
    await speak([{ action: "add", text: "milk", targetList: "Groceries", quantity: null }]);
    expect("quantity" in (inserts()[0].values as object)).toBe(false);
    expect(h.sent.map((m) => m.text)).toEqual(["Added to Groceries:\n- milk"]);
  });

  it("a fuzzy recycle hands recycleItem the quantity and receipts it", async () => {
    h.fuzzy!.mockResolvedValue([oldMilk]);
    await speak([{ action: "add", text: "milk", targetList: "Groceries", quantity: "2 L" }]);
    expect(h.recycle).toHaveBeenCalledWith("old-milk", "u1", "G1", "milk", { quantity: "2 L" });
    expect(h.sent.map((m) => m.text)).toEqual(["Added to Groceries:\n- milk, 2 L (recycled)"]);
    expect(inserts()).toEqual([]);
  });

  it("the best of several fuzzy matches is recycled with the quantity too", async () => {
    h.fuzzy!.mockResolvedValue([oldMilk, { ...oldMilk, id: "other", text: "oat milk" }]);
    await speak([{ action: "add", text: "milk", targetList: "Groceries", quantity: "2 L" }]);
    expect(h.recycle).toHaveBeenCalledWith("old-milk", "u1", "G1", "milk", { quantity: "2 L" });
    expect(h.sent.map((m) => m.text)).toEqual(["Added to Groceries:\n- milk, 2 L (recycled)"]);
  });

  it("a fuzzy recycle with no quantity passes no options, so the old quantity is kept", async () => {
    h.fuzzy!.mockResolvedValue([oldMilk]);
    await speak([{ action: "add", text: "milk", targetList: "Groceries", quantity: null }]);
    expect(h.recycle).toHaveBeenCalledOnce();
    expect(h.recycle!.mock.calls[0][4]).toBeUndefined();
    expect(h.sent.map((m) => m.text)).toEqual(["Added to Groceries:\n- milk (recycled)"]);
  });
});

describe("voice: quantity on a regular list", () => {
  it("the amount stays in the name and no quantity column is written", async () => {
    await speak([{ action: "add", text: "milk", targetList: "Home", quantity: "2 L" }]);
    expect(inserts()[0].values).toMatchObject({ list_id: "R1", text: "milk 2 L" });
    expect("quantity" in (inserts()[0].values as object)).toBe(false);
    expect(h.sent.map((m) => m.text)).toEqual(["Added to Home:\n- milk 2 L"]);
  });

  it("a fuzzy recycle passes no quantity, and looks the match up by the folded name", async () => {
    h.fuzzy!.mockResolvedValue([{ ...oldMilk, text: "milk 2 L" }]);
    await speak([{ action: "add", text: "milk", targetList: "Home", quantity: "2 L" }]);
    expect(h.fuzzy).toHaveBeenCalledWith("R1", "milk 2 L");
    expect(h.recycle).toHaveBeenCalledWith("old-milk", "u1", "R1", "milk 2 L", undefined);
  });
});
