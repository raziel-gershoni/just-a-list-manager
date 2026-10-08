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

// Regression: a "toggle" mutation queued while offline for a recurring Done tap
// must replay through complete-recurring on reload, exactly like the inline
// closure in useItemHandlers.ts does. If the rebuilt executor instead does a
// plain PATCH, the item is marked done and no successor is ever created — the
// series ends silently and the queue reports success. See FINDING 2 in
// docs/superpowers/specs/2026-09-15-recurring-occurrence-integrity-design.md.
describe("createExecutorFactory - toggle routing", () => {
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

  it("routes a toggle payload carrying recurrence + remindAt to complete-recurring", async () => {
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
    expect(url).toBe("/api/lists/l1/items/i1/complete-recurring");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      remindAt: "2026-09-20T04:30:00.000Z",
      recurrence: "weekly",
      isShared: false,
    });
  });

  it("routes a plain toggle payload (no recurrence context) to the items PATCH", async () => {
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
