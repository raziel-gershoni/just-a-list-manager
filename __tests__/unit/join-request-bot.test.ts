import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CallbackQuery } from "node-telegram-bot-api";
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
  sends: [] as { chatId: number; text: string; buttons?: unknown[] }[],
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
    async sendMessage(chatId: number, text: string, options?: { reply_markup?: { inline_keyboard?: unknown[][] } }) {
      if (h.sendError) throw h.sendError;
      const buttons = options?.reply_markup?.inline_keyboard?.flat();
      h.sends.push(buttons ? { chatId, text, buttons } : { chatId, text });
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

function use(opts: { collab?: unknown; readError?: unknown; updateError?: unknown; updateRow?: unknown } = {}) {
  const collab = "collab" in opts ? opts.collab : COLLAB;
  h.fake = fakeSupabase((c) => {
    if (c.table === "collaborators" && c.op === "select") return row(c, collab, opts.readError ?? null);
    if (c.table === "collaborators" && c.op === "update") return { data: "updateRow" in opts ? opts.updateRow : { id: "c1" }, error: opts.updateError ?? null };
    throw new Error(`unexpected ${c.op} on ${c.table}`);
  }) as typeof h.fake;
}

function tap(data: string, from: { id?: number; language_code?: string } = {}): CallbackQuery {
  return {
    id: "cb-1",
    from: { id: OWNER_TG, is_bot: false, first_name: "Owner", language_code: "ru", ...from },
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
      {
        chatId: REQUESTER_TG,
        text: en.share.approvedMessage.replace("{listName}", "Groceries"),
        buttons: [{ text: en.bot.openAppButton, web_app: { url: "https://app.test" } }],
      },
    ]);
    expect(h.answers).toEqual([{ id: "cb-1", options: { text: he.bot.approvedToast } }]);
    expect(h.textEdits).toHaveLength(1);
  });

  // Three different languages: the requester's row says Russian, the owner's row Hebrew and
  // the owner's Telegram client English, so each string shows whose language it used.
  it("approve: the requester's message and button are in the requester's language, the toast in the owner's", async () => {
    use({ collab: { ...COLLAB, users: { ...COLLAB.users, language: "ru" } } });

    await handleCallbackQuery(tap("approve:c1", { language_code: "en" }));

    expect(h.sends).toEqual([
      {
        chatId: REQUESTER_TG,
        text: ru.share.approvedMessage.replace("{listName}", "Groceries"),
        buttons: [{ text: ru.bot.openAppButton, web_app: { url: "https://app.test" } }],
      },
    ]);
    expect(h.answers).toEqual([{ id: "cb-1", options: { text: he.bot.approvedToast } }]);
  });

  it("decline: the toast is in the owner's language", async () => {
    use();

    await handleCallbackQuery(tap("decline:c1", { language_code: "en" }));

    expect(updates()[0].values).toEqual({ status: "declined" });
    expect(h.answers).toEqual([{ id: "cb-1", options: { text: he.bot.declinedToast } }]);
  });

  it.each(["approve", "decline"])(
    "%s by someone who is not the owner: refused in the tapper's Telegram language, nothing changes",
    async (action) => {
      use();

      await handleCallbackQuery(tap(`${action}:c1`, { id: 555, language_code: "ru" }));

      expect(h.answers).toEqual([{ id: "cb-1", options: { text: ru.bot.ownerOnlyDecision } }]);
      expect(updates()).toEqual([]);
      expect(h.sends).toEqual([]);
      expect(h.textEdits).toEqual([]);
    }
  );

  it("a request that is really gone says requestNotFound in the tapper's Telegram language, and logs no error", async () => {
    use({ collab: null });

    await handleCallbackQuery(tap("approve:c1"));

    expect(h.answers).toEqual([{ id: "cb-1", options: { text: ru.bot.requestNotFound } }]);
    expect(console.error).not.toHaveBeenCalled();
    expect(updates()).toEqual([]);
  });

  it.each(["approve", "decline"])(
    "%s: a request deleted between the read and the status update tells nobody and edits nothing",
    async (action) => {
      use({ updateRow: null });

      await handleCallbackQuery(tap(`${action}:c1`));

      expect(console.warn).toHaveBeenCalledWith("[Bot] Join request was gone before the status update, collaboratorId:", "c1");
      expect(h.answers).toEqual([{ id: "cb-1", options: { text: he.bot.requestNotFound } }]);
      expect(h.sends).toEqual([]);
      expect(h.textEdits).toEqual([]);
    }
  );

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
