import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Calls the real TelegramProvider as a plain function with slot-based stand-ins for React's
// hooks (pattern: telegram-provider-bootstrap.test.ts). Effects are recorded; the test runs
// the ones that depend on the token. The extracted hooks are stubbed.
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
  useMemo: (fn: () => unknown) => (R.i++, fn()),
  useEffect: (fn: Effect["fn"], deps?: unknown[]) => {
    R.i++;
    R.effects.push({ fn, deps });
  },
}));

const H = vi.hoisted(() => ({
  jwt: null as string | null,
  jwtRef: { current: null as string | null },
  requestTokenRefresh: () => {},
  flushAllQueues: null as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("next-intl", () => ({ NextIntlClientProvider: () => null }));
vi.mock("@/src/lib/supabase", () => ({ createBrowserClient: () => ({}) }));
vi.mock("@/src/hooks/useJWTRefresh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/hooks/useJWTRefresh")>()),
  useJWTRefresh: () => ({ jwt: H.jwt, jwtRef: H.jwtRef, fetchToken: async () => null, setToken: () => {}, clearJwt: () => {} }),
}));
vi.mock("@/src/hooks/useLocaleSync", () => ({
  useLocaleSync: () => ({ locale: "en", applyLocale: () => {}, setLanguage: async () => {} }),
}));
vi.mock("@/src/hooks/useHomeScreen", () => ({
  useHomeScreen: () => ({ homeScreenStatus: null, setHomeScreenStatus: () => {}, addToHomeScreen: () => {} }),
}));
vi.mock("@/src/hooks/useReconnectOrchestrator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/hooks/useReconnectOrchestrator")>()),
  useReconnectOrchestrator: () => ({
    connectionStatus: "connecting", retryCount: 0, reconnect: () => {}, runReconnectRef: { current: () => {} }, setOrchestratorState: () => {}, startSession: () => {}, requestTokenRefresh: H.requestTokenRefresh,
  }),
}));
vi.mock("@/src/sync/engine", () => ({ flushAllQueues: (...args: unknown[]) => H.flushAllQueues(...args) }));

import TelegramProvider from "@/components/TelegramProvider";

// Renders once with this token and runs the effect that replays after auth (deps: token, flushAll).
function renderWith(jwt: string | null) {
  H.jwt = jwt;
  H.jwtRef.current = jwt;
  R.i = 0;
  R.effects = [];
  TelegramProvider({ children: null });
  for (const e of R.effects) if (e.deps?.length === 2 && typeof e.deps[1] === "function") e.fn();
}

beforeEach(() => {
  R.slots = [];
  H.flushAllQueues = vi.fn(async () => {});
  H.requestTokenRefresh = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TelegramProvider replays every list's saved changes after auth (H15)", () => {
  it("flushes every queue once a token exists, with a getter that reads the latest token", () => {
    renderWith(null);
    expect(H.flushAllQueues).not.toHaveBeenCalled();

    renderWith("tok-1");
    expect(H.flushAllQueues).toHaveBeenCalledOnce();
    const [getJwt, factory] = H.flushAllQueues.mock.calls[0] as [() => string | null, unknown];
    expect(typeof factory).toBe("function");
    H.jwtRef.current = "tok-2";
    expect(getJwt()).toBe("tok-2");
  });

  it("a 401 during that replay asks for a fresh token", () => {
    renderWith("tok-1");
    for (const e of R.effects) if (e.deps?.includes(H.requestTokenRefresh)) e.fn();
    const onAuthNeeded = H.flushAllQueues.mock.calls[0][2] as () => void;
    onAuthNeeded();
    expect(H.requestTokenRefresh).toHaveBeenCalledOnce();
  });

  it("logs a replay that throws instead of leaving an unhandled rejection", async () => {
    const err = new Error("storage broke");
    H.flushAllQueues = vi.fn(async () => {
      throw err;
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderWith("tok-1");
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).toHaveBeenCalledWith("[Sync] Replaying saved changes after auth failed:", err);
  });
});
