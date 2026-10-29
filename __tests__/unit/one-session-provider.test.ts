import { describe, it, expect, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import type { ReactElement, ReactNode } from "react";

// A page that mounts its own provider starts a new session on every navigation, with the
// launch initData that the server refuses after 5 minutes (H2). One layout owns it instead.
vi.mock("@/components/TelegramProvider", () => ({ default: function TelegramProvider() { return null; } }));

import AppLayout from "@/app/(app)/layout";
import TelegramProvider from "@/components/TelegramProvider";

const ROOT = process.cwd();
const walk = (dir: string): string[] =>
  readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) return name === "node_modules" ? [] : walk(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });

describe("one TelegramProvider per app launch", () => {
  it("the (app) layout wraps its screens in the provider", () => {
    const child = "screen" as ReactNode;
    const el = AppLayout({ children: child }) as ReactElement<{ children: ReactNode }>;
    expect(el.type).toBe(TelegramProvider);
    expect(el.props.children).toBe(child);
  });

  it("home, list and invite live under the layout, and the login pages stay outside it", () => {
    for (const f of ["app/(app)/page.tsx", "app/(app)/list/[id]/page.tsx", "app/(app)/invite/[token]/page.tsx", "app/login/page.tsx", "app/login/callback/page.tsx"]) {
      expect(existsSync(join(ROOT, f)), f).toBe(true);
    }
    for (const f of ["app/page.tsx", "app/list/[id]/page.tsx", "app/invite/[token]/page.tsx"]) {
      expect(existsSync(join(ROOT, f)), f).toBe(false);
    }
  });

  it("nothing but the (app) layout renders a TelegramProvider", () => {
    const renderers = ["app", "components", "src"]
      .flatMap(walk)
      .filter((f) => /<TelegramProvider[\s>]/.test(readFileSync(join(ROOT, f), "utf8")))
      .map((f) => relative(".", f));
    expect(renderers).toEqual([join("app", "(app)", "layout.tsx")]);
  });
});
