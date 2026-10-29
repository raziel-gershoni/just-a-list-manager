import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";

// Calls the real TelegramProvider, with the real useJWTRefresh and useReconnectOrchestrator,
// as a plain function with slot-based stand-ins for React's hooks: state and refs persist
// across renders, callbacks and effects follow their deps, effects run after the render that
// queued them, and unmount runs every cleanup. The network, storage, the Telegram WebApp and
// the Supabase client are fakes; timers are fake.
type Slot = { value?: unknown; current?: unknown; deps?: unknown[]; cleanup?: void | (() => void) };
const R = vi.hoisted(() => ({ slots: [] as Slot[], i: 0, effects: [] as (() => void)[] }));
vi.mock("react", async (importOriginal) => {
  const same = (a?: unknown[], b?: unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
  return {
    ...(await importOriginal<typeof import("react")>()),
    useState: (init: unknown) => {
      const i = R.i++;
      if (!R.slots[i]) R.slots[i] = { value: typeof init === "function" ? (init as () => unknown)() : init };
      const slot = R.slots[i];
      const set = (u: unknown) => {
        slot.value = typeof u === "function" ? (u as (p: unknown) => unknown)(slot.value) : u;
      };
      return [slot.value, set];
    },
    useRef: (v: unknown) => {
      const i = R.i++;
      if (!R.slots[i]) R.slots[i] = { current: v };
      return R.slots[i];
    },
    useCallback: (fn: unknown, deps: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && same(s.deps, deps)) return s.value;
      R.slots[i] = { value: fn, deps };
      return fn;
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && deps && same(s.deps, deps)) return;
      R.slots[i] = { deps };
      R.effects.push(() => {
        if (typeof s?.cleanup === "function") s.cleanup();
        R.slots[i].cleanup = fn();
      });
    },
  };
});

