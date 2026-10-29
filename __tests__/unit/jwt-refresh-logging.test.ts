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

import { useJWTRefresh, isInitDataFresh, readStoredToken, tokenAgeMs } from "@/src/hooks/useJWTRefresh";

const isWebAppRef = { current: false };
const render = () => {
  R.i = 0;
  return useJWTRefresh(isWebAppRef);
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

let local: Map<string, string>;
let session: Map<string, string>;
const storage = (m: Map<string, string>) => ({
  getItem: (k: string) => m.get(k) ?? null,
  setItem: (k: string, v: string) => void m.set(k, v),
  removeItem: (k: string) => void m.delete(k),
});

beforeEach(() => {
  R.slots = [];
  isWebAppRef.current = false;
  local = new Map();
  session = new Map();
  vi.stubGlobal("localStorage", storage(local));
  vi.stubGlobal("sessionStorage", storage(session));
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
    await expect(render().fetchToken(INIT_DATA)).resolves.toEqual({ kind: "unauthorized" });
    expect(console.warn).toHaveBeenCalledWith("[TelegramProvider] Token request failed:", { mode: "initData", status: 401 });
    expect(logged()).not.toContain("secret-hash");
  });

  it("logs the status of a refused token refresh, never the token", async () => {
    const f = stubToken({ ok: false, status: 503 });
    const hook = render();
    hook.jwtRef.current = OLD_JWT;
    await expect(hook.fetchToken(null)).resolves.toEqual({ kind: "transient" });
    expect(f).toHaveBeenCalledWith("/api/auth/token", { headers: { Authorization: `Bearer ${OLD_JWT}` } });
    expect(console.warn).toHaveBeenCalledWith("[TelegramProvider] Token request failed:", { mode: "bearer", status: 503 });
    expect(logged()).not.toContain(OLD_JWT);
  });

  it("logs nothing and keeps the new token when the server says yes", async () => {
    stubToken({ ok: true, status: 200, token: "new.jwt" });
    const hook = render();
    await expect(hook.fetchToken(INIT_DATA)).resolves.toEqual({ kind: "ok", token: "new.jwt" });
    expect(hook.jwtRef.current).toBe("new.jwt");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("sends nothing and logs nothing with neither a token nor initData", async () => {
    const f = stubToken({ ok: true, status: 200, token: "x" });
    await expect(render().fetchToken(null)).resolves.toEqual({ kind: "unauthorized" });
    expect(f).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });
});

// Only a refusal may end a session (H1): everything that can pass on retry is "transient".
describe("useJWTRefresh tells a refusal from a failure that may pass", () => {
  it.each([429, 500, 502, 503, 408])("a %s is transient and the token is kept", async (status) => {
    stubToken({ ok: false, status });
    const hook = render();
    hook.jwtRef.current = OLD_JWT;
    await expect(hook.fetchToken(null)).resolves.toEqual({ kind: "transient" });
    expect(hook.jwtRef.current).toBe(OLD_JWT);
  });

  it("a network failure is transient, keeps the token, and is logged without it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Load failed");
    }));
    const hook = render();
    hook.jwtRef.current = OLD_JWT;
    await expect(hook.fetchToken(null)).resolves.toEqual({ kind: "transient" });
    expect(hook.jwtRef.current).toBe(OLD_JWT);
    expect(console.error).toHaveBeenCalledWith("[TelegramProvider] Token fetch error:", { mode: "bearer" }, expect.any(TypeError));
    expect(logged()).not.toContain(OLD_JWT);
  });

  it("an answer without a token is transient", async () => {
    stubToken({ ok: true, status: 200 });
    await expect(render().fetchToken(INIT_DATA)).resolves.toEqual({ kind: "transient" });
  });
});

describe("useJWTRefresh stores the token where the next load finds it (H2)", () => {
  it("the Mini App keeps it in sessionStorage, for a reload of this tab", async () => {
    stubToken({ ok: true, status: 200, token: "new.jwt" });
    await render().fetchToken(INIT_DATA);
    expect(session.get("tg_auth_token")).toBe("new.jwt");
    expect(local.size).toBe(0);
    expect(readStoredToken(false)).toBe("new.jwt");
  });

  it("the web app keeps it in localStorage, as its login", async () => {
    isWebAppRef.current = true;
    stubToken({ ok: true, status: 200, token: "new.jwt" });
    await render().fetchToken(INIT_DATA);
    expect(local.get("web_auth_token")).toBe("new.jwt");
    expect(session.size).toBe(0);
  });

  it("clearJwt drops the refused token from memory and storage", () => {
    session.set("tg_auth_token", OLD_JWT);
    const hook = render();
    hook.setToken(OLD_JWT);
    hook.clearJwt();
    expect(hook.jwtRef.current).toBeNull();
    expect(render().jwt).toBeNull();
    expect(session.has("tg_auth_token")).toBe(false);
  });

  it("storage that throws is logged, never fatal", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    });
    const hook = render();
    expect(() => hook.setToken("t")).not.toThrow();
    expect(hook.jwtRef.current).toBe("t");
    expect(readStoredToken(false)).toBeNull();
    expect(console.warn).toHaveBeenCalledWith("[TelegramProvider] Could not store the token:", { isWebApp: false }, expect.any(Error));
  });
});

describe("token and initData age", () => {
  const NOW = new Date("2026-10-29T08:00:00.000Z").getTime();
  const at = (ms: number) => `auth_date=${Math.floor(ms / 1000)}&hash=h`;

  it("initData is fresh for 5 minutes after its auth_date", () => {
    expect(isInitDataFresh(at(NOW - 4 * 60 * 1000), NOW)).toBe(true);
    expect(isInitDataFresh(at(NOW - 6 * 60 * 1000), NOW)).toBe(false);
    expect(isInitDataFresh("hash=h", NOW)).toBe(false);
  });

  it("a token's age comes from its iat; an unreadable one counts as too old", () => {
    const token = `h.${btoa(JSON.stringify({ iat: Math.floor((NOW - 3600 * 1000) / 1000) }))}.s`;
    expect(tokenAgeMs(token, NOW)).toBe(3600 * 1000);
    expect(tokenAgeMs("not-a-jwt", NOW)).toBe(Infinity);
  });
});
