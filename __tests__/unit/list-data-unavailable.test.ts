/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Runs the real useListData against a faked network with a slot-based React stand-in
// (state and refs persist across calls, callbacks follow their deps). Nothing renders.
type Slot = { value?: unknown; deps?: unknown[] };
const R = vi.hoisted(() => ({ slots: [] as Slot[], i: 0 }));
vi.mock("react", () => {
  const same = (a?: unknown[], b?: unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
  return {
    useState: (init: unknown) => {
      const i = R.i++;
      if (!R.slots[i]) R.slots[i] = { value: typeof init === "function" ? (init as () => unknown)() : init };
      const slot = R.slots[i];
      const set = (u: unknown) => { slot.value = typeof u === "function" ? (u as (p: unknown) => unknown)(slot.value) : u; };
      return [slot.value, set];
    },
    useRef: (init: unknown) => {
      const i = R.i++;
      if (!R.slots[i]) R.slots[i] = { value: { current: init } };
      return R.slots[i].value;
    },
    useCallback: (fn: unknown, deps: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && same(s.deps, deps)) return s.value;
      R.slots[i] = { value: fn, deps };
      return fn;
    },
    useMemo: (fn: () => unknown) => (R.i++, fn()),
    useEffect: () => void R.i++,
  };
});

import { useListData } from "@/src/hooks/useListData";

const jwtRef: { current: string | null } = { current: "jwt" };
const render = () => { R.i = 0; return useListData("L", jwtRef); };

// The list lookups answer normally; the items GET answers `items`.
function stubFetch(items: () => number | "neterr") {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (url === "/api/lists" || url === "/api/lists?archived=1") return json(200, []);
    if (url.startsWith("/api/lists/L/items")) {
      const reply = items();
      if (reply === "neterr") throw new TypeError("Failed to fetch");
      return reply === 200 ? json(200, { items: [] }) : json(reply, { error: "Access denied" });
    }
    throw new Error(`unexpected ${url}`);
  }));
}

beforeEach(() => {
  R.slots = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a list this user can no longer open", () => {
  it.each([403, 404])("an items answer of %i marks the list as not found", async (status) => {
    stubFetch(() => status);
    await render().fetchItems();
    expect(render()).toMatchObject({ error: true, notFound: true, loading: false });
  });

  it.each([500, 503, 429])("an items answer of %i is an ordinary load error", async (status) => {
    stubFetch(() => status);
    await render().fetchItems();
    expect(render()).toMatchObject({ error: true, notFound: false });
  });

  it("a load that could not be sent is an ordinary load error", async () => {
    stubFetch(() => "neterr");
    await render().fetchItems();
    expect(render()).toMatchObject({ error: true, notFound: false });
  });

  it("a later load that works clears both", async () => {
    let status = 403;
    stubFetch(() => status);
    await render().fetchItems();
    status = 200;
    await render().fetchItems();
    expect(render()).toMatchObject({ error: false, notFound: false });
  });

  it("a load skipped for lack of a session does not keep the not-found view", async () => {
    const status = 403;
    stubFetch(() => status);
    await render().fetchItems();
    expect(render()).toMatchObject({ notFound: true });
    jwtRef.current = null;
    try {
      await render().fetchItems();
      expect(render()).toMatchObject({ error: true, notFound: false, loading: false });
    } finally {
      jwtRef.current = "jwt";
    }
  });
});

describe("a background refresh of a list this user can no longer open (C10)", () => {
  it.each([403, 404])("an items answer of %i shows the not-found view and resolves, so nothing retries it", async (status) => {
    stubFetch(() => 200);
    await render().fetchItems();
    expect(render()).toMatchObject({ error: false, notFound: false });
    stubFetch(() => status);
    await expect(render().refreshItems()).resolves.toBeUndefined();
    expect(render()).toMatchObject({ error: true, notFound: true });
    expect(console.warn).toHaveBeenCalledWith("[List] Background refresh: list unavailable:", { listId: "L", status });
  });

  it("an items answer of 500 still rejects, so the reconnect retries", async () => {
    stubFetch(() => 500);
    await expect(render().refreshItems()).rejects.toThrow();
    expect(render()).toMatchObject({ error: false, notFound: false });
  });
});

describe("a load that starts over an error screen (C22)", () => {
  it("shows the loading state, not an editable empty list, while the request is out", async () => {
    let status = 500;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const json = (st: number, body: unknown) => ({ ok: st < 400, status: st, json: async () => body });
      if (url === "/api/lists" || url === "/api/lists?archived=1") return json(200, []);
      if (status !== 200) return json(status, {});
      await held;
      return json(200, { items: [] });
    }));
    await render().fetchItems();
    expect(render()).toMatchObject({ error: true, loading: false });

    status = 200;
    const pending = render().fetchItems();
    expect(render()).toMatchObject({ loading: true, error: false });
    release();
    await pending;
    expect(render()).toMatchObject({ loading: false, error: false });
  });
});
