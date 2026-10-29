/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Runs the real useJWTRefresh with slot-based stand-ins for React's hooks.
const R = vi.hoisted(() => ({ slots: [] as { value: unknown }[], i: 0 }));
vi.mock("react", () => ({
  useState: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: init };
    const slot = R.slots[i];
    return [slot.value, (v: unknown) => { slot.value = v; }];
  },
  useRef: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: { current: init } };
    return R.slots[i].value;
  },
  useCallback: (fn: unknown) => (R.i++, fn),
}));

import { useJWTRefresh } from "@/src/hooks/useJWTRefresh";

const render = () => {
  R.i = 0;
  return useJWTRefresh();
};
const INIT_DATA = "query_id=q&user=%7B%7D&hash=secret-hash";
const OLD_JWT = "old.jwt.value";

function stubToken(reply: { ok: boolean; status: number; token?: string }) {
  const f = vi.fn(async () => ({ ok: reply.ok, status: reply.status, json: async () => ({ token: reply.token }) }));
  vi.stubGlobal("fetch", f);
  return f;
}
// Every argument of every console call, flattened to text.
const logged = () =>
  [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls]
    .flat()
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");

beforeEach(() => {
  R.slots = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useJWTRefresh logs a refused token request", () => {
  it("logs the status of a refused Mini App sign-in, never the initData", async () => {
    stubToken({ ok: false, status: 401 });
    await expect(render().fetchToken(INIT_DATA)).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalledWith("[TelegramProvider] Token request failed:", { mode: "initData", status: 401 });
    expect(logged()).not.toContain("secret-hash");
  });

  it("logs the status of a refused token refresh, never the token", async () => {
    const f = stubToken({ ok: false, status: 503 });
    const hook = render();
    hook.jwtRef.current = OLD_JWT;
    await expect(hook.fetchToken(null)).resolves.toBeNull();
    expect(f).toHaveBeenCalledWith("/api/auth/token", { headers: { Authorization: `Bearer ${OLD_JWT}` } });
    expect(console.warn).toHaveBeenCalledWith("[TelegramProvider] Token request failed:", { mode: "bearer", status: 503 });
    expect(logged()).not.toContain(OLD_JWT);
  });

  it("logs nothing and keeps the new token when the server says yes", async () => {
    stubToken({ ok: true, status: 200, token: "new.jwt" });
    const hook = render();
    await expect(hook.fetchToken(INIT_DATA)).resolves.toBe("new.jwt");
    expect(hook.jwtRef.current).toBe("new.jwt");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("sends nothing and logs nothing with neither a token nor initData", async () => {
    const f = stubToken({ ok: true, status: 200, token: "x" });
    await expect(render().fetchToken(null)).resolves.toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });
});
