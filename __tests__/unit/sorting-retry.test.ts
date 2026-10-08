/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Runs the real useSortingRetry with a minimal slot-based stand-in for React: refs persist
// across renders, effects follow their deps and run (and clean up) synchronously during
// render. Timers are faked, so the test moves the clock. Nothing renders to a DOM.
type Slot = { current?: unknown; deps?: unknown[]; cleanup?: void | (() => void) };
const R = vi.hoisted(() => ({ slots: [] as Slot[], i: 0 }));
vi.mock("react", () => {
  const same = (a?: unknown[], b?: unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
  return {
    useRef: (v: unknown) => {
      const i = R.i++;
      if (!R.slots[i]) R.slots[i] = { current: v };
      return R.slots[i];
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && deps && same(s.deps, deps)) return;
      if (s && typeof s.cleanup === "function") s.cleanup();
      R.slots[i] = { deps, cleanup: fn() };
    },
  };
});

import { useSortingRetry } from "@/src/hooks/useSortingRetry";

type Props = Parameters<typeof useSortingRetry>[0];
const render = (props: Props) => {
  R.i = 0;
  useSortingRetry(props);
};
const unmount = () => {
  for (const s of R.slots) if (typeof s?.cleanup === "function") s.cleanup();
  R.slots = [];
};
const SECOND = 1000;

beforeEach(() => {
  R.slots = [];
  R.i = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
});

describe("useSortingRetry", () => {
  it("re-requests the list 30 s, then 60 s, then 120 s apart while the same items stay unsorted, then stops", () => {
    const refresh = vi.fn();
    render({ sortingIds: ["a", "b"], refresh });

    vi.advanceTimersByTime(30 * SECOND - 1);
    expect(refresh).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    // The refresh hands back a new array of the same items, in another order: same set.
    render({ sortingIds: ["b", "a"], refresh });

    vi.advanceTimersByTime(60 * SECOND - 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(120 * SECOND - 1);
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(60 * 60 * SECOND);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("starts over from the first delay when an item leaves the group", () => {
    const refresh = vi.fn();
    render({ sortingIds: ["a", "b"], refresh });
    vi.advanceTimersByTime(30 * SECOND);
    expect(refresh).toHaveBeenCalledTimes(1);

    render({ sortingIds: ["b"], refresh });
    vi.advanceTimersByTime(30 * SECOND - 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(2);

    // The old schedule's 60 s wait (due 30 s from now) is gone; only the new one runs.
    vi.advanceTimersByTime(60 * SECOND - 1);
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("starts over from the first delay when an item joins the group", () => {
    const refresh = vi.fn();
    render({ sortingIds: ["a"], refresh });
    vi.advanceTimersByTime(20 * SECOND);

    render({ sortingIds: ["a", "c"], refresh });
    vi.advanceTimersByTime(30 * SECOND - 1);
    expect(refresh).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does nothing while no item is waiting to be sorted", () => {
    const refresh = vi.fn();
    render({ sortingIds: [], refresh });
    vi.advanceTimersByTime(60 * 60 * SECOND);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("cancels the wait once every item is sorted", () => {
    const refresh = vi.fn();
    render({ sortingIds: ["a"], refresh });
    vi.advanceTimersByTime(20 * SECOND);

    render({ sortingIds: [], refresh });
    vi.advanceTimersByTime(60 * 60 * SECOND);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("cancels the wait when the list closes", () => {
    const refresh = vi.fn();
    render({ sortingIds: ["a"], refresh });
    vi.advanceTimersByTime(20 * SECOND);

    unmount();
    vi.advanceTimersByTime(60 * 60 * SECOND);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("calls the latest refresh without starting the wait over", () => {
    // refreshItems is rebuilt when the list type changes; the retry must use the new one.
    const first = vi.fn();
    const latest = vi.fn();
    render({ sortingIds: ["a"], refresh: first });
    vi.advanceTimersByTime(20 * SECOND);

    render({ sortingIds: ["a"], refresh: latest });
    vi.advanceTimersByTime(10 * SECOND);
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it("follows the delays it is given", () => {
    const refresh = vi.fn();
    render({ sortingIds: ["a"], refresh, delays: [5, 10] });
    vi.advanceTimersByTime(5);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10);
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60 * 60 * SECOND);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
