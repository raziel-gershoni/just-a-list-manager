/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi } from "vitest";

// useItemHandlers only uses useCallback, so it runs here as a plain function.
vi.mock("react", () => ({ useCallback: (fn: unknown) => fn }));

import { useItemHandlers } from "@/src/hooks/useItemHandlers";
import type { ItemData } from "@/src/types";

function row(over: Partial<ItemData> & { id: string }): ItemData {
  return {
    text: over.id, completed: false, completed_at: null, deleted_at: null, skipped_at: null,
    ordered_at: null, recurring: false, position: 1, created_by: null, creator_name: null,
    edited_by: null, editor_name: null, ...over,
  };
}

function setup(initial: ItemData[]) {
  let items = initial;
  const mutations: { id: string; type: string; payload: Record<string, unknown> }[] = [];
  const handlers = useItemHandlers({
    listId: "L1",
    jwtRef: { current: "jwt" },
    userId: "u1",
    items,
    setItems: (u) => { items = typeof u === "function" ? u(items) : u; },
    addMutation: (m) => void mutations.push(m),
    setUndoAction: () => {},
    setDuplicateWarning: () => {},
    setReminderToast: () => {},
    setErrorToast: () => {},
    t: (key: string) => key,
  });
  return { handlers, mutations, items: () => items };
}

describe("handleSetQuantity", () => {
  it("stores the normalized quantity on the item and queues one set-quantity mutation", () => {
    const s = setup([row({ id: "i1" }), row({ id: "i2" })]);

    s.handlers.handleSetQuantity("i1", "  2   kg ");

    expect(s.items()[0]).toMatchObject({ id: "i1", quantity: "2 kg", edited_by: "u1" });
    expect(s.items()[1].quantity).toBeUndefined();
    expect(s.mutations).toEqual([
      { id: expect.any(String), type: "set-quantity", payload: { listId: "L1", itemId: "i1", quantity: "2 kg" } },
    ]);
  });

  it("a blank quantity clears it to null, never an empty string", () => {
    const s = setup([row({ id: "i1", quantity: "2 kg" })]);

    s.handlers.handleSetQuantity("i1", "  ");

    expect(s.items()[0].quantity).toBeNull();
    expect(s.mutations).toEqual([
      { id: expect.any(String), type: "set-quantity", payload: { listId: "L1", itemId: "i1", quantity: null } },
    ]);
  });

  it("null clears it too", () => {
    const s = setup([row({ id: "i1", quantity: "3" })]);

    s.handlers.handleSetQuantity("i1", null);

    expect(s.items()[0].quantity).toBeNull();
    expect(s.mutations[0].payload).toEqual({ listId: "L1", itemId: "i1", quantity: null });
  });
});
