/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// The subscribe status callback is not a try/catch handler, so the no-silent-catches guard
// cannot see it. This runs the real useRealtimeList (slot-based React stand-ins, effects run
// by the test) and pins that a failed join is logged with its error.
type Effect = { fn: () => void | (() => void); deps?: unknown[] };
const R = vi.hoisted(() => ({ slots: [] as { current: unknown }[], effects: [] as Effect[], i: 0 }));
vi.mock("react", () => ({
  useRef: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { current: init };
    return R.slots[i];
  },
  useCallback: (fn: unknown) => (R.i++, fn),
  useEffect: (fn: Effect["fn"], deps?: unknown[]) => {
    R.effects.push({ fn, deps });
    R.i++;
  },
}));

import { useRealtimeList } from "@/src/hooks/useRealtimeList";

type Cb = (status: string, err?: Error) => void;

function fakeClient() {
  const callbacks: Cb[] = [];
  const client = {
    channel: vi.fn(() => {
      const ch = { on: () => ch, subscribe: (cb: Cb) => (callbacks.push(cb), ch) };
      return ch;
    }),
    removeChannel: vi.fn(async () => "ok"),
  };
  return { callbacks, sb: client as unknown as SupabaseClient };
}

const ref: { current: SupabaseClient | null } = { current: null };
const render = (client: SupabaseClient) => {
  R.i = 0;
  R.effects = [];
  ref.current = client;
  return useRealtimeList(client, ref, "L", () => {});
};
const runSubscribeEffect = () => R.effects.find((e) => e.deps?.includes("L"))!.fn();

beforeEach(() => {
  R.slots = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("realtime subscribe status callbacks log failures", () => {
  it.each(["CHANNEL_ERROR", "TIMED_OUT"])("a %s on the first join is warned with its error", (status) => {
    const { callbacks, sb } = fakeClient();
    render(sb);
    runSubscribeEffect();
    const err = new Error("denied");
    callbacks[0](status, err);
    expect(console.warn).toHaveBeenCalledWith("[RealtimeList] Subscribe failed:", status, "listId:", "L", err);
  });

  it("a failed join a rejoin waited on is warned with its error", async () => {
    const { callbacks, sb } = fakeClient();
    const { resubscribe } = render(sb);
    const done = resubscribe();
    const err = new Error("denied");
    callbacks[0]("CHANNEL_ERROR", err);
    await expect(done).rejects.toThrow("Channel subscribe failed: CHANNEL_ERROR");
    expect(console.warn).toHaveBeenCalledWith("[RealtimeList] Subscribe failed:", "CHANNEL_ERROR", "listId:", "L", err);
  });

  it("a join and a close the hook asked for are not warned", () => {
    const { callbacks, sb } = fakeClient();
    render(sb);
    const cleanup = runSubscribeEffect() as () => void;
    callbacks[0]("SUBSCRIBED");
    cleanup();
    callbacks[0]("CLOSED");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("a close the server made is warned with the list id", () => {
    const { callbacks, sb } = fakeClient();
    render(sb);
    runSubscribeEffect();
    callbacks[0]("SUBSCRIBED");
    callbacks[0]("CLOSED");
    expect(console.warn).toHaveBeenCalledWith("[RealtimeList] Channel closed by the server, reconnecting", "listId:", "L");
  });
});
