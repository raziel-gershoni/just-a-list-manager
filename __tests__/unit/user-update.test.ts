import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { NextRequest } from "next/server";

// Runs the real PATCH handler; auth, the rate limiter and Supabase are faked.
const h = vi.hoisted(() => ({
  calls: [] as { table: string; values: unknown; filters: string[] }[],
}));

vi.mock("@/src/lib/rate-limit", () => ({
  apiRateLimiter: {},
  checkRateLimit: vi.fn(async () => ({ success: true })),
  getRateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: vi.fn(async () => ({ success: true, userId: "user-1" })),
}));

vi.mock("@/src/lib/telegram-auth", () => ({
  validateInitData: vi.fn(() => null),
}));

vi.mock("@/src/lib/supabase", () => ({
  createServerClient: () => ({
    from: (table: string) => ({
      update: (values: unknown) => {
        const rec = { table, values, filters: [] as string[] };
        h.calls.push(rec);
        const chain = {
          eq: (c: string, v: unknown) => { rec.filters.push(`eq:${c}=${v}`); return chain; },
          select: () => chain,
          single: async () => ({ data: { id: "user-1", ...(values as object) }, error: null }),
        };
        return chain;
      },
    }),
  }),
}));

import { PATCH } from "@/app/api/user/route";
import { updateUserSchema } from "@/src/schemas/user";

function patch(body: unknown) {
  return PATCH(
    new NextRequest("https://app.test/api/user", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  h.calls = [];
});

// Reminders are gone (spec 2026-10-28) and nothing reads users.timezone any more, so the
// app neither syncs nor stores it. Migration 029 drops the column.
describe("updateUserSchema", () => {
  it.each(["en", "he", "ru"])("accepts language %s", (language) => {
    expect(updateUserSchema.safeParse({ language }).success).toBe(true);
  });

  it("requires a language", () => {
    expect(updateUserSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a body that only carries a time zone", () => {
    expect(updateUserSchema.safeParse({ timezone: "Asia/Jerusalem" }).success).toBe(false);
  });

  it("strips a time zone sent next to the language", () => {
    expect(updateUserSchema.parse({ language: "ru", timezone: "Europe/Moscow" })).toStrictEqual({ language: "ru" });
  });
});

describe("PATCH /api/user", () => {
  it("writes only the language, even when an old app also sends a time zone", async () => {
    const res = await patch({ language: "he", timezone: "Asia/Jerusalem" });

    expect(res.status).toBe(200);
    expect(h.calls).toEqual([{ table: "users", values: { language: "he" }, filters: ["eq:id=user-1"] }]);
  });

  it("returns 400 and writes nothing for a time-zone-only body", async () => {
    const res = await patch({ timezone: "Asia/Jerusalem" });

    expect(res.status).toBe(400);
    expect(h.calls).toEqual([]);
  });
});

describe("TelegramProvider", () => {
  const src = readFileSync(resolve(process.cwd(), "components/TelegramProvider.tsx"), "utf8");

  it("never reads the device time zone or sends it to /api/user", () => {
    expect(src).not.toMatch(/resolvedOptions\(\)\.timeZone/);
    expect(src).not.toMatch(/timezone/i);
  });
});
