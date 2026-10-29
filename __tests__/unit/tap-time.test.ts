/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// useItemHandlers only uses useCallback, and React's own throws outside a render.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (fn: unknown) => fn,
}));
vi.mock("@/src/types/telegram", () => ({ getTelegramWebApp: () => null }));

import { useItemHandlers } from "@/src/hooks/useItemHandlers";
import type { ItemData } from "@/src/types";

// Toggle, skip and order carry the tap time (`at`), which the server stamps completed_at /
// skipped_at / ordered_at with, so a change that syncs hours later keeps the time it was made
// (H19). The screen shows the same time.
const TAP = "2026-10-29T08:15:00.000Z";

function world() {
  let items: ItemData[] = [
    {
      id: "i1", text: "milk", completed: false, completed_at: null, deleted_at: null, skipped_at: null, ordered_at: null,
      recurring: false, position: 1, created_by: null, creator_name: null, edited_by: null, editor_name: null,
    },
  ];
  const queued: { type: string; payload: Record<string, unknown> }[] = [];
  const h = useItemHandlers({
    listId: "L",
    jwtRef: { current: "jwt" },
    userId: "u",
    items,
    setItems: (u) => { items = typeof u === "function" ? u(items) : u; },
    addMutation: (m) => queued.push(m),
    setUndoAction: () => {},
    setDuplicateWarning: () => {},
    setReminderToast: () => {},
    setErrorToast: () => {},
    t: (key) => key,
  });
  return { h, queued, item: () => items[0] };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(TAP));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("changes carry the time of the tap (H19)", () => {
  it("a tick sends the tap time, and shows it, even when its animation ends later", async () => {
    const w = world();
    const ticking = w.h.handleToggle("i1", true);
    await vi.advanceTimersByTimeAsync(200);
    await ticking;

    expect(w.queued).toEqual([{ id: expect.any(String), type: "toggle", payload: { listId: "L", itemId: "i1", completed: true, at: TAP } }]);
    expect(w.item().completed_at).toBe(TAP);
  });

  it("a skip sends the tap time", () => {
    const w = world();
    w.h.handleSkip("i1", true);

    expect(w.queued[0].payload).toEqual({ listId: "L", itemId: "i1", skipped: true, at: TAP });
    expect(w.item().skipped_at).toBe(TAP);
  });

  it("marking on the way sends the tap time", () => {
    const w = world();
    w.h.handleOrder("i1", true);

    expect(w.queued[0].payload).toEqual({ listId: "L", itemId: "i1", ordered: true, at: TAP });
    expect(w.item().ordered_at).toBe(TAP);
  });
});
