import { describe, it, expect, vi, afterEach } from "vitest";
import { format, inspect } from "util";
import { createServer, type AddressInfo } from "net";
import TelegramBot from "node-telegram-bot-api";

// Every Bot API call goes to https://api.telegram.org/bot<token>/<method>, so the token is in
// every request URL. The bot's catches log the errors the library rejects with, so those errors
// must never carry the token. This drives the real library (only fetch is faked) through each way
// a call fails and checks everything a log line could print.
const TOKEN = "123456:BOT_TOKEN_SECRET";
const SECRET = "BOT_TOKEN_SECRET";

type Fetch = typeof fetch;

function botWith(fetchImpl: Fetch, baseApiUrl?: string): TelegramBot {
  return new TelegramBot(TOKEN, { polling: false, baseApiUrl, request: { fetch: fetchImpl } });
}

/** Telegram's JSON envelope, as the Bot API answers a failed call. */
function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Every way a caught error reaches the logs: console.error formats it with util.inspect. */
function printed(err: Error): string[] {
  return [
    err.message,
    err.stack ?? "",
    inspect(err),
    inspect(err, { depth: Infinity, showHidden: true }),
    format("[Bot] send failed:", err),
    format("%s", err),
    format({ err }),
    JSON.stringify(err),
  ];
}

function expectNoToken(err: unknown): Error {
  expect(err).toBeInstanceOf(TelegramBot.errors.BaseError);
  const e = err as Error;
  for (const text of printed(e)) {
    expect(text).not.toContain(SECRET);
  }
  return e;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Telegram API errors never carry the bot token", () => {
  it("a 4xx answer (bot blocked) shows the code and description, not the token", async () => {
    const urls: string[] = [];
    const fake = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return answer(403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
    });

    const err = expectNoToken(await botWith(fake as Fetch).sendMessage(42, "hi").catch((e: unknown) => e));

    // The token really was in play: the request went to /bot<token>/sendMessage.
    expect(urls).toEqual([`https://api.telegram.org/bot${TOKEN}/sendMessage`]);
    expect(err).toBeInstanceOf(TelegramBot.errors.TelegramError);
    expect(err.message).toBe("ETELEGRAM: 403 Forbidden: bot was blocked by the user");
    expect(inspect(err)).toContain("ETELEGRAM: 403 Forbidden: bot was blocked by the user");
  });

  it("a 429 is retried after retry_after, and the final error has no token", async () => {
    vi.useFakeTimers();
    const fake = vi.fn(async () =>
      answer(429, { ok: false, error_code: 429, description: "Too Many Requests: retry after 1", parameters: { retry_after: 1 } }),
    );

    const pending = botWith(fake as Fetch).sendMessage(42, "hi").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const err = expectNoToken(await pending);

    expect(fake).toHaveBeenCalledTimes(3); // the first try plus the library's 2 retries
    expect(err.message).toBe("ETELEGRAM: 429 Too Many Requests: retry after 1");
  });

  it("an unparseable answer (a proxy's HTML 502) has no token", async () => {
    const fake = vi.fn(async () => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 }));

    const err = expectNoToken(await botWith(fake as Fetch).sendMessage(42, "hi").catch((e: unknown) => e));

    expect(err).toBeInstanceOf(TelegramBot.errors.ParseError);
    expect(err.message).toContain("EPARSE");
  });

  it("a network failure has no token and keeps its root cause", async () => {
    const fake = vi.fn(async () => {
      const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.telegram.org"), {
        code: "ENOTFOUND",
        hostname: "api.telegram.org",
      });
      throw new TypeError("fetch failed", { cause });
    });

    const err = expectNoToken(await botWith(fake as Fetch).sendMessage(42, "hi").catch((e: unknown) => e));

    expect(err).toBeInstanceOf(TelegramBot.errors.FatalError);
    expect(err.message).toBe("EFATAL: fetch failed");
    expect(inspect(err, { depth: Infinity })).toContain("ENOTFOUND");
  });

  it("a real fetch that cannot connect has no token and keeps its root cause", async () => {
    // Node's own fetch against a local port that was just closed: a real transport error, no
    // outside call.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));

    const err = expectNoToken(
      await botWith(fetch, `http://127.0.0.1:${port}`).sendMessage(42, "hi").catch((e: unknown) => e),
    );

    expect(err).toBeInstanceOf(TelegramBot.errors.FatalError);
    expect(inspect(err, { depth: Infinity })).toContain("ECONNREFUSED");
  });
});
