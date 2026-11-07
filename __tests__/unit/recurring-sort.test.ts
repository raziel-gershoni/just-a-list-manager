import { describe, it, expect, vi } from "vitest";

vi.mock("react", async (o) => ({ ...(await o<typeof import("react")>()), useMemo: (fn: () => unknown) => fn() }));

import { useListDerivedData } from "@/src/hooks/useListDerivedData";
import type { ItemData } from "@/src/types";

function row(over: Partial<ItemData> & { id: string }): ItemData {
  return {
    text: over.id, completed: true, completed_at: null, deleted_at: null, skipped_at: null,
    ordered_at: null, recurring: true, position: 1, created_by: null, creator_name: null,
    edited_by: null, editor_name: null, ...over,
  };
}

describe("Recurring drawer order", () => {
  it("lists the staple coming back soonest first: a bought one before a paused one that returns later", () => {
    const now = Date.now();
    const paused = row({
      id: "paused",
      completed_at: new Date(now - 60 * 60 * 1000).toISOString(),
      paused_until: new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const bought = row({ id: "bought", completed_at: new Date(now - 60 * 60 * 1000).toISOString() });

    const { recurringItems } = useListDerivedData([paused, bought], (k) => k);

    expect(recurringItems.map((i) => i.id)).toEqual(["bought", "paused"]);
  });
});
