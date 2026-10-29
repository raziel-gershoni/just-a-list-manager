import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rejoinThenRefresh } from "@/src/hooks/useReconnectOrchestrator";

// The reconnect's last two steps: rejoin realtime, then refresh over HTTP.
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("rejoinThenRefresh", () => {
  it("still refreshes when the rejoin fails, then reports the failure so the reconnect retries", async () => {
    const calls: string[] = [];
    const down = new Error("Resubscribe timed out");
    const rejoin = async () => {
      calls.push("rejoin");
      throw down;
    };
    const refresh = async () => {
      calls.push("refresh");
    };

    await expect(rejoinThenRefresh(rejoin, refresh)).rejects.toBe(down);
    expect(calls).toEqual(["rejoin", "refresh"]);
    expect(console.warn).toHaveBeenCalledWith("[Orchestrator] Rejoin failed, refreshing over HTTP anyway:", down);
  });

  it("reports a failed refresh", async () => {
    const refused = new Error("Background refresh failed: 503");
    await expect(rejoinThenRefresh(async () => {}, async () => { throw refused; })).rejects.toBe(refused);
  });

  it("rejoins, then refreshes, and resolves when both work", async () => {
    const calls: string[] = [];
    await rejoinThenRefresh(async () => { calls.push("rejoin"); }, async () => { calls.push("refresh"); });
    expect(calls).toEqual(["rejoin", "refresh"]);
  });

  it("skips a step no page registered", async () => {
    const refresh = vi.fn(async () => {});
    await rejoinThenRefresh(null, refresh);
    expect(refresh).toHaveBeenCalledTimes(1);
    await expect(rejoinThenRefresh(async () => {}, null)).resolves.toBeUndefined();
  });
});
