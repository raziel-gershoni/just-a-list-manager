/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Runs the real useReconnectOrchestrator with a slot-based stand-in for React: state and refs
// persist across calls, callbacks are returned as given, effects are not run (the test calls
// reconnect() itself). Timers are faked so the 2 s retry does not fire.
type Slot = { value?: unknown; current?: unknown };
const R = vi.hoisted(() => ({ slots: [] as Slot[], i: 0 }));
vi.mock("react", () => ({
  useState: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: init };
    const slot = R.slots[i];
    return [slot.value, (u: unknown) => { slot.value = typeof u === "function" ? (u as (p: unknown) => unknown)(slot.value) : u; }];
  },
  useRef: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { current: init };
    return R.slots[i];
  },
  useCallback: (fn: unknown) => (R.i++, fn),
  useEffect: () => { R.i++; },
}));

import { useReconnectOrchestrator } from "@/src/hooks/useReconnectOrchestrator";

type Params = Parameters<typeof useReconnectOrchestrator>[0];

const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
};

// A healthy Mini App session whose list page registered its three steps.
function session(steps: { rejoin: () => Promise<void>; refresh: () => Promise<void> }) {
  const params = {
    fetchToken: async () => ({ kind: "ok", token: "jwt" }),
    clearJwt: () => {},
    jwtRef: { current: "jwt" },
    syncRealtime: () => {},
    isWebAppRef: { current: false },
    onFlushNeededRef: { current: async () => {} },
    onResubscribeNeededRef: { current: steps.rejoin },
    onRefreshNeededRef: { current: steps.refresh },
    router: { push: () => {} },
  } as unknown as Params;
  const render = () => {
    R.i = 0;
    return useReconnectOrchestrator(params);
  };
  // The launch sign-in ends the "initializing" state; reconnect() waits for it.
  const launch = async () => {
    await render().startSession();
    await settle();
  };
  return { render, launch };
}


beforeEach(() => {
  R.slots = [];
  vi.useFakeTimers();
  vi.stubGlobal("window", {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a reconnect whose realtime rejoin fails", () => {
  it("still refreshes the list over HTTP and keeps reporting that it is reconnecting", async () => {
    const refresh = vi.fn(async () => {});
    const s = session({ rejoin: async () => { throw new Error("Resubscribe timed out"); }, refresh });
    await s.launch();
    s.render().reconnect();
    await settle();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(s.render().connectionStatus).toBe("connecting");
  });
});

describe("a reconnect whose refresh fails", () => {
  it("does not report connected", async () => {
    const s = session({ rejoin: async () => {}, refresh: async () => { throw new Error("Background refresh failed: 503"); } });
    await s.launch();
    s.render().reconnect();
    await settle();

    expect(s.render().connectionStatus).toBe("connecting");
  });

  it("reports connected when every step works", async () => {
    const s = session({ rejoin: async () => {}, refresh: async () => {} });
    await s.launch();
    s.render().reconnect();
    await settle();

    expect(s.render().connectionStatus).toBe("connected");
  });
});
