import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";

// Calls the real invite page as a plain function with slot-based stand-ins for React's hooks:
// state and refs persist across renders, callbacks and effects follow their deps, and effects
// run after the render that queued them. The session comes from a stubbed useTelegram; the
// network is a fake.
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

const S = vi.hoisted(() => ({
  session: { initData: null as string | null, isReady: false, jwt: null as string | null, jwtRef: { current: null as string | null } },
  router: { push: (() => {}) as (url: string) => void },
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/navigation", () => ({ useRouter: () => S.router, useParams: () => ({ token: "TOKEN" }) }));
vi.mock("@/components/TelegramProvider", () => ({ useTelegram: () => S.session }));
vi.mock("lucide-react", () => ({ Loader2: () => null, RefreshCw: () => null }));

import InvitePage from "@/app/(app)/invite/[token]/page";

type El = ReactElement<Record<string, unknown> & { children?: unknown }>;
const NOW = new Date("2026-10-29T08:00:00.000Z").getTime();
const initDataAt = (ms: number) => `auth_date=${Math.floor(ms / 1000)}&hash=secret-hash`;
const STALE = initDataAt(NOW - 10 * 60 * 1000);
const FRESH = initDataAt(NOW - 60 * 1000);

const render = (): El => {
  R.i = 0;
  R.effects = [];
  const el = (InvitePage as unknown as () => El)();
  for (const run of R.effects) run();
  return el;
};
async function settle(): Promise<El> {
  for (let k = 0; k < 5; k++) {
    render();
    await vi.advanceTimersByTimeAsync(0);
  }
  return render();
}
const text = (node: unknown): string =>
  Array.isArray(node)
    ? node.map(text).join(" ")
    : node && typeof node === "object" && "props" in node
      ? text((node as El).props.children)
      : typeof node === "string" ? node : "";
const signIn = (s: Partial<typeof S.session>) => {
  S.session = { ...S.session, ...s };
  if ("jwt" in s) S.session.jwtRef.current = s.jwt ?? null;
};

let fetchMock: ReturnType<typeof vi.fn>;
let answer: { status: number; body: unknown };
const joinHeaders = () => fetchMock.mock.calls.map(([, init]) => (init as { headers: Record<string, string> }).headers);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  R.slots = [];
  S.session = { initData: null, isReady: false, jwt: null, jwtRef: { current: null } };
  S.router = { push: vi.fn() };
  answer = { status: 200, body: { listId: "L1", listName: "Groceries", collaboratorId: "c1", status: "pending" } };
  fetchMock = vi.fn(async () => new Response(JSON.stringify(answer.body), { status: answer.status }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the invite page asks to join with a credential the server accepts", () => {
  it("a reload more than 5 minutes in joins with the session JWT, not the stale initData", async () => {
    signIn({ isReady: true, initData: STALE, jwt: "session.jwt" });

    const el = await settle();
    expect(joinHeaders()).toEqual([{ Authorization: "Bearer session.jwt", "Content-Type": "application/json" }]);
    expect(text(el)).toContain("share.waitingApproval");
  });

  it("a fresh launch joins with its initData", async () => {
    signIn({ isReady: true, initData: FRESH, jwt: "session.jwt" });

    await settle();
    expect(joinHeaders()).toEqual([{ "x-telegram-init-data": FRESH, "Content-Type": "application/json" }]);
  });

  it("waits for the session before asking", async () => {
    signIn({ initData: STALE });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    signIn({ isReady: true, jwt: "session.jwt" });
    await settle();
    expect(joinHeaders()).toEqual([{ Authorization: "Bearer session.jwt", "Content-Type": "application/json" }]);
  });

  it("with no credential at all it offers Retry, and asks once a JWT arrives", async () => {
    signIn({ isReady: true, initData: STALE });
    let el = await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text(el)).toContain("errors.generic");
    expect(text(el)).toContain("common.retry");
    expect(console.warn).toHaveBeenCalledWith("[Invite] No credentials to ask to join yet");

    signIn({ jwt: "session.jwt" });
    el = await settle();
    expect(joinHeaders()).toEqual([{ Authorization: "Bearer session.jwt", "Content-Type": "application/json" }]);
    expect(text(el)).toContain("share.waitingApproval");
  });

  it("a refused sign-in shows the translated error and Retry, never the server's text", async () => {
    answer = { status: 401, body: { error: "Unauthorized" } };
    signIn({ isReady: true, initData: STALE, jwt: "session.jwt" });

    const el = await settle();
    expect(text(el)).toContain("errors.generic");
    expect(text(el)).toContain("common.retry");
    expect(text(el)).not.toContain("Unauthorized");
    expect(text(el)).not.toContain("share.inviteInvalid");
  });

  it("asks only once: a later token refresh does not send the join again", async () => {
    signIn({ isReady: true, initData: STALE, jwt: "session.jwt" });
    await settle();

    signIn({ jwt: "refreshed.jwt" });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
