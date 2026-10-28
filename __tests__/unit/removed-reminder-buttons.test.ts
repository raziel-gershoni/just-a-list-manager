import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type TelegramBot from "node-telegram-bot-api";
import en from "@/messages/en.json";
import he from "@/messages/he.json";
import ru from "@/messages/ru.json";

// Runs the real handleCallbackQuery; the Telegram client, env and Supabase are faked.
// Reminders are gone, but old reminder messages still sit in users' chats and
// their Done / Snooze / snooze-option buttons keep posting reminder_* callbacks.
const h = vi.hoisted(() => ({
  userRow: { language: "he" } as { language: string | null } | null,
  userError: null as { message: string } | null,
  reads: [] as { table: string; columns: string; filters: string[] }[],
  writes: [] as { table: string; op: string }[],
  answers: [] as { id: string; options: unknown }[],
  markupEdits: [] as { markup: unknown; options: unknown }[],
  textEdits: [] as { text: string; options: unknown }[],
  sends: [] as { chatId: number; text: string }[],
  answerError: null as Error | null,
  markupError: null as Error | null,
}));

interface SelectChain {
  eq(column: string, value: unknown): SelectChain;
  single(): Promise<{ data: unknown; error: unknown }>;
  maybeSingle(): Promise<{ data: unknown; error: unknown }>;
}

vi.mock("@/src/lib/env", () => ({
  serverEnv: () => ({ TELEGRAM_BOT_TOKEN: "test-token", NEXT_PUBLIC_APP_URL: "https://app.test" }),
}));

vi.mock("node-telegram-bot-api", () => ({
  default: class FakeTelegramBot {
    onText(): void {
      // bot.ts registers /start and /help here; not exercised by these tests.
    }
    async answerCallbackQuery(id: string, options?: unknown) {
      h.answers.push({ id, options });
      if (h.answerError) throw h.answerError;
      return true;
    }
    async editMessageReplyMarkup(markup: unknown, options?: unknown) {
      h.markupEdits.push({ markup, options });
      if (h.markupError) throw h.markupError;
      return true;
    }
    async editMessageText(text: string, options?: unknown) {
      h.textEdits.push({ text, options });
      return true;
    }
    async sendMessage(chatId: number, text: string) {
      h.sends.push({ chatId, text });
      return {};
    }
  },
}));

vi.mock("@/src/lib/supabase", () => ({
  createServerClient: () => ({
    from: (table: string) => {
      // Any write fails the test: it is recorded AND throws, so a write wrapped
      // in try/catch still shows up in h.writes.
      const refuseWrite = (op: string) => () => {
        h.writes.push({ table, op });
        throw new Error(`unexpected ${op} on ${table}`);
      };
      return {
        select: (columns: string): SelectChain => {
          const rec = { table, columns, filters: [] as string[] };
          h.reads.push(rec);
          const result = async () =>
            table === "users"
              ? { data: h.userRow, error: h.userError }
              : { data: null, error: null };
          const chain: SelectChain = {
            eq: (column, value) => {
              rec.filters.push(`eq:${column}=${value}`);
              return chain;
            },
            single: result,
            maybeSingle: result,
          };
          return chain;
        },
        insert: refuseWrite("insert"),
        update: refuseWrite("update"),
        upsert: refuseWrite("upsert"),
        delete: refuseWrite("delete"),
      };
    },
    rpc: (fn: string) => {
      h.writes.push({ table: fn, op: "rpc" });
      throw new Error(`unexpected rpc ${fn}`);
    },
  }),
}));

import { handleCallbackQuery } from "@/src/services/bot";

const CHAT_ID = 555;
const MESSAGE_ID = 42;
const TELEGRAM_USER_ID = 777;

const STRIPPED = {
  markup: { inline_keyboard: [] },
  options: { chat_id: CHAT_ID, message_id: MESSAGE_ID },
};

