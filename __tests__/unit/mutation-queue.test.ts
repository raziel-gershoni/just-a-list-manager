import { describe, it, expect, beforeEach } from "vitest";
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

  it("trims oldest items when exceeding 100", () => {
    const queue = new MutationQueue("list-1");
    for (let i = 0; i < 105; i++) {
      queue.enqueue({ id: `m${i}`, type: "add", payload: {} });
    }
    const items = queue.getQueue();
    expect(items).toHaveLength(100);
    // Oldest 5 should have been dropped
    expect(items[0].id).toBe("m5");
    expect(items[99].id).toBe("m104");
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
