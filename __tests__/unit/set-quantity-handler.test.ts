/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi } from "vitest";

// useItemHandlers only uses useCallback, so it runs here as a plain function. If the hook
// starts using other React APIs (useRef, useMemo...), extend this stub.
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
    const s = setup([row({ id: "i1", editor_name: "Someone" }), row({ id: "i2" })]);

    s.handlers.handleSetQuantity("i1", "  2   kg ");

    expect(s.items()[0]).toMatchObject({ id: "i1", quantity: "2 kg", edited_by: "u1", editor_name: null });
    expect(s.items()[1].quantity).toBeUndefined();
    expect(s.mutations).toEqual([
      { id: expect.any(String), type: "set-quantity", payload: { listId: "L1", itemId: "i1", quantity: "2 kg" } },
    ]);
  });

  it("an id captured as the temp id still finds the row once its create landed", () => {
    const s = setup([row({ id: "real-uuid", _tempId: "temp-1" }), row({ id: "i2" })]);

    s.handlers.handleSetQuantity("temp-1", "2");

    expect(s.items()[0]).toMatchObject({ id: "real-uuid", quantity: "2", edited_by: "u1", editor_name: null });
    expect(s.items()[1].quantity).toBeUndefined();
    expect(s.mutations).toEqual([
      { id: expect.any(String), type: "set-quantity", payload: { listId: "L1", itemId: "temp-1", quantity: "2" } },
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

describe("a newly added item", () => {
  it("shows on screen with quantity null, not a missing key", async () => {
    const s = setup([]);

    await s.handlers.handleAddItem("milk");

    expect(s.items()).toHaveLength(1);
    expect(s.items()[0].text).toBe("milk");
    expect("quantity" in s.items()[0]).toBe(true);
    expect(s.items()[0].quantity).toBeNull();
  });
});
