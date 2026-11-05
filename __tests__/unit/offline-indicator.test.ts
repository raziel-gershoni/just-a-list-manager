import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Sync bar layout. A reconnect runs on every return to the app, started by the focus the
// user's first tap brings, and what it shows appears in that same moment. Had the list moved
// then, the row under the finger would change before the tap was delivered and iOS would drop
// it (the first tap after unlocking did nothing). "Syncing…" floats and takes no room;
// "Connection problems" and "Session expired" stay up, so they take their room rather than
// cover a row, and a reconnect started over one of them keeps that room until connected.

// One mounted indicator: useState keeps its value across renders, and a set during render
// renders again, as in React. Hooks other than useState come from React itself.
const R = vi.hoisted(() => ({ slots: [] as unknown[], i: 0 }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (init: unknown) => {
    const i = R.i++;
    if (!(i in R.slots)) R.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (u: unknown) => {
      R.slots[i] = typeof u === "function" ? (u as (p: unknown) => unknown)(R.slots[i]) : u;
    };
    return [R.slots[i], set];
  },
}));

let state: { connectionStatus: string; retryCount: number };
vi.mock("@/components/TelegramProvider", () => ({
  useTelegram: () => ({ ...state, reconnect: () => {} }),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import OfflineIndicator from "@/components/OfflineIndicator";

const CONNECTED = { connectionStatus: "connected", retryCount: 0 };
const SYNCING = { connectionStatus: "connecting", retryCount: 0 };
const RETRYING = { connectionStatus: "connecting", retryCount: 4 };
const PROBLEMS = { connectionStatus: "connecting", retryCount: 5 };
const EXPIRED = { connectionStatus: "auth_failed", retryCount: 0 };

/** Renders the mounted indicator in state `s`; returns its markup. */
const show = (s: typeof state) => {
  state = s;
  for (let pass = 0; pass < 5; pass++) {
    R.i = 0;
    const before = [...R.slots];
    const tree = (OfflineIndicator as () => ReactElement | null)();
    if (R.slots.length === before.length && R.slots.every((v, k) => Object.is(v, before[k]))) {
      return tree ? renderToStaticMarkup(tree) : "";
    }
  }
  throw new Error("OfflineIndicator kept setting state during render");
};
/** The class list of the first element in the markup: the one the page lays out. */
const rootClasses = (html: string) => (html.match(/^<\w+[^>]*class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
/** Takes no room in the page: zero height, no padding or margin. */
const takesNoRoom = (html: string) => {
  const root = rootClasses(html);
  return root.includes("h-0") && !root.some((c) => /^(p|py|pt|pb|m|my|mt|mb)-/.test(c));
};
/** The room a bar takes in the page: its height-setting classes (padding, text size). */
const room = (html: string) => {
  const root = rootClasses(html);
  return {
    inPage: !root.includes("h-0") && !root.includes("absolute"),
    padding: root.filter((c) => /^(p|py|pt|pb|m|my|mt|mb|h|min-h)-/.test(c)).sort(),
    text: [...html.matchAll(/<span class="[^"]*\b(text-(?:xs|sm|base))\b/g)].map((m) => m[1]),
  };
};

describe("OfflineIndicator", () => {
  beforeEach(() => {
    R.slots = [];
  });

  it("shows nothing while connected", () => {
    expect(show(CONNECTED)).toBe("");
  });

  it.each([["syncing", SYNCING], ["syncing, retrying", RETRYING]])("%s takes no room, floats, and lets taps through", (_, s) => {
    show(CONNECTED);
    const html = show(s);
    expect(html).toContain("syncing");
    expect(takesNoRoom(html)).toBe(true);
    expect(html).toMatch(/class="[^"]*\bpointer-events-none\b[^"]*\babsolute\b|class="[^"]*\babsolute\b[^"]*\bpointer-events-none\b/);
    expect(html).not.toContain("<button");
  });

  it("connection problems takes its room in the page and its Retry takes a tap", () => {
    const html = show(PROBLEMS);
    expect(html.startsWith("<button")).toBe(true);
    expect(html).toContain("connectionProblems");
    expect(room(html).inPage).toBe(true);
    expect(html).not.toContain("pointer-events-none");
  });

  it("session expired takes its room in the page", () => {
    const html = show(EXPIRED);
    expect(html).toContain("sessionExpired");
    expect(room(html).inPage).toBe(true);
  });

  it("a reconnect started over connection problems keeps its room until connected", () => {
    const problems = show(PROBLEMS);
    const syncing = show(SYNCING); // a return to the app: retries start over
    expect(syncing).toContain("syncing");
    expect(room(syncing)).toEqual(room(problems));
    expect(room(show(RETRYING))).toEqual(room(problems));
    expect(show(CONNECTED)).toBe("");
    expect(takesNoRoom(show(SYNCING))).toBe(true); // the next reconnect floats again
  });

  // The app mounts the indicator while connected; the bars come later.
  it("mounted while connected: offline, connection problems, then a return to the app keeps the bar's room", () => {
    show(CONNECTED);
    expect(takesNoRoom(show(SYNCING))).toBe(true);
    expect(takesNoRoom(show(RETRYING))).toBe(true);
    const problems = show(PROBLEMS);
    expect(room(problems).inPage).toBe(true);
    const syncing = show(SYNCING);
    expect(syncing).toContain("syncing");
    expect(room(syncing)).toEqual(room(problems));
  });

  it("mounted while connected: session expired, then a return to the app keeps the bar's room", () => {
    show(CONNECTED);
    const expired = show(EXPIRED);
    expect(room(show(SYNCING))).toEqual(room(expired));
  });

  it("a reconnect started over session expired keeps its room when it ends there again", () => {
    const expired = show(EXPIRED);
    const syncing = show(SYNCING);
    expect(room(syncing)).toEqual(room(expired));
    expect(room(show(EXPIRED))).toEqual(room(expired));
  });
});
