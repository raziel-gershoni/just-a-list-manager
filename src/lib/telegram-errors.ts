import { inspect } from "util";
import type TelegramBot from "node-telegram-bot-api";

type ErrorsModule = { BaseError?: { prototype: Error } };

/**
 * A failed Telegram API call rejects with an error that keeps the raw HTTP response, and the
 * response's request line holds the bot token ("POST /bot<token>/sendMessage"). Logging such an
 * error with console.error would print the token. This makes every error class of the library
 * print as its stack instead (which carries the code and Telegram's description). The error
 * objects themselves are unchanged. It covers console/util.inspect output only: Node prints an
 * unhandled rejection with custom inspection off, so bot code must catch its own errors.
 */
export function redactTelegramErrors(Bot: typeof TelegramBot): void {
  const base = (Bot as unknown as { errors?: ErrorsModule }).errors?.BaseError;
  if (!base) {
    console.warn("[Bot] node-telegram-bot-api has no errors.BaseError; Telegram errors may print the bot token");
    return;
  }
  Object.defineProperty(base.prototype, inspect.custom, {
    value(this: Error) {
      return this.stack ?? `${this.name}: ${this.message}`;
    },
    configurable: true,
  });
}
