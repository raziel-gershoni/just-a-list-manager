/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// Runs the real useRealtimeList with slot-based stand-ins for React's hooks: refs persist
// across calls, effects are recorded and run by the test. The fake client hands the test
// each channel's status callback, so it can play what supabase-js reports.
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
import { useListRealtime } from "@/src/hooks/useListRealtime";

type Status = (s: string, e?: Error) => void;
type FakeChannel = { on: () => FakeChannel; subscribe: (cb: Status) => FakeChannel; cb?: Status };

function fakeClient() {
  const channels: FakeChannel[] = [];
  const client = {
    channel: vi.fn(() => {
      const ch: FakeChannel = {
        on: () => ch,
        subscribe: (cb) => {
          ch.cb = cb;
          return ch;
        },
      };
      channels.push(ch);
      return ch;
    }),
    removeChannel: vi.fn(async () => "ok"),
  };
  return { channels, sb: client as unknown as SupabaseClient };
}

const ref: { current: SupabaseClient | null } = { current: null };
let client: SupabaseClient | null = null;
const render = (sb: SupabaseClient, onRejoined: () => void) => {
  R.i = 0;
  R.effects = [];
  ref.current = client = sb;
  return useRealtimeList(sb, ref, "L", () => {}, undefined, onRejoined);
};
// The subscribe effect is the one that depends on the client.
const subscribe = () => R.effects.find((e) => e.deps?.includes(client))!.fn();

beforeEach(() => {
  R.slots = [];
  R.effects = [];
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a channel that supabase-js rejoins by itself", () => {
  it("asks the page to catch up when the channel is back after an error", () => {
    const { channels, sb } = fakeClient();
    const onRejoined = vi.fn();
    render(sb, onRejoined);
    subscribe();

    channels[0].cb!("SUBSCRIBED");
    expect(onRejoined).not.toHaveBeenCalled();
    channels[0].cb!("CHANNEL_ERROR", new Error("socket closed"));
    channels[0].cb!("SUBSCRIBED");
    expect(onRejoined).toHaveBeenCalledTimes(1);
  });

  it("catches up after a timeout too, once per rejoin", () => {
    const { channels, sb } = fakeClient();
    const onRejoined = vi.fn();
    render(sb, onRejoined);
    subscribe();

    channels[0].cb!("TIMED_OUT");
    channels[0].cb!("SUBSCRIBED");
    channels[0].cb!("SUBSCRIBED");
    expect(onRejoined).toHaveBeenCalledTimes(1);
    channels[0].cb!("CHANNEL_ERROR", new Error("again"));
    channels[0].cb!("SUBSCRIBED");
    expect(onRejoined).toHaveBeenCalledTimes(2);
  });

  it("asks the page to catch up when a channel set up by a reconnect comes back after an error", async () => {
    const { channels, sb } = fakeClient();
    const onRejoined = vi.fn();
    const { resubscribe } = render(sb, onRejoined);
    const done = resubscribe();
    channels[0].cb!("SUBSCRIBED");
    await done;
    expect(onRejoined).not.toHaveBeenCalled();

    channels[0].cb!("CHANNEL_ERROR", new Error("socket closed"));
    channels[0].cb!("SUBSCRIBED");
    expect(onRejoined).toHaveBeenCalledTimes(1);
  });

  it("does not catch up on a first join", () => {
    const { channels, sb } = fakeClient();
    const onRejoined = vi.fn();
    render(sb, onRejoined);
    subscribe();
    channels[0].cb!("SUBSCRIBED");
    expect(onRejoined).not.toHaveBeenCalled();
  });
});

