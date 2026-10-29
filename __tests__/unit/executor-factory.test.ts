import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createExecutorFactory } from "@/src/utils/executor-factory";
import type { QueuedMutation } from "@/src/sync/engine";

// The factory is the only executor: the sync engine sends every change through it, online
// and on replay, and drops (with a toast) a type it has no case for. Every type queued by
// useItemHandlers / useListDragDrop needs a case (single-executor.test.ts checks the call
// sites against this file).
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
  "restore",
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
    // Saved before `at` existed: the tap time is the time it was queued.
    expect(JSON.parse(init.body)).toEqual({ itemId: "i1", completed: true, at: "1970-01-01T00:00:00.000Z" });
  });
});

// Toggle, skip and order send the tap time, so a change synced hours later is stamped with
// the time the user made it (the server clamps it to the last 24 hours).
describe("createExecutorFactory - tap time", () => {
  const factory = createExecutorFactory();
  const AT = "2026-10-29T08:15:00.000Z";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["toggle", { completed: true }],
    ["skip", { skipped: true }],
    ["order", { ordered: false }],
  ])("%s sends the payload's tap time", async (type, fields) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await factory({ id: "m", type, payload: { listId: "l1", itemId: "i1", ...fields, at: AT }, timestamp: Date.parse("2026-10-29T11:00:00.000Z") }, () => "jwt")!();

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ itemId: "i1", ...fields, at: AT });
  });

  it("falls back to the time it was queued for an entry saved without one", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await factory({ id: "m", type: "skip", payload: { listId: "l1", itemId: "i1", skipped: true }, timestamp: Date.parse(AT) }, () => "jwt")!();

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).at).toBe(AT);
  });
});

// The engine records a create's real id from what its executor resolves with, and the
// page swaps the temp row for that row.
describe("createExecutorFactory - server rows", () => {
  const factory = createExecutorFactory();
  const row = { id: "00000000-0000-4000-8000-000000000001", text: "milk", position: 7 };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["create", { text: "milk", idempotencyKey: "k", position: 7, tempId: "temp-1" }],
    ["recycle", { text: "milk", recycleId: row.id }],
  ])("%s resolves with the server's row", async (type, fields) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ items: [{ ...row, recycled: type === "recycle" }] }) }));

    await expect(factory({ id: "m", type, payload: { listId: "l1", ...fields }, timestamp: 0 }, () => "jwt")!()).resolves.toMatchObject(row);
  });

  it("create resolves with null when the server created nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ items: [] }) }));

    await expect(factory({ id: "m", type: "create", payload: { listId: "l1", text: "milk", tempId: "temp-1" }, timestamp: 0 }, () => "jwt")!()).resolves.toBeNull();
  });
});

// Undo of an item delete is a queued "restore", so it lands after the delete it undoes.
describe("createExecutorFactory - restore", () => {
  const factory = createExecutorFactory();
  const mutation: QueuedMutation = { id: "m", type: "restore", payload: { listId: "l1", itemId: "i1" }, timestamp: 0 };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHes the item back with deleted_at null", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await factory(mutation, () => "jwt")!();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/lists/l1/items");
    expect(init.method).toBe("PATCH");
    expect(init.headers.Authorization).toBe("Bearer jwt");
    expect(JSON.parse(init.body)).toEqual({ itemId: "i1", deleted_at: null });
  });

  it("throws with the HTTP status when the server rejects it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    await expect(factory(mutation, () => "jwt")!()).rejects.toThrow(/: 503$/);
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

// A drag's new order, sent by the sync engine once every earlier change has landed.
describe("createExecutorFactory - reorder", () => {
  const factory = createExecutorFactory();

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the order to the list's reorder endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await factory({ id: "m", type: "reorder", payload: { listId: "l1", orderedIds: ["a", "b"] }, timestamp: 0 }, () => "jwt")!();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/lists/l1/items/reorder");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer jwt");
    expect(JSON.parse(init.body)).toEqual({ orderedIds: ["a", "b"] });
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
