import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import en from "@/messages/en.json";

// node-telegram-bot-api calls /start and /help handlers and drops the promise they return, so
// a failed send used to become an unhandled rejection. Each handler now logs its own failure.
type Handler = (msg: unknown, match: RegExpExecArray | null) => unknown;
const h = vi.hoisted(() => ({
  handlers: [] as { regexp: RegExp; handler: (msg: unknown, match: RegExpExecArray | null) => unknown }[],
  sendError: null as Error | null,
  // While set, sendMessage waits for it: lets a test hold a handler mid-flight.
  sendGate: null as Promise<void> | null,
  sends: [] as { chatId: number; text: string }[],
  upsertError: null as { message: string } | null,
}));

vi.mock("@/src/lib/env", () => ({
  serverEnv: () => ({ TELEGRAM_BOT_TOKEN: "test-token", NEXT_PUBLIC_APP_URL: "https://app.test" }),
}));

vi.mock("@/src/lib/supabase", () => ({
  createServerClient: () => ({
    from: () => ({ upsert: async () => ({ data: null, error: h.upsertError }) }),
  }),
}));

vi.mock("node-telegram-bot-api", () => ({
  default: class FakeTelegramBot {
    onText(regexp: RegExp, handler: Handler) {
      h.handlers.push({ regexp, handler });
    }
    async sendMessage(chatId: number, text: string) {
      if (h.sendGate) await h.sendGate;
      if (h.sendError) throw h.sendError;
      h.sends.push({ chatId, text });
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
    h.sendGate = null;
    h.upsertError = null;
    h.sends = [];
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

// The webhook runs processUpdate inside after() and then awaits waitForBotHandlers(), so Vercel
// keeps the function alive until /start and /help have finished their writes and sends.
describe("waitForBotHandlers", () => {
  beforeEach(() => {
    h.sendGate = null;
    h.upsertError = null;
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
