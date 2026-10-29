/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

// Runs the real useRealtimeList with slot-based stand-ins for React's hooks: refs persist
// across calls, effects are recorded and run by the test. Nothing renders.
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

import { removeChannelLogged, removeAllChannelsLogged } from "@/src/lib/realtime-cleanup";
import { useRealtimeList } from "@/src/hooks/useRealtimeList";

type Removal = "ok" | "timed out" | "error";
type FakeChannel = { topic: string; on: () => FakeChannel; subscribe: (cb: (s: string, e?: Error) => void) => FakeChannel; cb?: (s: string, e?: Error) => void };

function fakeClient(removal: () => Promise<Removal>) {
  const channels: FakeChannel[] = [];
  const client = {
    channel: vi.fn((name: string) => {
      const ch: FakeChannel = {
        topic: `realtime:${name}`,
        on: () => ch,
        subscribe: (cb) => {
          ch.cb = cb;
          return ch;
        },
      };
      channels.push(ch);
      return ch;
    }),
    removeChannel: vi.fn(removal),
    removeAllChannels: vi.fn(async () => [] as Removal[]),
  };
  return { client, channels, sb: client as unknown as SupabaseClient };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  R.slots = [];
  R.effects = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("removeChannelLogged", () => {
  const channel = { topic: "realtime:list:L:1" } as unknown as RealtimeChannel;

  it.each(["error", "timed out"] as const)("warns with the context when Supabase answers %s", async (answer) => {
    const { client, sb } = fakeClient(async () => answer);
    removeChannelLogged(sb, channel, { listId: "L", reason: "cleanup" });
    await settle();
    expect(client.removeChannel).toHaveBeenCalledWith(channel);
    expect(console.warn).toHaveBeenCalledWith("[Realtime] Remove channel failed:", { listId: "L", reason: "cleanup" }, answer);
  });

  it("warns with the error object when the removal rejects", async () => {
    const boom = new Error("socket gone");
    const { sb } = fakeClient(async () => {
      throw boom;
    });
    removeChannelLogged(sb, channel, { listId: "L", reason: "cleanup" });
    await settle();
    expect(console.warn).toHaveBeenCalledWith("[Realtime] Remove channel failed:", { listId: "L", reason: "cleanup" }, boom);
  });

  it("stays silent on ok", async () => {
    const { sb } = fakeClient(async () => "ok");
    removeChannelLogged(sb, channel, { listId: "L", reason: "cleanup" });
    await settle();
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("removeAllChannelsLogged", () => {
  it("warns with the answers that were not ok", async () => {
    const { client, sb } = fakeClient(async () => "ok");
    client.removeAllChannels.mockResolvedValue(["ok", "timed out", "error"]);
    removeAllChannelsLogged(sb);
    await settle();
    expect(console.warn).toHaveBeenCalledWith("[Realtime] Remove all channels failed:", { total: 3 }, ["timed out", "error"]);
  });

  it("warns with the error object when the removal rejects", async () => {
    const boom = new Error("socket gone");
    const { client, sb } = fakeClient(async () => "ok");
    client.removeAllChannels.mockRejectedValue(boom);
    removeAllChannelsLogged(sb);
    await settle();
    expect(console.warn).toHaveBeenCalledWith("[Realtime] Remove all channels failed:", boom);
  });

  it("stays silent when every channel answers ok", async () => {
    const { client, sb } = fakeClient(async () => "ok");
    client.removeAllChannels.mockResolvedValue(["ok", "ok"]);
    removeAllChannelsLogged(sb);
    await settle();
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("useRealtimeList removes channels through the logged helper", () => {
  const ref: { current: SupabaseClient | null } = { current: null };
  const render = (client: SupabaseClient | null) => {
    R.i = 0;
    R.effects = [];
    ref.current = client;
    return useRealtimeList(client, ref, "L", () => {});
  };
  // The subscribe effect is the one that depends on the client.
  const subscribeEffect = () => R.effects.find((e) => e.deps?.includes(ref))!;

  it("logs a failed removal when the list closes", async () => {
    const { client, channels, sb } = fakeClient(async () => "error");
    render(sb);
    const cleanup = subscribeEffect().fn() as () => void;
    channels[0].cb!("SUBSCRIBED");
    cleanup();
    await settle();
    expect(client.removeChannel).toHaveBeenCalledWith(channels[0]);
    expect(console.warn).toHaveBeenCalledWith("[Realtime] Remove channel failed:", { listId: "L", reason: "cleanup" }, "error");
  });

  it("logs a failed removal of the channel it replaces", async () => {
    const { client, channels, sb } = fakeClient(async () => "timed out");
    render(sb);
    subscribeEffect().fn();
    channels[0].cb!("SUBSCRIBED");
    render(sb);
    subscribeEffect().fn();
    await settle();
    expect(client.removeChannel).toHaveBeenCalledWith(channels[0]);
    expect(console.warn).toHaveBeenCalledWith("[Realtime] Remove channel failed:", { listId: "L", reason: "replaced" }, "timed out");
  });

  it("logs a failed removal of a channel whose resubscribe errored", async () => {
    const { client, channels, sb } = fakeClient(async () => "error");
    const { resubscribe } = render(sb);
    const done = resubscribe();
    channels[0].cb!("CHANNEL_ERROR", new Error("denied"));
    await expect(done).rejects.toThrow("Channel subscribe failed: CHANNEL_ERROR");
    await settle();
    expect(client.removeChannel).toHaveBeenCalledWith(channels[0]);
    expect(console.warn).toHaveBeenCalledWith("[Realtime] Remove channel failed:", { listId: "L", reason: "resubscribe CHANNEL_ERROR" }, "error");
  });

  it("logs a failed removal of a channel whose resubscribe timed out", async () => {
    vi.useFakeTimers();
    const boom = new Error("socket gone");
    const { client, channels, sb } = fakeClient(async () => {
      throw boom;
    });
    const { resubscribe } = render(sb);
    const done = resubscribe();
    const settled = expect(done).rejects.toThrow("Resubscribe timed out");
    await vi.advanceTimersByTimeAsync(10000);
    await settled;
    expect(client.removeChannel).toHaveBeenCalledWith(channels[0]);
    expect(console.warn).toHaveBeenCalledWith("[Realtime] Remove channel failed:", { listId: "L", reason: "resubscribe timed out" }, boom);
  });
});

// The helpers are the one code path for channel removal: a bare call drops Supabase's
// "error" / "timed out" answer on the floor.
describe("no bare channel removal in app code", () => {
  const ROOT = process.cwd();
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "node_modules" ? [] : walk(path);
      return /\.(ts|tsx)$/.test(name) ? [relative(ROOT, path)] : [];
    });

  it("every removeChannel / removeAllChannels call goes through src/lib/realtime-cleanup.ts", () => {
    const bare = ["app", "src", "components", "lib"]
      .flatMap((d) => walk(join(ROOT, d)))
      .filter((f) => f !== join("src", "lib", "realtime-cleanup.ts"))
      .flatMap((f) =>
        readFileSync(join(ROOT, f), "utf8")
          .split("\n")
          .flatMap((line, n) => (/\.(removeChannel|removeAllChannels)\(/.test(line) ? [`${f}:${n + 1}`] : []))
      );
    expect(bare).toEqual([]);
  });
});
