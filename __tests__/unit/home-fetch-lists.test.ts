import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";

// Calls the real home page component as a plain function with slot-based stand-ins for
// React's hooks (state and refs persist; effects are recorded, and the test runs only the
// one that registers fetchLists with the reconnect orchestrator). Children are stubbed.
type Effect = { fn: () => void | (() => void); deps?: unknown[] };
const R = vi.hoisted(() => ({ slots: [] as { value: unknown }[], effects: [] as Effect[], i: 0 }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
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
  useCallback: (fn: unknown) => (R.i++, fn),
  useMemo: (fn: () => unknown) => (R.i++, fn()),
  useEffect: (fn: Effect["fn"], deps?: unknown[]) => {
    R.i++;
    R.effects.push({ fn, deps });
  },
}));

const T = vi.hoisted(() => ({
  jwtRef: { current: "jwt" as string | null },
  onRefreshNeededRef: { current: null as null | ((opts?: { silent?: boolean }) => Promise<void>) },
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key, useLocale: () => "en" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/components/TelegramProvider", () => ({
  default: ({ children }: { children: unknown }) => children,
  useTelegram: () => ({
    isReady: true,
    locale: "en",
    setLanguage: async () => true,
    jwtRef: T.jwtRef,
    onRefreshNeededRef: T.onRefreshNeededRef,
    homeScreenStatus: null,
    addToHomeScreen: () => {},
  }),
}));
vi.mock("@/src/hooks/useListsDragDrop", () => ({
  useListsDragDrop: () => ({ handleDragStart: () => {}, handleDragEnd: () => {}, shouldSuppressClick: () => false }),
}));
vi.mock("@dnd-kit/react", () => ({ DragDropProvider: () => null }));
vi.mock("@/components/ListCard", () => ({ default: () => null }));
vi.mock("@/components/SortableListCard", () => ({ default: () => null }));
vi.mock("@/components/EmptyState", () => ({ default: () => null }));
vi.mock("@/components/OfflineIndicator", () => ({ default: () => null }));
vi.mock("@/components/IconColorPicker", () => ({ default: () => null }));

import HomePage from "@/app/(app)/page";
import OfflineIndicator from "@/components/OfflineIndicator";

type El = ReactElement<Record<string, unknown> & { children?: unknown }>;
// The page component itself: the provider lives in app/(app)/layout.tsx.
const Content = HomePage as () => El;

const render = () => {
  R.i = 0;
  R.effects = [];
  return Content();
};
// Runs the effect that hands fetchLists to the orchestrator, and returns fetchLists.
function fetchLists() {
  render();
  R.effects.find((e) => e.deps?.includes(T.onRefreshNeededRef))!.fn();
  return T.onRefreshNeededRef.current!;
}
const text = (node: unknown): string =>
  Array.isArray(node)
    ? node.map(text).join(" ")
    : node && typeof node === "object" && "props" in node
      ? text((node as El).props.children)
      : typeof node === "string" ? node : "";

// Whether the tree renders an element of this component.
const has = (node: unknown, type: unknown): boolean =>
  Array.isArray(node)
    ? node.some((n) => has(n, type))
    : !!node && typeof node === "object" && "props" in node &&
      ((node as El).type === type || has((node as El).props.children, type));

const reply = (status: number, body: unknown = { error: "Server error" }) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
  R.slots = [];
  T.onRefreshNeededRef.current = null;
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("home fetchLists logs a refused load", () => {
  it("logs the status and shows the Retry screen", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(500)));
    await fetchLists()();
    expect(console.warn).toHaveBeenCalledWith("[Home] Load lists failed:", { view: "active", silent: false, status: 500 });
    expect(text(render())).toContain("lists.loadError");
  });

  it("a silent resync logs the status and keeps the lists on screen", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(200, [{ id: "a", name: "A" }, { id: "b", name: "B" }])));
    await fetchLists()();
    vi.stubGlobal("fetch", vi.fn(async () => reply(503)));
    await fetchLists()({ silent: true });
    expect(console.warn).toHaveBeenCalledWith("[Home] Load lists failed:", { view: "active", silent: true, status: 503 });
    expect(text(render())).not.toContain("lists.loadError");
  });

  it("an answer that a newer load overtook is dropped without a log", async () => {
    const pending: ((r: unknown) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => pending.push(resolve))));
    const load = fetchLists();
    const first = load({ silent: true });
    const second = load({ silent: true });
    pending[0](reply(500));
    await first;
    expect(console.warn).not.toHaveBeenCalled();
    pending[1](reply(502));
    await second;
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith("[Home] Load lists failed:", { view: "active", silent: true, status: 502 });
  });
});

describe("home without a session (H10)", () => {
  afterEach(() => {
    T.jwtRef.current = "jwt";
  });

  it("the placeholders show the connection banner", () => {
    expect(has(render(), OfflineIndicator)).toBe(true);
  });

  it("without a JWT, leaves the placeholders for the error screen and its banner", async () => {
    T.jwtRef.current = null;
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await fetchLists()();
    const tree = render();
    expect(f).not.toHaveBeenCalled();
    expect(text(tree)).toContain("lists.loadError");
    expect(has(tree, OfflineIndicator)).toBe(true);
    expect(console.warn).toHaveBeenCalledWith("[Home] Load lists skipped, no session:", { view: "active", silent: false });
  });
});
