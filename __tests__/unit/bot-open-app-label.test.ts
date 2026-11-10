import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";
import en from "@/messages/en.json";
import he from "@/messages/he.json";
import ru from "@/messages/ru.json";

// Every button that opens the Mini App (the /start and /help buttons, the chat menu button and
// the voice replies' buttons) reads bot.openAppButton in the user's language. This runs the real bot
// module and the real voice handler against a fake Telegram client and a fake database.
type Handler = (msg: unknown, match: RegExpExecArray | null) => unknown;
type Button = { text: string; web_app?: { url: string } };
type Sent = { text: string; buttons: Button[] };

const h = vi.hoisted(() => ({
  handlers: [] as { regexp: RegExp; handler: Handler }[],
  sent: [] as Sent[],
  menuButtons: [] as unknown[],
  db: null as null | { client: unknown; calls: unknown[] },
}));

vi.mock("@/src/lib/env", () => ({
  serverEnv: () => ({ TELEGRAM_BOT_TOKEN: "test-token", NEXT_PUBLIC_APP_URL: "https://app.test" }),
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
vi.mock("@/src/services/voice-processor", () => ({ getVoiceProcessor: () => ({ process: vi.fn() }) }));
vi.mock("@/src/services/item-recycler", () => ({ findFuzzyMatch: vi.fn(), recycleItem: vi.fn() }));
vi.mock("@/src/services/categorize-list", () => ({ categorizeList: async () => {} }));
vi.mock("node-telegram-bot-api", () => ({
  default: class FakeTelegramBot {
    onText(regexp: RegExp, handler: Handler) {
      h.handlers.push({ regexp, handler });
    }
    async sendMessage(_chatId: number, text: string, opts?: { reply_markup?: { inline_keyboard?: Button[][] } }) {
      h.sent.push({ text, buttons: (opts?.reply_markup?.inline_keyboard ?? []).flat() });
      return {};
    }
    async setChatMenuButton(form: { menu_button?: unknown }) {
      h.menuButtons.push(form.menu_button);
      return true;
    }
    async sendChatAction() {
      return true;
    }
  },
}));

import { handleVoiceMessage } from "@/src/services/voice-handler";

const MESSAGES = { en, he, ru };
const LABELS = { en: en.bot.openAppButton, he: he.bot.openAppButton, ru: ru.bot.openAppButton };
const ok = (data: unknown): FakeResult => ({ data, error: null });

async function run(text: string, languageCode: string) {
  const { default: bot, waitForBotHandlers } = await import("@/src/services/bot");
  void bot.sendMessage; // reading any property creates the bot and registers the commands
  const found = h.handlers.find((c) => c.regexp.test(text));
  if (!found) throw new Error(`no handler for ${text}`);
  const match = found.regexp.exec(text);
  found.regexp.lastIndex = 0;
  found.handler({ chat: { id: 42 }, from: { id: 7, first_name: "A", language_code: languageCode } }, match);
  await waitForBotHandlers();
  expect(console.error).not.toHaveBeenCalled();
}

const appButtons = (): Button[] => h.sent.flatMap((m: Sent) => m.buttons).filter((b) => b.web_app);

beforeEach(() => {
  h.sent = [];
  h.menuButtons = [];
  h.db = fakeSupabase(() => ok(null));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("the Open App label follows the user's language", () => {
  it("the three languages have their own label and invitation text", () => {
    expect(new Set(Object.values(LABELS)).size).toBe(3);
    expect(new Set(Object.values(MESSAGES).map((m) => m.bot.inviteOpen)).size).toBe(3);
  });

  describe.each(Object.entries(LABELS))("%s", (lang, label) => {
    it("/start: the welcome button and the chat menu button", async () => {
      await run("/start", lang);
      expect(appButtons().map((b) => b.text)).toEqual([label]);
      expect(h.menuButtons).toEqual([{ type: "web_app", text: label, web_app: { url: "https://app.test" } }]);
    });

    it("/start invite_…: the invitation text and button", async () => {
      await run("/start invite_abc", lang);
      expect(h.sent.map((m) => m.text)).toEqual([MESSAGES[lang as keyof typeof MESSAGES].bot.inviteOpen]);
      expect(appButtons()).toEqual([{ text: label, web_app: { url: "https://app.test/invite/abc" } }]);
    });

    it("/help: the button", async () => {
      await run("/help", lang);
      expect(appButtons().map((b) => b.text)).toEqual([label]);
    });

    it("voice from someone who never opened the app: the button", async () => {
      h.db = fakeSupabase((call: FakeCall) => {
        if (call.table === "users") return ok(null);
        throw new Error(`unexpected call ${call.table} ${call.op}`);
      });
      await handleVoiceMessage(42, 7, { file_id: "f1", file_unique_id: "u1", duration: 3 }, { id: 7, first_name: "A", language_code: lang });
      expect(appButtons().map((b) => b.text)).toEqual([label]);
    });

    it("voice from a user with no lists: the button, in the saved language", async () => {
      h.db = fakeSupabase((call: FakeCall) => {
        if (call.table === "users") return ok({ id: "u1", language: lang });
        if (call.table === "lists" || call.table === "collaborators" || call.table === "user_list_state") return ok([]);
        throw new Error(`unexpected call ${call.table} ${call.op}`);
      });
      // The Telegram client language differs: the saved one wins once the user is known.
      await handleVoiceMessage(42, 7, { file_id: "f1", file_unique_id: "u1", duration: 3 }, { id: 7, first_name: "A", language_code: "xx" });
      expect(appButtons().map((b) => b.text)).toEqual([label]);
    });
  });

  it("an unsupported language falls back to English", async () => {
    await run("/start", "de");
    await run("/help", "de");
    expect(appButtons().map((b) => b.text)).toEqual([LABELS.en, LABELS.en]);
    expect(h.menuButtons).toEqual([{ type: "web_app", text: LABELS.en, web_app: { url: "https://app.test" } }]);
  });
});
