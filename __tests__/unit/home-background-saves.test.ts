import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";

// Calls the real home page component as a plain function with slot-based stand-ins for
// React's hooks: state and refs persist across renders, callbacks and effects follow their
// deps, and effects run after the render that queued them, as in React. Buttons are pressed
// by calling their handlers from the returned element tree. Nothing renders to a DOM.
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

// Stable across renders, like the real hooks' return values.
const H = vi.hoisted(() => ({
  t: (key: string) => key,
  router: { push: () => {} },
  jwtRef: { current: "jwt" as string | null },
  onRefreshNeededRef: { current: null as unknown },
  setLanguage: (async () => true) as (lang: string) => Promise<boolean>,
}));
vi.mock("next-intl", () => ({ useTranslations: () => H.t }));
vi.mock("next/navigation", () => ({ useRouter: () => H.router }));
vi.mock("@/components/TelegramProvider", () => ({
  default: ({ children }: { children: unknown }) => children,
  useTelegram: () => ({
    isReady: true,
    locale: "en",
    setLanguage: H.setLanguage,
    jwtRef: H.jwtRef,
    onRefreshNeededRef: H.onRefreshNeededRef,
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
import SortableListCard from "@/components/SortableListCard";
import { Globe } from "lucide-react";

type El = ReactElement<Record<string, unknown> & { children?: unknown }>;

// The page component itself: the provider lives in app/(app)/layout.tsx.
const HomeContent = HomePage as () => El;

const render = () => {
  R.i = 0;
  R.effects = [];
  const tree = HomeContent();
  for (const run of R.effects) run();
  return tree;
};

function find(node: unknown, match: (el: El) => boolean): El | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, match);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const el = node as El;
  return match(el) ? el : find(el.props.children, match);
}

function findAll(node: unknown, match: (el: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, out);
    return out;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return out;
  const el = node as El;
  if (match(el)) out.push(el);
  return findAll(el.props.children, match, out);
}

const listIds = () => findAll(render(), (el) => el.type === SortableListCard).map((el) => el.props.id);
const card = (id: string) => find(render(), (el) => el.type === SortableListCard && el.props.id === id)!;
const press = (el: El, handler: string, ...args: unknown[]) => (el.props[handler] as (...a: unknown[]) => unknown)(...args);
// A sheet defined in app/(app)/page.tsx, found by its component name.
const sheet = (name: string) =>
  find(render(), (el) => typeof el.type === "function" && (el.type as { name: string }).name === name);
const toastBox = () => find(render(), (el) => el.type === "div" && String(el.props.className).startsWith("fixed bottom-8 start-5"));
// The bottom toast: its message, and whether it offers Undo.
const toast = () => {
  const box = toastBox();
  if (!box) return null;
  const undo = find(box, (el) => el.type === "button");
  return {
    message: find(box, (el) => el.type === "span")!.props.children,
    undo: undo ? (undo.props.onClick as () => void) : undefined,
  };
};
const zOf = (className: unknown) => Number(/\bz-\[?(\d+)\]?/.exec(String(className))![1]);

// Let queued promise chains run without moving the clock.
const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
};

type Reply = number | "neterr" | "hold";
const LIST = (id: string) => ({
  id, name: id, type: "regular", icon: null, color: null,
  active_count: 0, completed_count: 0, is_shared: false, role: "owner",
});

// The fake server. Keys are "<METHOD> <url>"; a reply is a status, a network failure, or
// held until released. GET /api/lists answers with server.lists as it is at reply time.
let server: { lists: ReturnType<typeof LIST>[] };
let replies: Map<string, Reply[]>;
let held: Map<string, (status: number) => void>;
let bodies: Map<string, unknown>; // a reply body that replaces the default for one request
let calls: string[];
let alertMock: ReturnType<typeof vi.fn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  R.slots = [];
  R.i = 0;
  vi.useFakeTimers();
  server = { lists: ["A", "B", "C"].map(LIST) };
  replies = new Map();
  held = new Map();
  bodies = new Map();
  calls = [];
  const storage = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  };
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("sessionStorage", storage());
  alertMock = vi.fn();
  // No Telegram WebApp: the delete confirm falls back to window.confirm, answered yes.
  vi.stubGlobal("window", { confirm: () => true, alert: alertMock });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push(key);
    const reply = replies.get(key)?.shift() ?? 200;
    if (reply === "neterr") throw new TypeError("Failed to fetch");
    const status = reply === "hold" ? await new Promise<number>((resolve) => held.set(key, resolve)) : reply;
    const body = bodies.has(key) ? bodies.get(key) : key === "GET /api/lists" ? server.lists.map((l) => ({ ...l })) : { id: "new-list" };
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }));
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  H.setLanguage = async () => true;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// First load of the home screen with lists A, B, C.
async function boot() {
  render();
  await settle();
  expect(listIds()).toEqual(["A", "B", "C"]);
}

