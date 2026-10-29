import { describe, it, expect, vi } from "vitest";
import { format, inspect } from "util";
import TelegramBot from "node-telegram-bot-api";

// A failed Telegram API call rejects with an error that keeps the raw HTTP response, and the
// response's request line holds the bot token. Logging that error with console.error printed
// the token. This runs the real library's error class and the real bot module.
vi.mock("@/src/lib/env", () => ({
  serverEnv: () => ({ TELEGRAM_BOT_TOKEN: "123456:BOT_TOKEN_SECRET", NEXT_PUBLIC_APP_URL: "https://app.test" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => ({}) }));

type ErrorClass = new (message: string, response?: unknown) => Error & { code?: string; response?: unknown };
const errors = (TelegramBot as unknown as { errors: Record<string, ErrorClass> }).errors;

// The same shape the library attaches: an http.IncomingMessage whose req/request carry the URL.
const response = {
  statusCode: 403,
  req: { _header: "POST /bot123456:BOT_TOKEN_SECRET/sendMessage HTTP/1.1\r\nHost: api.telegram.org" },
  request: { href: "https://api.telegram.org/bot123456:BOT_TOKEN_SECRET/sendMessage" },
};
const blocked = () => new errors.TelegramError("403 Forbidden: bot was blocked by the user", response);

describe("Telegram API errors never print the bot token", () => {
  it("the library's error carries the token in its response (the leak this guards)", () => {
    expect(inspect(blocked(), { customInspect: false })).toContain("BOT_TOKEN_SECRET");
  });

  it("once the bot is created, a logged Telegram error shows its code and description but not the token", async () => {
    const { default: bot } = await import("@/src/services/bot");
    void bot.getMe; // reading any property creates the bot

    const err = blocked();
    const printed = format("[X] failed:", err);
    expect(printed).not.toContain("BOT_TOKEN_SECRET");
    expect(printed).toContain("ETELEGRAM: 403 Forbidden: bot was blocked by the user");
    expect(printed).toContain("[X] failed:");

    // Wrapped or nested errors print through the same hook.
    expect(format(new Error("send failed", { cause: err }))).not.toContain("BOT_TOKEN_SECRET");
    expect(format({ err })).not.toContain("BOT_TOKEN_SECRET");

    // Only printing changes: the error object itself is untouched.
    expect(err.response).toBe(response);
    expect(err.code).toBe("ETELEGRAM");
    expect(err.message).toBe("ETELEGRAM: 403 Forbidden: bot was blocked by the user");
  });

  it("covers the library's other error types too", async () => {
    const { default: bot } = await import("@/src/services/bot");
    void bot.getMe; // reading any property creates the bot, which installs the redaction
    expect(format(new errors.ParseError("Error parsing response: <html>", response))).not.toContain("BOT_TOKEN_SECRET");
    expect(format(new errors.FatalError("Telegram Bot Token not provided!"))).toContain("EFATAL");
  });
});
