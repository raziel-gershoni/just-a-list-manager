import { describe, it, expect, vi, afterEach } from "vitest";

// A Home reorder's request is a change on its way: Home sets aside a background load that
// left before it lands (app/(app)/page.tsx trackChange), or the old order would come back.
vi.mock("react", () => ({
  useRef: (init: unknown) => ({ current: init }),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
}));

import { useListsDragDrop } from "@/src/hooks/useListsDragDrop";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Home reorder", () => {
  it("hands its request to trackChange", async () => {
    const sent = Promise.resolve({ ok: true, status: 200 });
    vi.stubGlobal("fetch", vi.fn(() => sent));
    const tracked: Promise<unknown>[] = [];
    const trackChange = <R,>(request: Promise<R>): Promise<R> => {
      tracked.push(request);
      return request;
    };
    const lists = [{ id: "A" }, { id: "B" }, { id: "C" }];
    const { handleDragEnd } = useListsDragDrop({
      lists,
      setLists: () => {},
      jwtRef: { current: "jwt" },
      onReorderFailed: () => {},
      trackChange,
    });

    (handleDragEnd as (e: unknown) => void)({
      canceled: false,
      operation: { source: { id: "C", sortable: { index: 0 } }, target: { id: "A" } },
    });

    expect(fetch).toHaveBeenCalledWith("/api/lists/reorder", expect.objectContaining({ method: "POST" }));
    expect(tracked).toEqual([sent]);
    expect(tracked[0]).toBe(sent);
  });
});