describe("Home: delete a list", () => {
  it("a delete the server refused puts the card back where it was and says so", async () => {
    await boot();
    replies.set("DELETE /api/lists?id=B", [500]);
    replies.set("GET /api/lists", ["hold"]); // the quiet resync stays in flight: what's on screen is the page's own repair

    press(card("B"), "onDelete");
    expect(listIds()).toEqual(["A", "C"]);
    expect(toast()?.message).toBe("lists.deleted");
    await settle();

    expect(listIds()).toEqual(["A", "B", "C"]);
    expect(toast()).toEqual({ message: "lists.deleteFailed", undo: undefined });
    expect(errorSpy).toHaveBeenCalledWith(
      "[Home] Delete list failed:",
      { listId: "B" },
      expect.objectContaining({ message: "Delete failed: 500" })
    );
    expect(calls.filter((c) => c === "GET /api/lists")).toHaveLength(2); // the first load, then the resync
  });

  it("a delete that could not be sent does the same", async () => {
    await boot();
    replies.set("DELETE /api/lists?id=B", ["neterr"]);
    replies.set("GET /api/lists", ["hold"]);

    press(card("B"), "onDelete");
    await settle();

    expect(listIds()).toEqual(["A", "B", "C"]);
    expect(toast()).toEqual({ message: "lists.deleteFailed", undo: undefined });
    expect(errorSpy).toHaveBeenCalledWith("[Home] Delete list failed:", { listId: "B" }, expect.any(TypeError));
  });

  it("a delete that fails after Undo was tapped shows the card once", async () => {
    await boot();
    replies.set("DELETE /api/lists?id=B", ["hold"]);
    replies.set("GET /api/lists", ["hold"]);

    press(card("B"), "onDelete");
    toast()!.undo!();
    expect(listIds()).toEqual(["A", "B", "C"]);
    await settle();
    held.get("DELETE /api/lists?id=B")!(500);
    await settle();

    expect(listIds()).toEqual(["A", "B", "C"]);
    expect(toast()?.message).toBe("lists.deleteFailed");
  });

  it("a failed Undo says so and shows what the server has", async () => {
    await boot();
    press(card("B"), "onDelete");
    await settle();
    server.lists = ["A", "C"].map(LIST); // B is deleted on the server
    replies.set("PATCH /api/lists", [500]);

    toast()!.undo!();
    expect(listIds()).toEqual(["A", "B", "C"]);
    await settle();

    expect(listIds()).toEqual(["A", "C"]);
    expect(toast()).toEqual({ message: "errors.generic", undo: undefined });
    expect(errorSpy).toHaveBeenCalledWith(
      "[Home] Undo delete failed:",
      { listId: "B" },
      expect.objectContaining({ message: "Restore failed: 500" })
    );
  });
});

describe("Home: Undo of an archive", () => {
  it("a failed Undo says so and shows what the server has", async () => {
    await boot();
    press(card("B"), "onArchive");
    await settle();
    server.lists = ["A", "C"].map(LIST); // B is archived on the server
    replies.set("POST /api/lists/archive", [500]);

    toast()!.undo!();
    expect(listIds()).toEqual(["A", "B", "C"]);
    await settle();

    expect(listIds()).toEqual(["A", "C"]);
    expect(toast()).toEqual({ message: "errors.generic", undo: undefined });
    expect(errorSpy).toHaveBeenCalledWith(
      "[Home] Undo archive failed:",
      { listId: "B" },
      expect.objectContaining({ message: "Undo archive failed: 500" })
    );
  });
});

describe("Home: edit sheet", () => {
  it("a save the server refused keeps the sheet open with the user's input and says so, above the sheet", async () => {
    await boot();
    press(card("B"), "onEdit");
    press(sheet("EditListSheet")!, "onNameChange", "Renamed");
    replies.set("PATCH /api/lists", [500]);

    press(sheet("EditListSheet")!, "onSubmit");
    await settle();

    const open = sheet("EditListSheet");
    expect(open?.props.name).toBe("Renamed");
    expect(card("B").props.name).toBe("B");
    expect(toast()).toEqual({ message: "errors.generic", undo: undefined });
    expect(errorSpy).toHaveBeenCalledWith(
      "[Home] Edit list failed:",
      { listId: "B" },
      expect.objectContaining({ message: "Edit failed: 500" })
    );
    const sheetRoot = (open!.type as (p: unknown) => El)(open!.props);
    expect(zOf(toastBox()!.props.className)).toBeGreaterThan(zOf(sheetRoot.props.className));
  });

  it("a save that could not be sent keeps the sheet open and says so", async () => {
    await boot();
    press(card("B"), "onEdit");
    replies.set("PATCH /api/lists", ["neterr"]);

    press(sheet("EditListSheet")!, "onSubmit");
    await settle();

    expect(sheet("EditListSheet")).toBeDefined();
    expect(toast()).toEqual({ message: "errors.generic", undo: undefined });
  });

  it("a save the server accepted renames the card and closes the sheet", async () => {
    await boot();
    press(card("B"), "onEdit");
    press(sheet("EditListSheet")!, "onNameChange", "Renamed");

    press(sheet("EditListSheet")!, "onSubmit");
    await settle();

    expect(sheet("EditListSheet")).toBeUndefined();
    expect(card("B").props.name).toBe("Renamed");
    expect(toast()).toBeNull();
  });
});

