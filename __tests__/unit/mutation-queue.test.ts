import { describe, it, expect, beforeEach, vi } from "vitest";
import { MutationQueue } from "@/src/utils/mutation-queue";

const storage = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
  get length() {
    return storage.size;
  },
  key: (index: number) => [...storage.keys()][index] ?? null,
};

beforeEach(() => {
  storage.clear();
  Object.defineProperty(globalThis, "localStorage", {
    value: localStorageMock,
    writable: true,
  });
});

describe("MutationQueue", () => {
  it("getQueue returns empty array when no items", () => {
    const queue = new MutationQueue("list-1");
    expect(queue.getQueue()).toEqual([]);
  });

  it("getQueue skips stored entries it can't use, and logs each one", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const valid = { id: "a", type: "toggle", payload: { itemId: "i1" }, timestamp: 1 };
    storage.set(
      "mutation_queue:list-1",
      JSON.stringify([{ id: "b", type: "toggle", payload: null, timestamp: 1 }, valid, 7, { id: "c", payload: {}, timestamp: 1 }])
    );
    const queue = new MutationQueue("list-1");

    expect(queue.getQueue()).toEqual([valid]);
    expect(errors).toHaveBeenCalledTimes(3);
    errors.mockRestore();
  });

  it("getQueue treats a stored value that isn't a list as empty, and logs it", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    storage.set("mutation_queue:list-1", JSON.stringify({ id: "a" }));
    const queue = new MutationQueue("list-1");

    expect(queue.getQueue()).toEqual([]);
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it("load hands back what it skipped and saves the queue without it", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const valid = { id: "a", type: "toggle", payload: { itemId: "i1" }, timestamp: 1 };
    storage.set("mutation_queue:list-1", JSON.stringify([{ id: "b", type: "toggle", payload: null }, valid]));
    const queue = new MutationQueue("list-1");

    const { entries, skipped } = queue.load();

    expect(entries).toEqual([valid]);
    expect(skipped).toEqual([{ id: "b", type: "toggle", payload: null }]);
    expect(JSON.parse(storage.get("mutation_queue:list-1")!)).toEqual([valid]);
    vi.restoreAllMocks();
  });

  it("enqueue adds items to queue", () => {
    const queue = new MutationQueue("list-1");
    queue.enqueue({ id: "m1", type: "add", payload: { text: "milk" } });
    const items = queue.getQueue();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("m1");
    expect(items[0].type).toBe("add");
    expect(items[0].payload).toEqual({ text: "milk" });
  });

  it("enqueue assigns a timestamp", () => {
    const queue = new MutationQueue("list-1");
    const before = Date.now();
    queue.enqueue({ id: "m1", type: "add", payload: {} });
    const after = Date.now();
    const items = queue.getQueue();
    expect(items[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(items[0].timestamp).toBeLessThanOrEqual(after);
  });

  it("dequeue removes specific item", () => {
    const queue = new MutationQueue("list-1");
    queue.enqueue({ id: "m1", type: "add", payload: {} });
    queue.enqueue({ id: "m2", type: "add", payload: {} });
    queue.dequeue("m1");
    const items = queue.getQueue();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("m2");
  });

  it("getQueue returns items in insertion order", () => {
    const queue = new MutationQueue("list-1");
    queue.enqueue({ id: "m1", type: "add", payload: {} });
    queue.enqueue({ id: "m2", type: "edit", payload: {} });
    queue.enqueue({ id: "m3", type: "delete", payload: {} });
    const items = queue.getQueue();
    expect(items.map((i) => i.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("clear removes all items", () => {
    const queue = new MutationQueue("list-1");
    queue.enqueue({ id: "m1", type: "add", payload: {} });
    queue.enqueue({ id: "m2", type: "add", payload: {} });
    queue.clear();
    expect(queue.getQueue()).toEqual([]);
  });

  it("trims oldest items when exceeding 500, and hands them to onEvict", () => {
    const queue = new MutationQueue("list-1");
    const evicted: string[] = [];
    for (let i = 0; i < 505; i++) {
      queue.enqueue({ id: `m${i}`, type: "add", payload: {} }, (gone) => evicted.push(...gone.map((m) => m.id)));
    }
    const items = queue.getQueue();
    expect(items).toHaveLength(500);
    // Oldest 5 should have been dropped, and reported
    expect(items[0].id).toBe("m5");
    expect(items[499].id).toBe("m504");
    expect(evicted).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  it("rewritePayloads saves rewritten payloads and leaves untouched entries as they were", () => {
    const queue = new MutationQueue("list-1");
    queue.enqueue({ id: "m1", type: "toggle", payload: { itemId: "temp-1" } });
    queue.enqueue({ id: "m2", type: "toggle", payload: { itemId: "i2" } });
    queue.rewritePayloads((p) => (p.itemId === "temp-1" ? { ...p, itemId: "real-1" } : p));
    expect(queue.getQueue().map((m) => m.payload.itemId)).toEqual(["real-1", "i2"]);
  });

  it("maintains independent queues for different listIds", () => {
    const q1 = new MutationQueue("list-a");
    const q2 = new MutationQueue("list-b");
    q1.enqueue({ id: "m1", type: "add", payload: { list: "a" } });
    q2.enqueue({ id: "m2", type: "add", payload: { list: "b" } });

    expect(q1.getQueue()).toHaveLength(1);
    expect(q1.getQueue()[0].id).toBe("m1");
    expect(q2.getQueue()).toHaveLength(1);
    expect(q2.getQueue()[0].id).toBe("m2");
  });

  it("enqueue returns the mutation id", () => {
    const queue = new MutationQueue("list-1");
    const id = queue.enqueue({ id: "m1", type: "add", payload: {} });
    expect(id).toBe("m1");
  });

  it("dequeue on non-existent id does not affect queue", () => {
    const queue = new MutationQueue("list-1");
    queue.enqueue({ id: "m1", type: "add", payload: {} });
    queue.dequeue("non-existent");
    expect(queue.getQueue()).toHaveLength(1);
  });
});