type FakeClient = {
  token: string;
  heartbeat: (status: string) => void;
  connected: boolean;
  realtime: { isConnected: () => boolean; setAuth: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
  removeAllChannels: ReturnType<typeof vi.fn>;
};
// Stable across renders, like the real hooks' return values.
const H = vi.hoisted(() => ({
  router: { push: (() => {}) as (path: string) => void },
  clients: [] as FakeClient[],
  removeAnswers: [] as string[],
  applyLocale: (() => {}) as (lang: string) => void,
}));
vi.mock("next/navigation", () => ({ useRouter: () => H.router }));
vi.mock("next-intl", () => ({ NextIntlClientProvider: () => null }));
vi.mock("@/src/lib/supabase", () => ({
  createBrowserClient: (token: string, heartbeat: (status: string) => void) => {
    const client: FakeClient = {
      token,
      heartbeat,
      connected: false,
      realtime: { isConnected: () => client.connected, setAuth: vi.fn(async () => {}), disconnect: vi.fn() },
      removeAllChannels: vi.fn(async () => H.removeAnswers),
    };
    H.clients.push(client);
    return client;
  },
}));
vi.mock("@/src/hooks/useLocaleSync", () => ({
  useLocaleSync: () => ({ locale: "en", applyLocale: H.applyLocale, setLanguage: async () => true }),
}));
vi.mock("@/src/hooks/useHomeScreen", () => ({
  useHomeScreen: () => ({ homeScreenStatus: null, setHomeScreenStatus: () => {}, addToHomeScreen: () => {} }),
}));

import TelegramProvider, { useTelegram } from "@/components/TelegramProvider";
import { resetSyncEngines } from "@/src/sync/engine";

type Ctx = ReturnType<typeof useTelegram>;
type El = ReactElement<{ value: Ctx }>;

const LAUNCH = new Date("2026-10-29T08:00:00.000Z").getTime();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const TG_USER = { id: 7, first_name: "A", language_code: "en" };

// A JWT the client can read: the server's claims, a fake signature.
const jwtAt = (issuedMs: number, telegramId = TG_USER.id) =>
  `h.${btoa(JSON.stringify({ iat: Math.floor(issuedMs / 1000), telegram_user_id: telegramId }))}.sig`;
const initDataAt = (authMs: number) =>
  `auth_date=${Math.floor(authMs / 1000)}&user=%7B%22id%22%3A7%7D&hash=secret-hash`;

// How the fake token route answers, one entry per request: a status (200 issues a token),
// a network failure, or held until released.
type Reply = number | "neterr" | "hold";
let tokenReplies: Reply[];
let held: ((status: number) => void) | null;
let issued: string[];
let tokenRequests: Record<string, string>[];
let listRequests: string[];
let userRequests: { method: string; headers: Record<string, string> }[];
let userReply: { status: number; body: unknown };
let push: ReturnType<typeof vi.fn>;
let local: Map<string, string>;
let session: Map<string, string>;
let win: EventTarget & { Telegram?: unknown; location: { pathname: string }; matchMedia: () => { matches: boolean } };

const storage = (m: Map<string, string>) => ({
  getItem: (k: string) => m.get(k) ?? null,
  setItem: (k: string, v: string) => void m.set(k, v),
  removeItem: (k: string) => void m.delete(k),
  get length() {
    return m.size;
  },
  key: (i: number) => [...m.keys()][i] ?? null,
});

function stubNetwork() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { method?: string; headers: Record<string, string> }) => {
    if (url === "/api/auth/token") {
      tokenRequests.push(init.headers);
      const reply = tokenReplies.shift() ?? 503;
      if (reply === "neterr") throw new TypeError("Load failed");
      const status = reply === "hold" ? await new Promise<number>((r) => (held = r)) : reply;
      if (status !== 200) return { ok: false, status, json: async () => ({ error: "x" }) };
      const token = jwtAt(Date.now());
      issued.push(token);
      return { ok: true, status, json: async () => ({ token }) };
    }
    if (url === "/api/user") {
      userRequests.push({ method: init.method ?? "GET", headers: init.headers });
      return { ok: userReply.status === 200, status: userReply.status, json: async () => userReply.body };
    }
    if (url.startsWith("/api/lists/")) {
      listRequests.push(`${init.method ?? "GET"} ${url}`);
      return { ok: true, status: 200, json: async () => ({}) };
    }
    throw new Error(`unexpected ${url}`);
  }));
}

function miniApp(authMs = LAUNCH) {
  win.Telegram = {
    WebApp: {
      initData: initDataAt(authMs),
      initDataUnsafe: { user: TG_USER },
      ready: () => {},
      expand: () => {},
      onEvent: () => {},
      offEvent: () => {},
    },
  };
}