// realtime-js removes a closed channel and never rejoins it, so the list gets a new channel.
describe("a channel that replaces one that was lost", () => {
  it("catches up when it joins after the server closed the old one", async () => {
    const { channels, sb } = fakeClient();
    const onRejoined = vi.fn();
    const { resubscribe } = render(sb, onRejoined);
    subscribe();
    channels[0].cb!("SUBSCRIBED");
    channels[0].cb!("CLOSED");
    expect(onRejoined).not.toHaveBeenCalled();

    const done = resubscribe();
    expect(channels).toHaveLength(2);
    channels[1].cb!("SUBSCRIBED");
    await done;
    expect(onRejoined).toHaveBeenCalledTimes(1);

    channels[1].cb!("SUBSCRIBED");
    expect(onRejoined).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect when the provider replaced the client, and the new client's channel catches up", async () => {
    const old = fakeClient();
    const next = fakeClient();
    const onRejoined = vi.fn();
    const requestReconnect = vi.fn();
    R.i = 0;
    R.effects = [];
    ref.current = client = old.sb;
    const { resubscribe } = useRealtimeList(old.sb, ref, "L", () => {}, requestReconnect, onRejoined);
    subscribe();
    old.channels[0].cb!("SUBSCRIBED");

    // The provider swapped the client, then closed the old client's channels.
    ref.current = client = next.sb;
    old.channels[0].cb!("CLOSED");
    await vi.advanceTimersByTimeAsync(5000);
    expect(requestReconnect).not.toHaveBeenCalled();
    expect(old.sb.removeChannel).not.toHaveBeenCalled();
    expect(onRejoined).not.toHaveBeenCalled();

    const done = resubscribe();
    expect(next.channels).toHaveLength(1);
    next.channels[0].cb!("SUBSCRIBED");
    await done;
    expect(onRejoined).toHaveBeenCalledTimes(1);
  });

  it("catches up when it joins after a reconnect's join failed", async () => {
    const { channels, sb } = fakeClient();
    const onRejoined = vi.fn();
    const { resubscribe } = render(sb, onRejoined);
    const failed = resubscribe();
    const failure = expect(failed).rejects.toThrow("Channel subscribe failed: CHANNEL_ERROR");
    channels[0].cb!("CHANNEL_ERROR", new Error("socket closed"));
    await failure;
    expect(onRejoined).not.toHaveBeenCalled();

    const retry = resubscribe();
    expect(channels).toHaveLength(2);
    channels[1].cb!("SUBSCRIBED");
    await retry;
    expect(onRejoined).toHaveBeenCalledTimes(1);
  });

  it("catches up when it joins after a reconnect's join timed out", async () => {
    const { channels, sb } = fakeClient();
    const onRejoined = vi.fn();
    const { resubscribe } = render(sb, onRejoined);
    const failed = resubscribe();
    const failure = expect(failed).rejects.toThrow("Resubscribe timed out");
    await vi.advanceTimersByTimeAsync(10000);
    await failure;

    const retry = resubscribe();
    channels[1].cb!("SUBSCRIBED");
    await retry;
    expect(onRejoined).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for a channel that was removed on purpose", async () => {
    const { channels, sb } = fakeClient();
    const onRejoined = vi.fn();
    render(sb, onRejoined);
    const cleanup = subscribe() as () => void;
    channels[0].cb!("SUBSCRIBED");
    cleanup();
    channels[0].cb!("CHANNEL_ERROR", new Error("late"));
    channels[0].cb!("SUBSCRIBED");
    expect(onRejoined).not.toHaveBeenCalled();
  });
});

describe("useListRealtime", () => {
  it("passes the page's catch-up on to the channel", () => {
    const { channels, sb } = fakeClient();
    const onRejoined = vi.fn();
    R.i = 0;
    R.effects = [];
    ref.current = client = sb;
    useListRealtime({
      supabaseClient: sb,
      supabaseClientRef: ref,
      listId: "L",
      setItems: () => {},
      setListName: () => {},
      setListType: () => {},
      setListIcon: () => {},
      setListColor: () => {},
      listType: "regular",
      loadCategories: async () => {},
      setCategories: () => {},
      isDraggingRef: { current: false },
      onListDeleted: () => {},
      onRejoined,
    });
    subscribe();
    channels[0].cb!("CHANNEL_ERROR", new Error("socket closed"));
    channels[0].cb!("SUBSCRIBED");
    expect(onRejoined).toHaveBeenCalledTimes(1);
  });
});
