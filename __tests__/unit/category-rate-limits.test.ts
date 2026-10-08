import { describe, it, expect, vi } from "vitest";

// Record each limiter's window and prefix instead of talking to Redis.
const built = vi.hoisted(() => [] as { window: unknown; prefix: string }[]);
vi.mock("@upstash/redis", () => ({ Redis: class {} }));
vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: class {
    static slidingWindow(tokens: number, interval: string) { return { tokens, interval }; }
    constructor(opts: { limiter: unknown; prefix: string }) { built.push({ window: opts.limiter, prefix: opts.prefix }); }
    limit() { return Promise.resolve({ success: true, remaining: 0, reset: 0 }); }
  },
}));
vi.mock("@/src/lib/env", () => ({
  serverEnv: () => ({ UPSTASH_REDIS_REST_URL: "https://redis.test", UPSTASH_REDIS_REST_TOKEN: "t" }),
}));

import * as limits from "@/src/lib/rate-limit";

function windowOf(name: string) {
  const before = built.length;
  void (limits as unknown as Record<string, { limit: unknown }>)[name].limit;
  expect(built.length).toBe(before + 1);
  return built[before];
}

describe("AI budgets for grocery categories", () => {
  it("frees a list's categorization slots within a minute, so the next sweep can retry", () => {
    expect(windowOf("categorizeRateLimiter")).toEqual({ window: { tokens: 15, interval: "1 m" }, prefix: "ratelimit:categorize" });
  });

  it("caps categorization and translation app-wide at 60 calls a minute", () => {
    expect(windowOf("categorizeGlobalRateLimiter")).toEqual({ window: { tokens: 60, interval: "1 m" }, prefix: "ratelimit:categorize-global" });
  });

  it("caps a user's category name translations at 10 a minute", () => {
    expect(windowOf("categoryTranslateRateLimiter")).toEqual({ window: { tokens: 10, interval: "1 m" }, prefix: "ratelimit:category-translate" });
  });
});
