import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// node-telegram-bot-api calls /start and /help handlers and drops the promise they return, so
// a failed send used to become an unhandled rejection. Each handler now logs its own failure.
type Handler = (msg: unknown, match: RegExpExecArray | null) => unknown;
const h = vi.hoisted(() => ({
  handlers: [] as { regexp: RegExp; handler: (msg: unknown, match: RegExpExecArray | null) => unknown }[],
  sendError: null as Error | null,
}));

vi.mock("@/src/lib/env", () => ({
  serverEnv: () => ({ TELEGRAM_BOT_TOKEN: "test-token", NEXT_PUBLIC_APP_URL: "https://app.test" }),
}));

vi.mock("@/src/lib/supabase", () => ({
  createServerClient: () => ({
    from: () => ({ upsert: async () => ({ data: null, error: null }) }),
  }),
}));

vi.mock("node-telegram-bot-api", () => ({
  default: class FakeTelegramBot {
    onText(regexp: RegExp, handler: Handler) {
      h.handlers.push({ regexp, handler });
    }
    async sendMessage() {
      if (h.sendError) throw h.sendError;
      return {};
    }
    async setChatMenuButton() {
      return true;
    }
  },
}));

const msg = { chat: { id: 42 }, from: { id: 7, first_name: "A", language_code: "en" } };

async function commandHandler(text: string): Promise<Handler> {
  const { default: bot } = await import("@/src/services/bot");
  void bot.sendMessage; // reading any property creates the bot and registers the commands
  const found = h.handlers.find((c) => c.regexp.test(text));
  if (!found) throw new Error(`no handler for ${text}`);
  return found.handler;
}

describe("bot command handlers log their own failures", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    h.sendError = new Error("ETELEGRAM: 403 Forbidden: bot was blocked by the user");
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["/help", null],
    ["/start", ["/start", ""]],
    ["/start invite_abc", ["/start invite_abc", " invite_abc"]],
  ])("%s: a failed send is logged with the chat id and the error, and nothing rejects", async (text, match) => {
    const handler = await commandHandler(text);
    const outcome = await Promise.resolve(handler(msg, match as RegExpExecArray | null)).then(
      () => "settled",
      () => "rejected"
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(outcome).toBe("settled");
    const command = text.split(" ")[0];
    expect(errorSpy).toHaveBeenCalledWith(`[Bot] ${command} handler failed, chatId:`, 42, h.sendError);
  });
});
