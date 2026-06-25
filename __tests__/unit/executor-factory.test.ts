import { describe, it, expect } from "vitest";
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
