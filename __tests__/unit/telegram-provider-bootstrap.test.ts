import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Calls the real TelegramProvider as a plain function with slot-based stand-ins for React's
// hooks (state and refs persist; effects are recorded and the test runs the bootstrap one).
// The extracted hooks and the Supabase client are stubbed.
type Effect = { fn: () => void | (() => void); deps?: unknown[] };
const R = vi.hoisted(() => ({ slots: [] as { value: unknown }[], effects: [] as Effect[], i: 0 }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
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
  useEffect: (fn: Effect["fn"], deps?: unknown[]) => {
    R.i++;
    R.effects.push({ fn, deps });
  },
}));

const H = vi.hoisted(() => ({
  jwtRef: { current: null as string | null },
  fetchToken: (async () => null) as (initData: string | null) => Promise<string | null>,
  orchestratorParams: null as null | { recreateSupabaseClient: (token: string) => void },
  clients: [] as unknown[],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("next-intl", () => ({ NextIntlClientProvider: () => null }));
vi.mock("@/src/lib/supabase", () => ({ createBrowserClient: () => H.clients.shift() }));
vi.mock("@/src/hooks/useJWTRefresh", () => ({
  useJWTRefresh: () => ({ jwt: null, jwtRef: H.jwtRef, fetchToken: H.fetchToken, clearJwt: () => {} }),
}));
vi.mock("@/src/hooks/useLocaleSync", () => ({
  useLocaleSync: () => ({ locale: "en", applyLocale: () => {}, setLanguage: async () => {} }),
}));
vi.mock("@/src/hooks/useHomeScreen", () => ({
  useHomeScreen: () => ({ homeScreenStatus: null, setHomeScreenStatus: () => {}, addToHomeScreen: () => {} }),
}));
vi.mock("@/src/hooks/useReconnectOrchestrator", () => ({
  useReconnectOrchestrator: (params: { recreateSupabaseClient: (token: string) => void }) => {
    H.orchestratorParams = params;
    return { connectionStatus: "connecting", retryCount: 0, reconnect: () => {}, runReconnectRef: { current: () => {} }, setOrchestratorState: () => {} };
  },
}));

import TelegramProvider from "@/components/TelegramProvider";

const INIT_DATA = "query_id=q&user=%7B%7D&hash=secret-hash";

const fakeClient = (removeAll: () => Promise<string[]>) => ({
  realtime: { disconnect: vi.fn() },
  removeAllChannels: vi.fn(removeAll),
});

// Renders once and runs the bootstrap effect (the one with no dependencies).
function boot() {
  R.i = 0;
  R.effects = [];
  TelegramProvider({ children: null });
  R.effects.find((e) => e.deps?.length === 0)!.fn();
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const logged = () =>
  [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls]
    .flat()
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");

function stubStorage(values: Record<string, string>) {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => values[k] ?? null,
    setItem: () => {},
    removeItem: () => {},
  });
}

beforeEach(() => {
  R.slots = [];
  H.jwtRef.current = null;
  H.clients = [fakeClient(async () => [])];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TelegramProvider logs a failed user load", () => {
  it("Mini App: a refused registration is logged with its status, never the initData", async () => {
    H.fetchToken = async () => "fresh.jwt";
    stubStorage({});
    vi.stubGlobal("window", {
      Telegram: {
        WebApp: {
          initData: INIT_DATA,
          initDataUnsafe: { user: { id: 1, first_name: "A", language_code: "en" } },
          ready: () => {},
          expand: () => {},
          onEvent: () => {},
          offEvent: () => {},
        },
      },
      location: { pathname: "/" },
    });
    const f = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "Failed to register user" }) }));
    vi.stubGlobal("fetch", f);

    boot();
    await settle();

    expect(f).toHaveBeenCalledWith("/api/user", { method: "POST", headers: { "x-telegram-init-data": INIT_DATA } });
    expect(console.error).toHaveBeenCalledWith("[TelegramProvider] User registration failed:", { status: 500 });
    expect(logged()).not.toContain("secret-hash");
  });

  it("web app: a refused user load is logged with its status, never the token", async () => {
    H.fetchToken = async () => "fresh.jwt";
    stubStorage({ web_auth_token: "stored.jwt" });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("document", { documentElement: { classList: { add: () => {}, remove: () => {} } } });
    const f = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    vi.stubGlobal("fetch", f);

    boot();
    await settle();

    expect(f).toHaveBeenCalledWith("/api/user", { headers: { Authorization: "Bearer fresh.jwt" } });
    expect(console.error).toHaveBeenCalledWith("[TelegramProvider] Web user load failed:", { status: 503 });
    expect(logged()).not.toContain("fresh.jwt");
    expect(logged()).not.toContain("stored.jwt");
  });
});

describe("TelegramProvider logs a failed cleanup of the old client's channels", () => {
  it("warns with the answers that were not ok when the client is recreated", async () => {
    const first = fakeClient(async () => ["ok", "timed out"]);
    H.clients = [first, fakeClient(async () => [])];
    R.i = 0;
    TelegramProvider({ children: null });
    const recreate = H.orchestratorParams!.recreateSupabaseClient;

    recreate("t1");
    recreate("t2");
    await settle();

    expect(first.realtime.disconnect).toHaveBeenCalled();
    expect(first.removeAllChannels).toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("[Realtime] Remove all channels failed:", { total: 2 }, ["timed out"]);
  });
});
