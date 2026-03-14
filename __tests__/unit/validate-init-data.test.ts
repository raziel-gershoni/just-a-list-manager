import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import { _resetServerEnv } from "@/src/lib/env";

const BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";

// Stub all required server env vars so serverEnv() doesn't throw
const ENV_STUBS: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "https://fake.supabase.co",
  SUPABASE_SECRET_KEY: "fake-secret-key",
  SUPABASE_JWT_SECRET: "fake-jwt-secret",
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: "fake-webhook-secret",
  GEMINI_API_KEY: "fake-gemini-key",
  UPSTASH_REDIS_REST_URL: "https://fake-redis.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "fake-redis-token",
  NEXT_PUBLIC_APP_URL: "https://fake-app.example.com",
  NEXT_PUBLIC_BOT_USERNAME: "fake_bot",
};

/**
 * Build a valid Telegram initData string with correct HMAC signature.
 */
function buildInitData(
  params: Record<string, string>,
  token: string = BOT_TOKEN
): string {
  const checkString = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(token)
    .digest();

  const hash = crypto
    .createHmac("sha256", secretKey)
    .update(checkString)
    .digest("hex");

  const allParams = { ...params, hash };
  return Object.entries(allParams)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function freshAuthDate(): string {
  return Math.floor(Date.now() / 1000).toString();
}

function expiredAuthDate(): string {
  return (Math.floor(Date.now() / 1000) - 600).toString();
}

const testUser = JSON.stringify({
  id: 12345,
  first_name: "Test",
  last_name: "User",
  username: "testuser",
});

beforeEach(() => {
  // Reset cached env so each test gets fresh validation
  _resetServerEnv();
  for (const [key, value] of Object.entries(ENV_STUBS)) {
    vi.stubEnv(key, value);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetServerEnv();
});

describe("validateInitData", () => {
  it("returns user for valid signature and fresh auth_date", async () => {
    const { validateInitData } = await import("@/src/lib/telegram-auth");
    const initData = buildInitData({
      auth_date: freshAuthDate(),
      user: testUser,
    });

    const result = validateInitData(initData);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(12345);
    expect(result!.first_name).toBe("Test");
    expect(result!.username).toBe("testuser");
  });

  it("returns null for expired auth_date", async () => {
    const { validateInitData } = await import("@/src/lib/telegram-auth");
    const initData = buildInitData({
      auth_date: expiredAuthDate(),
      user: testUser,
    });

    const result = validateInitData(initData);
    expect(result).toBeNull();
  });

  it("returns null when hash is missing", async () => {
    const { validateInitData } = await import("@/src/lib/telegram-auth");
    const params = `auth_date=${freshAuthDate()}&user=${encodeURIComponent(testUser)}`;
    const result = validateInitData(params);
    expect(result).toBeNull();
  });

  it("returns null for invalid signature", async () => {
    const { validateInitData } = await import("@/src/lib/telegram-auth");
    const initData = buildInitData({
      auth_date: freshAuthDate(),
      user: testUser,
    });

    const corrupted = initData.replace(/hash=[^&]+/, "hash=0000000000000000000000000000000000000000000000000000000000000000");
    const result = validateInitData(corrupted);
    expect(result).toBeNull();
  });

  it("returns null for empty string", async () => {
    const { validateInitData } = await import("@/src/lib/telegram-auth");
    const result = validateInitData("");
    expect(result).toBeNull();
  });

  it("returns null when bot token is empty", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "x"); // Must be non-empty for serverEnv() to pass
    _resetServerEnv();
    const { validateInitData } = await import("@/src/lib/telegram-auth");

    // Build with default token but env has different token — signature won't match
    const initData = buildInitData({
      auth_date: freshAuthDate(),
      user: testUser,
    });

    const result = validateInitData(initData);
    expect(result).toBeNull();
  });

  it("returns null when user field is missing from params", async () => {
    const { validateInitData } = await import("@/src/lib/telegram-auth");
    const initData = buildInitData({
      auth_date: freshAuthDate(),
    });

    const result = validateInitData(initData);
    expect(result).toBeNull();
  });

  it("returns null for malformed initData string", async () => {
    const { validateInitData } = await import("@/src/lib/telegram-auth");
    const result = validateInitData("not-valid-data");
    expect(result).toBeNull();
  });
});