const render = (): Ctx => {
  R.i = 0;
  R.effects = [];
  const el = TelegramProvider({ children: null }) as El;
  for (const run of R.effects) run();
  return el.props.value;
};
// Lets promises and timers run for `ms`, re-rendering between steps as React would.
async function advance(ms = 0): Promise<Ctx> {
  render();
  const step = 250;
  for (let t = 0; t < ms; t += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - t));
    render();
  }
  for (let k = 0; k < 10; k++) {
    await vi.advanceTimersByTimeAsync(0);
    render();
  }
  return render();
}
const unmount = () => {
  for (const s of R.slots) if (typeof s?.cleanup === "function") s.cleanup();
};
const focus = () => win.dispatchEvent(new Event("focus"));
// Requests that signed in with initData, and with a bearer token.
const initDataRequests = () => tokenRequests.filter((h) => "x-telegram-init-data" in h);
const bearerRequests = () => tokenRequests.filter((h) => "Authorization" in h);
const logged = () =>
  [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls]
    .flat()
    .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a)))
    .join(" ");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(LAUNCH);
  R.slots = [];
  H.clients = [];
  H.removeAnswers = [];
  H.applyLocale = () => {};
  tokenReplies = [];
  held = null;
  issued = [];
  tokenRequests = [];
  userRequests = [];
  listRequests = [];
  userReply = { status: 200, body: { id: "user-1", language: "en", telegram_id: 7, first_name: "A" } };
  push = vi.fn();
  H.router.push = push as unknown as (path: string) => void;
  local = new Map();
  session = new Map();
  vi.stubGlobal("localStorage", storage(local));
  vi.stubGlobal("sessionStorage", storage(session));
  win = Object.assign(new EventTarget(), {
    location: { pathname: "/" },
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", Object.assign(new EventTarget(), {
    visibilityState: "visible",
    documentElement: { classList: { add: () => {}, remove: () => {} }, style: { setProperty: () => {} } },
  }));
  stubNetwork();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a failed token refresh keeps the session (H1)", () => {
  it("Mini App: a network failure keeps the JWT, never falls back to stale initData, and the retry refreshes it", async () => {
    miniApp();
    tokenReplies = [200];
    await advance();
    const launchToken = issued[0];
    vi.setSystemTime(LAUNCH + 25 * HOUR); // the token is due for a refresh; the initData is long stale
    tokenReplies = ["neterr", 200];

    focus();
    let ctx = await advance();
    expect(ctx.jwt).toBe(launchToken);
    expect(ctx.jwtRef.current).toBe(launchToken);
    expect(session.get("tg_auth_token")).toBe(launchToken);
    expect(ctx.connectionStatus).toBe("connecting");
    expect(initDataRequests()).toHaveLength(1); // the launch sign-in only

    ctx = await advance(2000);
    expect(bearerRequests().map((h) => h.Authorization)).toEqual([`Bearer ${launchToken}`, `Bearer ${launchToken}`]);
    expect(ctx.jwt).toBe(issued[1]);
    expect(session.get("tg_auth_token")).toBe(issued[1]);
    expect(ctx.connectionStatus).toBe("connected");
  });

  it("web: a 503 on every retry keeps web_auth_token and never goes to /login", async () => {
    local.set("web_auth_token", jwtAt(LAUNCH - HOUR));
    tokenReplies = [200];
    await advance();
    const token = issued[0];
    vi.setSystemTime(LAUNCH + 25 * HOUR);
    tokenReplies = [503, 503, 503, 503, 503];

    focus();
    const ctx = await advance(12000);
    expect(bearerRequests()).toHaveLength(6);
    expect(push).not.toHaveBeenCalled();
    expect(local.get("web_auth_token")).toBe(token);
    expect(ctx.jwt).toBe(token);
    expect(ctx.retryCount).toBe(5);
    expect(ctx.connectionStatus).toBe("connecting"); // the "Connection problems" banner, not "Session expired"
  });

  it("Mini App: only a refused refresh drops the JWT, and initData older than 5 minutes is not tried", async () => {
    miniApp();
    tokenReplies = [200];
    await advance();
    vi.setSystemTime(LAUNCH + 25 * HOUR);
    tokenReplies = [401];

    focus();
    const ctx = await advance();
    expect(tokenRequests).toHaveLength(2); // launch + the refused refresh, no initData retry
    expect(ctx.jwt).toBeNull();
    expect(session.has("tg_auth_token")).toBe(false);
    expect(ctx.connectionStatus).toBe("auth_failed");
  });

  it("web: a refused refresh removes the stored login and goes to /login", async () => {
    local.set("web_auth_token", jwtAt(LAUNCH - HOUR));
    tokenReplies = [200];
    await advance();
    vi.setSystemTime(LAUNCH + 25 * HOUR);
    tokenReplies = [401];

    focus();
    const ctx = await advance();
    expect(local.has("web_auth_token")).toBe(false);
    expect(ctx.jwt).toBeNull();
    expect(push).toHaveBeenCalledWith("/login");
  });

  it("an API refusal inside the first 5 minutes refreshes a young token, then signs in again with the launch initData", async () => {
    miniApp();
    tokenReplies = [200];
    let ctx = await advance();
    vi.setSystemTime(LAUNCH + 2 * MIN);
    tokenReplies = [401, 200];

    ctx.requestTokenRefresh();
    ctx = await advance();
    expect(tokenRequests).toHaveLength(3);
    expect(tokenRequests[1]).toEqual({ Authorization: `Bearer ${issued[0]}` });
    expect(tokenRequests[2]).toEqual({ "x-telegram-init-data": initDataAt(LAUNCH) });
    expect(ctx.jwt).toBe(issued[1]);
    expect(ctx.connectionStatus).toBe("connected");
  });

  it("an API refusal inside the reconnect throttle waits for it instead of being lost", async () => {
    miniApp();
    tokenReplies = [200];
    let ctx = await advance();
    vi.setSystemTime(LAUNCH + 2 * MIN);
    focus(); // a reconnect a moment ago: young token, no request
    ctx = await advance();
    expect(tokenRequests).toHaveLength(1);
    tokenReplies = [200];

    ctx.requestTokenRefresh();
    ctx = await advance(1000);
    expect(tokenRequests).toHaveLength(1);
    ctx = await advance(5000);
    expect(tokenRequests).toHaveLength(2);
    expect(ctx.jwt).toBe(issued[1]);
  });

  // R15: the running sign-in may have asked for its token before the refusal, so one more
  // refresh runs when it ends.
  it("an API refusal during a running reconnect gets one more token refresh when it ends", async () => {
    miniApp();
    tokenReplies = [200];
    let ctx = await advance();
    vi.setSystemTime(LAUNCH + 25 * HOUR); // the reconnect refreshes the day-old token
    tokenReplies = ["hold", 200];
    H.clients[0].heartbeat("timeout");
    ctx = await advance();
    expect(tokenRequests).toHaveLength(2);

    ctx.requestTokenRefresh();
    ctx = await advance(6000); // past the throttle, while the reconnect still waits
    expect(tokenRequests).toHaveLength(2);

    held!(200);
    ctx = await advance();
    expect(tokenRequests).toHaveLength(3);
    expect(tokenRequests[2]).toEqual({ Authorization: `Bearer ${issued[1]}` });
    expect(ctx.jwt).toBe(issued[2]);
    expect(ctx.connectionStatus).toBe("connected");
  });

  it("an API refusal during the launch sign-in gets a token refresh once it ends", async () => {
    miniApp();
    tokenReplies = ["hold", 200];
    let ctx = await advance();

    ctx.requestTokenRefresh();
    ctx = await advance();
    expect(tokenRequests).toHaveLength(1);

    held!(200);
    ctx = await advance();
    expect(tokenRequests).toHaveLength(2);
    expect(tokenRequests[1]).toEqual({ Authorization: `Bearer ${issued[0]}` });
    expect(ctx.jwt).toBe(issued[1]);
    expect(ctx.connectionStatus).toBe("connected");
  });
});

