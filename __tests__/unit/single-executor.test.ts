import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Every queued change is sent by executor-factory through the sync engine, online and on
// replay. An inline request inside an addMutation call would be a second request builder
// for that type, the drift that once made a tap do one thing online and another after a
// reload (5f3dd51). Source inspection: these hooks can't run their handlers in node without
// a page around them, and what matters is that the call sites carry no request.

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const QUEUING_FILES = ["src/hooks/useItemHandlers.ts", "src/hooks/useListDragDrop.ts"];

// The object literal passed to each call that starts with `needle` (which ends in `({`),
// brace-matched (strings and template literals are skipped so their braces don't count).
function callArgs(source: string, needle: string): string[] {
  const args: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) return args;
    const open = at + needle.length - 1;
    let depth = 0;
    let i = open;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === "`" || c === '"' || c === "'") {
        for (i++; i < source.length && source[i] !== c; i += source[i] === "\\" ? 2 : 1);
        continue;
      }
      if (c === "{") depth++;
      if (c === "}" && --depth === 0) break;
    }
    args.push(source.slice(open, i + 1));
    from = i + 1;
  }
}

const addMutationArgs = (source: string) => callArgs(source, "addMutation({");

const factoryCases = new Set(
  [...read("src/utils/executor-factory.ts").matchAll(/case\s*"([a-zA-Z-]+)":/g)].map((m) => m[1])
);

describe("one executor per change", () => {
  for (const file of QUEUING_FILES) {
    const calls = addMutationArgs(read(file));

    it(`${file}: finds its addMutation calls`, () => {
      expect(calls.length).toBeGreaterThan(0);
    });

    it(`${file}: no addMutation call carries its own request`, () => {
      for (const call of calls) {
        expect(call, call).not.toMatch(/\bexecute\b/);
        expect(call, call).not.toMatch(/\bfetch\(/);
      }
    });

    it(`${file}: every queued type has an executor-factory case`, () => {
      for (const call of calls) {
        const type = call.match(/type:\s*"([a-zA-Z-]+)"/)?.[1];
        expect(type, call).toBeDefined();
        expect(factoryCases.has(type!), `no executor-factory case for "${type}"`).toBe(true);
      }
    });
  }
});

// useListData queues the auto-unskip and auto-respawn changes straight on the list's engine.
// Same rule: the type must have a factory case, or the change is dropped with a toast.
describe("one executor per change: changes queued on the engine", () => {
  const file = "src/hooks/useListData.ts";
  const calls = callArgs(read(file), "getSyncEngine(listId).add({");

  it(`${file}: finds its engine add calls`, () => {
    expect(calls.length).toBeGreaterThan(0);
  });

  it(`${file}: every queued type has an executor-factory case`, () => {
    for (const call of calls) {
      const type = call.match(/type:\s*"([a-zA-Z-]+)"/)?.[1];
      expect(type, call).toBeDefined();
      expect(factoryCases.has(type!), `no executor-factory case for "${type}"`).toBe(true);
    }
  });
});
