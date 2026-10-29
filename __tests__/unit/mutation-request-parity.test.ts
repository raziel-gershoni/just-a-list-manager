import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { getSyncEngine, resetSyncEngines, type QueuedMutation } from "@/src/sync/engine";
import { createExecutorFactory } from "@/src/utils/executor-factory";

// A change made online and the same change replayed after a reload must send the same
// request. This already broke in production (5f3dd51) when each change type had two request
// builders, an inline one for online and executor-factory for replay. Now the sync engine
// sends every change through executor-factory; this runs each type both ways through the
// real engine and factory and compares what reaches fetch.

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const AT = "2026-10-29T08:00:00.000Z";

// One representative payload per executor-factory case.
const SAMPLES: Record<string, Record<string, unknown>> = {
  create: { text: "milk", position: 5, idempotencyKey: "k1", tempId: "temp-1" },
  toggle: { itemId: A, completed: true, at: AT },
  delete: { itemId: A },
  edit: { itemId: A, text: "oat milk" },
  reorder: { orderedIds: [A, B] },
  skip: { itemId: A, skipped: true, at: AT },
  order: { itemId: A, ordered: true, at: AT },
  "set-recurring": { itemId: A, recurring: true },
  "restore-recurring": { itemId: A },
  recycle: { text: "milk", recycleId: A },
  "unskip-all": { itemIds: [A, B] },
  "set-category": { itemId: A, categoryId: B },
  restore: { itemId: A },
};

type Sent = { url: string; method: string; auth: string; body: unknown };

const storage = new Map<string, string>();
let sent: Sent[] = [];

beforeEach(() => {
  resetSyncEngines();
  storage.clear();
  sent = [];
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    sent.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ items: [{ id: B }] }) };
  }));
});

afterEach(() => {
  resetSyncEngines();
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function attach() {
  const engine = getSyncEngine("L");
  engine.attach({ getJwt: () => "jwt", executorFactory: createExecutorFactory() });
  return engine;
}

async function online(type: string): Promise<Sent[]> {
  sent = [];
  attach().add({ id: "m1", type, payload: { listId: "L", ...SAMPLES[type] } });
  await settle();
  return sent;
}

async function afterReload(type: string): Promise<Sent[]> {
  resetSyncEngines();
  sent = [];
  const saved: QueuedMutation = { id: "m1", type, payload: { listId: "L", ...SAMPLES[type] }, timestamp: Date.now() };
  storage.set("mutation_queue:L", JSON.stringify([saved]));
  await attach().flush();
  return sent;
}

describe("mutation request parity: online vs. replay", () => {
  it("has a sample for every executor-factory case", () => {
    const source = readFileSync(resolve(process.cwd(), "src/utils/executor-factory.ts"), "utf8");
    const cases = [...source.matchAll(/case\s*"([a-zA-Z-]+)":/g)].map((m) => m[1]).sort();
    expect(cases.length).toBeGreaterThan(0);
    expect(Object.keys(SAMPLES).sort()).toEqual(cases);
  });

  for (const type of Object.keys(SAMPLES)) {
    it(`"${type}": online and after a reload it sends the same request`, async () => {
      const first = await online(type);
      const replayed = await afterReload(type);

      expect(first).toHaveLength(1);
      expect(first[0].auth).toBe("Bearer jwt");
      expect(replayed).toEqual(first);
    });
  }
});