describe("a reconnect asked for during a running one is not lost (R11)", () => {
  // A list's channel the server closed asks for reconnect() while a reconnect is in its refresh
  // step, past the rejoin: the channel it needs would never be started.
  const startRefreshing = async () => {
    miniApp();
    tokenReplies = [200];
    let ctx = await advance();
    let finish!: () => void;
    const refresh = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const resubscribe = vi.fn(async () => {});
    ctx.onResubscribeNeededRef.current = resubscribe;
    ctx.onRefreshNeededRef.current = refresh;
    focus();
    ctx = await advance();
    expect(refresh).toHaveBeenCalledTimes(1);
    return { ctx, refresh, resubscribe, finish: () => finish() };
  };

  it("reconnect() while one is running runs exactly one more when it ends", async () => {
    const { ctx, refresh, resubscribe, finish } = await startRefreshing();
    ctx.reconnect();
    ctx.reconnect();
    await advance();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(logged()).toContain("Reconnect requested while one is running");

    refresh.mockImplementation(async () => {});
    finish();
    await advance(6000);
    expect(resubscribe).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("a focus during a running reconnect queues nothing", async () => {
    const { refresh, finish } = await startRefreshing();
    vi.setSystemTime(Date.now() + 6000);
    focus();
    refresh.mockImplementation(async () => {});
    finish();
    await advance(6000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("a reconnect replays every list, open or not (H15)", () => {
  it("sends a list's saved change after a reconnect when no page is open", async () => {
    miniApp();
    tokenReplies = [200];
    await advance();
    expect(listRequests).toEqual([]);

    // Left parked while offline: this list has no page, and no retry timer is set.
    local.set(
      "mutation_queue:L1",
      JSON.stringify([
        { id: "m1", type: "toggle", payload: { listId: "L1", itemId: "i1", completed: true }, timestamp: Date.now() },
      ])
    );
    vi.setSystemTime(Date.now() + 6000);
    focus();
    await advance(1000);

    expect(listRequests).toEqual(["PATCH /api/lists/L1/items"]);
    expect(JSON.parse(local.get("mutation_queue:L1") ?? "[]")).toEqual([]);
    resetSyncEngines();
  });
});

describe("a reconnect does only what is needed (H1)", () => {
  it("a token younger than a day is not refreshed, and a live socket is kept", async () => {
    miniApp();
    tokenReplies = [200];
    await advance();
    H.clients[0].connected = true;
    vi.setSystemTime(LAUNCH + 3 * HOUR);

    focus();
    const ctx = await advance();
    expect(tokenRequests).toHaveLength(1);
    expect(H.clients).toHaveLength(1);
    expect(H.clients[0].realtime.disconnect).not.toHaveBeenCalled();
    expect(H.clients[0].realtime.setAuth).not.toHaveBeenCalled();
    expect(ctx.connectionStatus).toBe("connected");
  });

  it("a refreshed token is handed to the live socket instead of replacing the client", async () => {
    miniApp();
    tokenReplies = [200];
    await advance();
    H.clients[0].connected = true;
    vi.setSystemTime(LAUNCH + 25 * HOUR);
    tokenReplies = [200];

    focus();
    await advance();
    expect(H.clients).toHaveLength(1);
    expect(H.clients[0].realtime.setAuth).toHaveBeenCalledWith(issued[1]);
    expect(H.clients[0].realtime.disconnect).not.toHaveBeenCalled();
  });

  it("a socket that is down gets a new client with the current token", async () => {
    miniApp();
    tokenReplies = [200];
    await advance();
    vi.setSystemTime(LAUNCH + 3 * HOUR);

    H.clients[0].heartbeat("disconnected");
    const ctx = await advance();
    expect(H.clients).toHaveLength(2);
    expect(H.clients[0].realtime.disconnect).toHaveBeenCalled();
    expect(H.clients[0].removeAllChannels).toHaveBeenCalled();
    expect(H.clients[1].token).toBe(issued[0]);
    expect(ctx.supabaseClient).toBe(H.clients[1]);
  });
});

describe("a Telegram reload keeps the session (H2)", () => {
  it("signs in with the tab's stored JWT, not the launch initData, and loads the user with it", async () => {
    const stored = jwtAt(LAUNCH - 10 * MIN);
    session.set("tg_auth_token", stored);
    miniApp(LAUNCH - 10 * MIN); // the reload reuses initData from 10 minutes ago
    tokenReplies = [200];

    const ctx = await advance();
    expect(tokenRequests).toEqual([{ Authorization: `Bearer ${stored}` }]);
    expect(userRequests).toEqual([{ method: "GET", headers: { Authorization: `Bearer ${issued[0]}` } }]);
    expect(ctx.isReady).toBe(true);
    expect(ctx.jwt).toBe(issued[0]);
    expect(ctx.userId).toBe("user-1");
    expect(session.get("tg_auth_token")).toBe(issued[0]);
  });

  it("a fresh launch keeps its JWT in sessionStorage for the next reload, and registers with initData", async () => {
    miniApp();
    tokenReplies = [200];

    await advance();
    expect(tokenRequests).toEqual([{ "x-telegram-init-data": initDataAt(LAUNCH) }]);
    expect(session.get("tg_auth_token")).toBe(issued[0]);
    expect(userRequests).toEqual([{ method: "POST", headers: { "x-telegram-init-data": initDataAt(LAUNCH) } }]);
  });

  it("a reload whose sign-in failed still checks the stored JWT with the server on the retry", async () => {
    const stored = jwtAt(LAUNCH - 10 * MIN);
    session.set("tg_auth_token", stored);
    miniApp(LAUNCH - 10 * MIN);
    tokenReplies = ["neterr", 200];

    let ctx = await advance();
    expect(ctx.connectionStatus).toBe("connecting");
    ctx = await advance(2000);
    expect(tokenRequests).toEqual([{ Authorization: `Bearer ${stored}` }, { Authorization: `Bearer ${stored}` }]);
    expect(ctx.jwt).toBe(issued[0]);
  });

  it("at launch the server judges the initData's age, not this device's clock", async () => {
    miniApp(LAUNCH - 6 * MIN); // this device's clock runs ahead of Telegram's
    tokenReplies = [200];

    const ctx = await advance();
    expect(tokenRequests).toEqual([{ "x-telegram-init-data": initDataAt(LAUNCH - 6 * MIN) }]);
    expect(ctx.jwt).toBe(issued[0]);
  });

  it("never uses a stored JWT that belongs to another Telegram user", async () => {
    session.set("tg_auth_token", jwtAt(LAUNCH - MIN, 99));
    miniApp();
    tokenReplies = [200];

    await advance();
    expect(tokenRequests).toEqual([{ "x-telegram-init-data": initDataAt(LAUNCH) }]);
  });
});

describe("a failed sign-in at launch hands over to the retry (H10)", () => {
  it("shows 'connecting', not 'connected', stays not ready, and becomes ready when the retry gets a token", async () => {
    miniApp();
    tokenReplies = ["neterr", 200];

    let ctx = await advance();
    expect(ctx.jwt).toBeNull();
    expect(ctx.connectionStatus).toBe("connecting");
    expect(ctx.isReady).toBe(false);
    expect(H.clients).toHaveLength(0);

    ctx = await advance(2000);
    expect(initDataRequests()).toHaveLength(2);
    expect(ctx.jwt).toBe(issued[0]);
    expect(ctx.isReady).toBe(true);
    expect(ctx.connectionStatus).toBe("connected");
    expect(H.clients).toHaveLength(1);
    expect(userRequests.map((r) => r.method)).toEqual(["POST"]);
  });

  it("settles without a token once the retries run out, so screens can show their error", async () => {
    miniApp();
    tokenReplies = ["neterr", "neterr", "neterr", "neterr", "neterr"];

    // The launch sign-in is the first of the 5 attempts.
    const ctx = await advance(12000);
    expect(tokenRequests).toHaveLength(5);
    expect(ctx.jwt).toBeNull();
    expect(ctx.retryCount).toBe(5);
    expect(ctx.isReady).toBe(true);
  });

  it("a focus while the launch sign-in is still waiting starts no second sign-in", async () => {
    miniApp();
    tokenReplies = ["hold"];

    await advance();
    focus();
    await advance();
    expect(tokenRequests).toHaveLength(1);

    held!(200);
    const ctx = await advance();
    expect(tokenRequests).toHaveLength(1);
    expect(ctx.connectionStatus).toBe("connected");
  });
});

describe("the provider cleans up its socket (H23)", () => {
  it("unmount disconnects the client, and a late heartbeat reconnects nothing", async () => {
    miniApp();
    tokenReplies = [200];
    await advance();
    const client = H.clients[0];

    unmount();
    expect(client.realtime.disconnect).toHaveBeenCalled();
    expect(client.removeAllChannels).toHaveBeenCalled();

    vi.setSystemTime(LAUNCH + 25 * HOUR);
    client.heartbeat("disconnected");
    await vi.advanceTimersByTimeAsync(5000);
    expect(tokenRequests).toHaveLength(1);
    expect(H.clients).toHaveLength(1);
  });

  it("web: a token that arrives after logout unmounted the provider is not stored", async () => {
    local.set("web_auth_token", jwtAt(LAUNCH - HOUR));
    tokenReplies = ["hold"];
    await advance();
    expect(tokenRequests).toHaveLength(1);

    // Logout removes the stored login, then /login unmounts the provider.
    local.delete("web_auth_token");
    unmount();
    held!(200);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(issued).toHaveLength(1);
    expect(local.has("web_auth_token")).toBe(false);
    expect(logged()).toContain("Token arrived after sign-out, not stored");
    expect(logged()).not.toContain(issued[0]);
  });
});

describe("TelegramProvider logs a failed user load", () => {
  it("Mini App: a refused registration is logged with its status, never the initData", async () => {
    miniApp();
    tokenReplies = [200];
    userReply = { status: 500, body: { error: "Failed to register user" } };

    await advance();
    expect(userRequests).toEqual([{ method: "POST", headers: { "x-telegram-init-data": initDataAt(LAUNCH) } }]);
    expect(console.error).toHaveBeenCalledWith("[TelegramProvider] User registration failed:", { status: 500 });
    expect(logged()).not.toContain("secret-hash");
  });

  it("web app: a refused user load is logged with its status, never the token", async () => {
    const stored = jwtAt(LAUNCH - HOUR);
    local.set("web_auth_token", stored);
    tokenReplies = [200];
    userReply = { status: 503, body: {} };

    await advance();
    expect(userRequests).toEqual([{ method: "GET", headers: { Authorization: `Bearer ${issued[0]}` } }]);
    expect(console.error).toHaveBeenCalledWith("[TelegramProvider] User load failed:", { status: 503 });
    expect(logged()).not.toContain(issued[0]);
    expect(logged()).not.toContain(stored);
  });
});

// The provider lives for the whole launch, so a failed user load must not stick until the
// app is reopened: it is tried again on the next token or once a reconnect lands.
describe("TelegramProvider tries a failed user load again", () => {
  const OK_USER = { status: 200, body: { id: "user-1", language: "he", telegram_id: 7, first_name: "A" } };

  it("a reconnect after a failed load loads the user, with the JWT once the initData is stale", async () => {
    const applied: string[] = [];
    H.applyLocale = (lang) => void applied.push(lang);
    miniApp();
    tokenReplies = [200];
    userReply = { status: 503, body: {} };
    let ctx = await advance();
    expect(userRequests).toHaveLength(1);
    expect(ctx.userId).toBeNull();

    userReply = OK_USER;
    vi.setSystemTime(LAUNCH + 10 * MIN);
    focus();
    ctx = await advance();
    expect(userRequests).toHaveLength(2);
    expect(userRequests[1]).toEqual({ method: "GET", headers: { Authorization: `Bearer ${issued[0]}` } });
    expect(ctx.userId).toBe("user-1");
    expect(applied).toContain("he");

    // Loaded: a later reconnect does not load it again.
    vi.setSystemTime(LAUNCH + 20 * MIN);
    focus();
    await advance();
    expect(userRequests).toHaveLength(2);
  });

  it("a new token after a failed load loads the user", async () => {
    miniApp();
    tokenReplies = [200];
    userReply = { status: 500, body: {} };
    let ctx = await advance();
    expect(ctx.userId).toBeNull();

    userReply = OK_USER;
    vi.setSystemTime(LAUNCH + 2 * MIN);
    tokenReplies = [200];
    ctx.requestTokenRefresh();
    ctx = await advance(6000);
    expect(ctx.jwt).toBe(issued[1]);
    expect(userRequests).toHaveLength(2);
    expect(ctx.userId).toBe("user-1");
  });

  it("after a failed load, a reconnect still under way waits for its end before trying again", async () => {
    miniApp();
    tokenReplies = [200];
    userReply = { status: 503, body: {} };
    await advance();

    userReply = OK_USER;
    vi.setSystemTime(LAUNCH + 25 * HOUR); // the reconnect refreshes the day-old token
    tokenReplies = ["hold"];
    focus();
    let ctx = await advance();
    expect(ctx.connectionStatus).toBe("connecting");
    expect(userRequests).toHaveLength(1);

    held!(200);
    ctx = await advance();
    expect(ctx.connectionStatus).toBe("connected");
    expect(userRequests).toEqual([
      expect.objectContaining({ method: "POST" }),
      { method: "GET", headers: { Authorization: `Bearer ${issued[1]}` } },
    ]);
    expect(ctx.userId).toBe("user-1");
  });

  it("a load that throws is tried again on the next reconnect", async () => {
    miniApp();
    tokenReplies = [200];
    const realFetch = vi.mocked(fetch).getMockImplementation()!;
    let userCalls = 0;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (url === "/api/user" && userCalls++ === 0) throw new TypeError("Load failed");
      return realFetch(url as string, init as { method?: string; headers: Record<string, string> });
    });
    let ctx = await advance();
    expect(ctx.userId).toBeNull();
    expect(console.error).toHaveBeenCalledWith("[TelegramProvider] User load error:", { register: true }, expect.any(TypeError));

    vi.setSystemTime(LAUNCH + 10 * MIN);
    focus();
    ctx = await advance();
    expect(userRequests).toHaveLength(1); // the throwing call never reached the fake route
    expect(ctx.userId).toBe("user-1");
  });

  it("a reconnect while the first load is still waiting starts no second load", async () => {
    miniApp();
    tokenReplies = [200];
    let release!: () => void;
    const realFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (url === "/api/user") await new Promise<void>((r) => (release = r));
      return realFetch(url as string, init as { method?: string; headers: Record<string, string> });
    });
    await advance();
    vi.setSystemTime(LAUNCH + 10 * MIN);
    focus();
    await advance();
    expect(fetch).toHaveBeenCalledWith("/api/user", expect.anything());
    expect(vi.mocked(fetch).mock.calls.filter(([u]) => u === "/api/user")).toHaveLength(1);

    release();
    const ctx = await advance();
    expect(ctx.userId).toBe("user-1");
  });
});

// Home auto-opens a single list only at launch. A launch that starts on a list (the bot's
// "Open list" button) must not bounce the first Back to Home into that list again.
describe("the launch route decides the single-list auto-open", () => {
  it("a Mini App launch on a list uses up the auto-open", async () => {
    win.location.pathname = "/list/A";
    miniApp();
    tokenReplies = [200];

    await advance();
    expect(session.get("autoOpenedSingleList")).toBe("true");
  });

  it("a web launch on a list uses it up too", async () => {
    win.location.pathname = "/list/A";
    local.set("web_auth_token", jwtAt(LAUNCH - HOUR));
    tokenReplies = [200];

    await advance();
    expect(session.get("autoOpenedSingleList")).toBe("true");
  });

  it("a launch on Home leaves it for Home to use", async () => {
    miniApp();
    tokenReplies = [200];

    await advance();
    expect(session.has("autoOpenedSingleList")).toBe(false);
  });

  it("storage that throws is logged, never fatal", async () => {
    win.location.pathname = "/list/A";
    miniApp();
    tokenReplies = [200];
    const blocked = new Error("blocked");
    vi.stubGlobal("sessionStorage", { ...storage(session), setItem: () => { throw blocked; } });

    const ctx = await advance();
    expect(ctx.jwt).toBe(issued[0]);
    expect(console.warn).toHaveBeenCalledWith("[TelegramProvider] Could not mark the launch route:", blocked);
  });
});

describe("TelegramProvider logs a failed cleanup of the old client's channels", () => {
  it("warns with the answers that were not ok when the client is replaced", async () => {
    miniApp();
    tokenReplies = [200];
    await advance();
    H.removeAnswers = ["ok", "timed out"];

    H.clients[0].heartbeat("timeout");
    await advance();
    expect(H.clients).toHaveLength(2);
    expect(H.clients[0].realtime.disconnect).toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("[Realtime] Remove all channels failed:", { total: 2 }, ["timed out"]);
  });
});