function tap(data: string, withMessage = true): TelegramBot.CallbackQuery {
  return {
    id: "cb-1",
    from: { id: TELEGRAM_USER_ID, is_bot: false, first_name: "Dana" },
    chat_instance: "ci-1",
    data,
    ...(withMessage
      ? {
          message: {
            message_id: MESSAGE_ID,
            date: 0,
            chat: { id: CHAT_ID, type: "private" as const },
            // The keyboard an old reminder message was sent with.
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "Done", callback_data: "reminder_done:r1" },
                  { text: "Snooze", callback_data: "reminder_snooze:r1" },
                ],
                [{ text: "Open List", web_app: { url: "https://app.test/list/list-1" } }],
              ],
            },
          },
        }
      : {}),
  };
}

beforeEach(() => {
  h.userRow = { language: "he" };
  h.userError = null;
  h.reads = [];
  h.writes = [];
  h.answers = [];
  h.markupEdits = [];
  h.textEdits = [];
  h.sends = [];
  h.answerError = null;
  h.markupError = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleCallbackQuery: buttons on old reminder messages", () => {
  it.each([
    ["Done", "reminder_done:r1"],
    ["Snooze", "reminder_snooze:r1"],
    ["a snooze option (30m)", "reminder_snooze:r1:30m"],
    ["a snooze option (tomorrow)", "reminder_snooze:r1:tomorrow"],
  ])("%s answers in the user's language, strips every button and writes nothing", async (_label, data) => {
    await handleCallbackQuery(tap(data));

    expect(h.answers).toEqual([{ id: "cb-1", options: { text: he.bot.remindersRemoved } }]);
    // All buttons go, Open List included: it would open a deleted list.
    expect(h.markupEdits).toEqual([STRIPPED]);
    expect(h.writes).toEqual([]);
    // Only the user's language is read; nothing about the reminder or its list.
    expect(h.reads).toEqual([
      { table: "users", columns: "language", filters: [`eq:telegram_id=${TELEGRAM_USER_ID}`] },
    ]);
    expect(h.textEdits).toEqual([]);
    expect(h.sends).toEqual([]);
  });

  it.each([
    ["en", en.bot.remindersRemoved],
    ["ru", ru.bot.remindersRemoved],
  ])("answers a user whose language is %s in that language", async (language, text) => {
    h.userRow = { language };

    await handleCallbackQuery(tap("reminder_done:r1"));

    expect(h.answers).toEqual([{ id: "cb-1", options: { text } }]);
  });

  it("falls back to English for a Telegram user the app doesn't know", async () => {
    h.userRow = null;

    await handleCallbackQuery(tap("reminder_done:r1"));

    expect(h.answers).toEqual([{ id: "cb-1", options: { text: en.bot.remindersRemoved } }]);
    expect(h.markupEdits).toEqual([STRIPPED]);
  });

  it("logs a failed language lookup and still answers in English", async () => {
    h.userRow = null;
    h.userError = { message: "db down" };

    await handleCallbackQuery(tap("reminder_snooze:r1"));

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("[Bot]"), h.userError);
    expect(h.answers).toEqual([{ id: "cb-1", options: { text: en.bot.remindersRemoved } }]);
    expect(h.markupEdits).toEqual([STRIPPED]);
  });

  it("still strips the buttons, and logs, when answering the tap fails", async () => {
    h.answerError = new Error("query is too old");

    await expect(handleCallbackQuery(tap("reminder_done:r1"))).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("[Bot]"), h.answerError);
    expect(h.markupEdits).toEqual([STRIPPED]);
  });

  it("logs and does not throw when Telegram refuses the button edit", async () => {
    h.markupError = new Error("message is not modified");

    await expect(handleCallbackQuery(tap("reminder_snooze:r1:3h"))).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("[Bot]"), h.markupError);
    expect(h.answers).toHaveLength(1);
  });

  it("answers, logs why, and edits nothing when the tap carries no message", async () => {
    await handleCallbackQuery(tap("reminder_done:r1", false));

    expect(h.answers).toEqual([{ id: "cb-1", options: { text: he.bot.remindersRemoved } }]);
    expect(h.markupEdits).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("reminder_done:r1"));
  });
});

describe("bot.remindersRemoved copy", () => {
  it("exists in every locale, written in that locale's own script", () => {
    expect(en.bot.remindersRemoved).toMatch(/reminders/i);
    expect(he.bot.remindersRemoved).toMatch(/[\u0590-\u05FF]/);
    expect(ru.bot.remindersRemoved).toMatch(/[\u0400-\u04FF]/);
  });
});
