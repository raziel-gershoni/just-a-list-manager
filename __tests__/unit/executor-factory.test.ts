import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createExecutorFactory } from "@/src/utils/executor-factory";
import type { QueuedMutation } from "@/src/utils/mutation-queue";

// Every mutation type enqueued by useItemHandlers must have a factory case,
// otherwise offline replay (which rebuilds executors via this factory) silently
// drops the mutation. Keep this list in sync with useItemHandlers.ts.
const REPLAYABLE_TYPES = [
  "create",
  "toggle",
  "delete",
  "edit",
  "reorder",
  "skip",
  "order",
  "set-recurring",
  "restore-recurring",
  "recycle",
  "unskip-all",
  "set-category",
];

function makeMutation(type: string): QueuedMutation {
  return { id: "m1", type, payload: { listId: "l1", itemId: "i1" }, timestamp: 0 };
}

describe("createExecutorFactory", () => {
  const factory = createExecutorFactory();
  const getJwt = () => "jwt";

  for (const type of REPLAYABLE_TYPES) {
    it(`returns a non-null executor for "${type}" mutations`, () => {
      expect(typeof factory(makeMutation(type), getJwt)).toBe("function");
    });
  }

  it("returns null for unknown mutation types", () => {
    expect(factory(makeMutation("bogus"), getJwt)).toBeNull();
  });
});

// Offline replay of a toggle is a plain PATCH to the items route. A toggle queued
// by an older version of the app (the queue keeps mutations for up to 24 hours) can
// still carry remindAt / recurrence / isShared in its stored payload. Those keys
// must be ignored: the item is marked done and nothing is sent to the removed
// complete-recurring route, which would 404 and make the queue drop the tap.
describe("createExecutorFactory - toggle", () => {
  const factory = createExecutorFactory();
  const getJwt = () => "jwt";
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes a plain toggle payload to the items PATCH", async () => {
    const mutation: QueuedMutation = {
      id: "m2",
      type: "toggle",
      payload: { listId: "l1", itemId: "i1", completed: true },
      timestamp: 0,
    };

    const executor = factory(mutation, getJwt);
    await executor!();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/lists/l1/items");
    expect(init.method).toBe("PATCH");
  });

  it("replays a stale queued toggle that still carries remindAt/recurrence as a plain PATCH", async () => {
    const mutation: QueuedMutation = {
      id: "m1",
      type: "toggle",
      payload: {
        listId: "l1",
        itemId: "i1",
        completed: true,
        remindAt: "2026-09-20T04:30:00.000Z",
        recurrence: "weekly",
        isShared: false,
      },
      timestamp: 0,
    };

    const executor = factory(mutation, getJwt);
    await executor!();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/lists/l1/items");
    expect(init.method).toBe("PATCH");
    expect(init.headers.Authorization).toBe("Bearer jwt");
    expect(JSON.parse(init.body)).toEqual({ itemId: "i1", completed: true });
  });
});

// "Restore all" on the Not available section: a tap made offline must still
// reach the bulk endpoint after a reload, and a failed response must throw with
// the status so the queue can tell retry (5xx) from drop (4xx).
describe("createExecutorFactory - unskip-all", () => {
  const factory = createExecutorFactory();
  const mutation: QueuedMutation = {
    id: "m3",
    type: "unskip-all",
    payload: { listId: "l1", itemIds: ["a", "b"] },
    timestamp: 0,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the tapped item ids to the list's unskip-all endpoint with the current JWT", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await factory(mutation, () => "jwt-now")!();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/lists/l1/items/unskip-all");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer jwt-now");
    expect(JSON.parse(init.body)).toEqual({ itemIds: ["a", "b"] });
  });

  it("throws with the HTTP status when the server rejects it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    await expect(factory(mutation, () => "jwt")!()).rejects.toThrow(/: 500$/);
  });
});

// Dropping an item under another category while offline must still reach the
// server after a reload, as the same PATCH the drag hook sends online.
describe("createExecutorFactory - set-category", () => {
  const factory = createExecutorFactory();
  const mutation: QueuedMutation = {
    id: "m",
    type: "set-category",
    payload: { listId: "l1", itemId: "i1", categoryId: "c1" },
    timestamp: 0,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHes the item with the chosen category", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await factory(mutation, () => "jwt")!();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/lists/l1/items");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ itemId: "i1", categoryId: "c1" });
  });

  it("throws with the HTTP status when the server rejects it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400 }));

    await expect(factory(mutation, () => "jwt")!()).rejects.toThrow(/: 400$/);
  });
});
