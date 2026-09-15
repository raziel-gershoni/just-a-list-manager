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
