import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";

// Calls the real ShareDialog as a plain function with slot-based stand-ins for React's
// hooks: state persists across renders, callbacks and effects follow their deps, and
// effects run after the render that queued them. Nothing renders to a DOM.
type Slot = { value?: unknown; deps?: unknown[] };
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
    useCallback: (fn: unknown, deps: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && same(s.deps, deps)) return s.value;
      R.slots[i] = { value: fn, deps };
      return fn;
    },
    useEffect: (fn: () => void, deps?: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && deps && same(s.deps, deps)) return;
      R.slots[i] = { deps };
      R.effects.push(fn);
    },
  };
});

const H = vi.hoisted(() => ({ jwtRef: { current: "jwt" as string | null } }));
vi.mock("next-intl", () => ({
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
}));
vi.mock("@/components/TelegramProvider", () => ({ useTelegram: () => ({ jwtRef: H.jwtRef }) }));

import ShareDialog from "@/components/ShareDialog";

type El = ReactElement<Record<string, unknown> & { children?: unknown }>;

const render = () => {
  R.i = 0;
  R.effects = [];
  const tree = ShareDialog({ listId: "L", listName: "Groceries", isOpen: true, onClose: () => {} }) as El;
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

const text = (node: unknown): string =>
  Array.isArray(node)
    ? node.map(text).join("")
    : typeof node === "string"
      ? node
      : node && typeof node === "object" && "props" in node
        ? text((node as El).props.children)
        : "";

const alertText = () => {
  const el = find(render(), (e) => e.props.role === "alert");
  return el ? text(el.props.children) : null;
};
const generateButton = () =>
  find(render(), (el) => el.type === "button" && text(el.props.children).includes("share.generateLink"));

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

type Reply = number | "neterr";
const LINK = "https://t.me/bot/app?startapp=invite";
let replies: Map<string, Reply[]>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  R.slots = [];
  R.i = 0;
  replies = new Map();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const reply = replies.get(key)?.shift() ?? 200;
    if (reply === "neterr") throw new TypeError("Failed to fetch");
    const body = key === "POST /api/share" ? { link: LINK } : { collaborators: [], activeLink: null };
    return { ok: reply >= 200 && reply < 300, status: reply, json: async () => body };
  }));
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ShareDialog failures", () => {
  it("a collaborator load the server refused shows the generic error inline", async () => {
    replies.set("GET /api/share?listId=L", [500]);
    render();
    await settle();

    expect(alertText()).toBe("errors.generic");
    expect(errorSpy).toHaveBeenCalledWith(
      "[ShareDialog] Failed to load:",
      { listId: "L" },
      expect.objectContaining({ message: "Share load failed: 500" })
    );
  });

  it("a collaborator load that could not be sent shows it too", async () => {
    replies.set("GET /api/share?listId=L", ["neterr"]);
    render();
    await settle();

    expect(alertText()).toBe("errors.generic");
    expect(errorSpy).toHaveBeenCalledWith("[ShareDialog] Failed to load:", { listId: "L" }, expect.any(TypeError));
  });

  it("a load that worked shows no error", async () => {
    render();
    await settle();

    expect(alertText()).toBeNull();
  });

  it("a link the server refused to create shows the generic error and lets the owner try again", async () => {
    render();
    await settle();
    replies.set("POST /api/share", [500]);

    await (generateButton()!.props.onClick as () => Promise<void>)();

    expect(alertText()).toBe("errors.generic");
    expect(generateButton()?.props.disabled).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      "[ShareDialog] Failed to generate link:",
      { listId: "L" },
      expect.objectContaining({ message: "Link create failed: 500" })
    );
  });

  it("a retry that works clears the error and shows the link", async () => {
    replies.set("GET /api/share?listId=L", [500]);
    render();
    await settle();
    expect(alertText()).toBe("errors.generic");

    await (generateButton()!.props.onClick as () => Promise<void>)();

    expect(alertText()).toBeNull();
    expect(text(render())).toContain(LINK);
  });
});