describe("Home: create a list", () => {
  const openCreate = () => {
    const fab = find(render(), (el) => el.type === "button" && String(el.props.className).includes("fixed bottom-8 end-6"))!;
    press(fab, "onClick");
    press(sheet("CreateListSheet")!, "onChange", "Milk");
  };

  it("a create the server refused shows the generic error toast instead of an English alert", async () => {
    await boot();
    openCreate();
    replies.set("POST /api/lists", [400]);

    press(sheet("CreateListSheet")!, "onSubmit");
    await settle();

    expect(alertMock).not.toHaveBeenCalled();
    expect(sheet("CreateListSheet")?.props.value).toBe("Milk");
    expect(toast()).toEqual({ message: "errors.generic", undo: undefined });
    expect(errorSpy).toHaveBeenCalledWith(
      "[Home] Create list failed:",
      expect.objectContaining({ message: "Create list failed: 400" })
    );
  });

  it("a create refused because of the 50-list cap says so, instead of the generic error", async () => {
    await boot();
    openCreate();
    replies.set("POST /api/lists", [400]);
    bodies.set("POST /api/lists", { error: "You've reached the 50-list limit.", code: "maxLists" });

    press(sheet("CreateListSheet")!, "onSubmit");
    await settle();

    expect(alertMock).not.toHaveBeenCalled();
    expect(sheet("CreateListSheet")?.props.value).toBe("Milk");
    expect(toast()).toEqual({ message: "lists.maxLists", undo: undefined });
  });

  it("a create that could not be sent says so too", async () => {
    await boot();
    openCreate();
    replies.set("POST /api/lists", ["neterr"]);

    press(sheet("CreateListSheet")!, "onSubmit");
    await settle();

    expect(toast()).toEqual({ message: "errors.generic", undo: undefined });
  });
});

describe("Home: error toasts never block the sheet buttons", () => {
  it("a message-only toast ignores taps, an Undo toast keeps them", async () => {
    await boot();
    press(card("B"), "onDelete");
    expect(String(toastBox()!.props.className)).not.toContain("pointer-events-none");
    // An Undo toast stays under the sheets (z-50), as before, so it never covers their buttons.
    expect(zOf(toastBox()!.props.className)).toBe(30);

    replies.set("PATCH /api/lists", [500]);
    toast()!.undo!();
    await settle();

    expect(toast()?.undo).toBeUndefined();
    expect(String(toastBox()!.props.className)).toContain("pointer-events-none");
    // A message-only toast draws above the sheets, since it ignores taps.
    expect(zOf(toastBox()!.props.className)).toBe(60);
  });
});

describe("Home: language", () => {
  const chooseHebrew = async () => {
    const globe = find(render(), (el) => el.type === "button" && find(el.props.children, (c) => c.type === Globe) !== undefined)!;
    press(globe, "onClick");
    await press(sheet("LanguageSheet")!, "onSelect", "he");
  };

  it("a language that could not be saved stays chosen, and the page says so", async () => {
    const setLanguage = vi.fn(async () => false);
    H.setLanguage = setLanguage;
    await boot();

    await chooseHebrew();

    expect(setLanguage.mock.calls).toEqual([["he"]]);
    expect(sheet("LanguageSheet")).toBeUndefined();
    expect(toast()).toEqual({ message: "errors.generic", undo: undefined });
  });

  it("the failure message follows the language now on screen, not the one being left", async () => {
    H.setLanguage = async () => false;
    await boot();
    const english = H.t;

    // The save fails while the page is still rendering with the old language's translator;
    // the next render runs with the new one, as next-intl does after a locale switch.
    await chooseHebrew();
    H.t = (key: string) => `he:${key}`;
    try {
      expect(toast()).toEqual({ message: "he:errors.generic", undo: undefined });
    } finally {
      H.t = english;
    }
  });

  it("a saved language shows no error", async () => {
    await boot();

    await chooseHebrew();

    expect(sheet("LanguageSheet")).toBeUndefined();
    expect(toast()).toBeNull();
  });
});
