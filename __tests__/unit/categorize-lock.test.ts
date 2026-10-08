import { describe, it, expect, vi, beforeEach } from "vitest";

// An in-memory stand-in for the few Upstash calls the lock makes.
const h = vi.hoisted(() => {
  const store = new Map<string, string>();
  const redis = {
    set: vi.fn(async (key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) => {
      if (opts?.nx && store.has(key)) return null;
      store.set(key, String(value));
      return "OK";
    }),
    del: vi.fn(async (key: string) => Number(store.delete(key))),
    getdel: vi.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
    // Runs the one script the lock sends: delete the key only while it holds the token.
    eval: vi.fn(async (script: string, keys: string[], args: string[]) => {
      const compareAndDelete =
        script.includes('redis.call("get", KEYS[1]) == ARGV[1]') && script.includes('redis.call("del", KEYS[1])');
      if (!compareAndDelete) throw new Error(`unexpected script: ${script}`);
      if (store.get(keys[0]) !== args[0]) return 0;
      store.delete(keys[0]);
      return 1;
    }),
  };
  return { store, redis };
});
vi.mock("@/src/lib/redis", () => ({ getRedis: () => h.redis }));

import { redisListLock } from "@/src/utils/categorize-lock";

const KEY = "categorize:lock:L";

beforeEach(() => {
  h.store.clear();
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("redisListLock", () => {
  it("acquire stores a fresh token with NX and a 90 s expiry, and is refused while held", async () => {
    const token = await redisListLock.acquire("L");
    expect(token).toEqual(expect.any(String));
    expect(h.redis.set).toHaveBeenCalledWith(KEY, token, { nx: true, ex: 90 });
    expect(await redisListLock.acquire("L")).toBeNull();
  });

  it("release frees the lock it holds", async () => {
    const token = (await redisListLock.acquire("L"))!;
    await redisListLock.release("L", token);
    expect(h.store.has(KEY)).toBe(false);
    expect(await redisListLock.acquire("L")).toEqual(expect.any(String));
  });

  it("a holder whose lock expired cannot release the next holder's lock", async () => {
    const first = (await redisListLock.acquire("L"))!;
    h.store.delete(KEY); // expired during a slow round
    const second = (await redisListLock.acquire("L"))!;
    expect(second).not.toBe(first);

    await redisListLock.release("L", first);
    expect(h.store.get(KEY)).toBe(second);
  });

  it("acquire fails open with a token when Redis is down, like the voice lock", async () => {
    h.redis.set.mockRejectedValueOnce(new Error("redis down"));
    expect(await redisListLock.acquire("L")).toEqual(expect.any(String));
  });
});
