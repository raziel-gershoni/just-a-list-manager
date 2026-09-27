import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { resolve, join } from "path";

// 5eb9dc4 closed a cross-list write: recycleItem used to be called with the
// client's raw recycleId, so any authenticated user could pass an arbitrary
// item id from someone else's list and have it resurrected/re-attributed into
// theirs. The fix has three independent parts — the route resolves the id
// against a list-scoped lookup (pickRecyclable) before calling in, the
// service itself scopes both of its queries by list_id as defence in depth,
// and every call site is required to pass listId at all. None of that is
// exercised by pick-recyclable.test.ts, which only tests the pure helper in
// isolation — so a revert of any one of the three parts would leave the full
// suite green while reopening the hole. That is exactly the "compiles fine,
// fails only in production" class this file exists to catch.

const root = process.cwd();

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(full)) acc.push(full);
  }
  return acc;
}

/**
 * Find `recycleItem(...)` call sites in a source string, returning each
 * call's raw argument text. Excludes the `export async function recycleItem(`
 * declaration itself — that's the definition, not a caller.
 */
function findRecycleItemCalls(source: string): string[] {
  const calls: string[] = [];
  const regex = /recycleItem\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const before = source.slice(Math.max(0, match.index - 40), match.index);
    if (/function\s*$/.test(before)) continue; // the declaration, not a call
    calls.push(match[1]);
  }
  return calls;
}

describe("recycleItem scoping", () => {
  const routePath = resolve(root, "app/api/lists/[id]/items/route.ts");
  const routeSource = readFileSync(routePath, "utf8");

  it("POST /api/lists/[id]/items never passes the raw client recycleId into recycleItem", () => {
    // The whole point of pickRecyclable is that the client-supplied id is
    // resolved against the server's own list-scoped lookup first. Passing
    // parsedCreate.data.recycleId straight through would let a client name
    // any item id, in any list, as the thing to resurrect.
    expect(routeSource).not.toContain("recycleItem(parsedCreate.data.recycleId");

    const calls = findRecycleItemCalls(routeSource);
    expect(calls.length, "expected exactly one recycleItem( call in this route").toBe(1);
    expect(
      calls[0].trim().startsWith("toRecycle.id"),
      `recycleItem's first argument must be toRecycle.id (the value pickRecyclable already ` +
        `validated against this list), got: recycleItem(${calls[0]})`
    ).toBe(true);
  });

  const recyclerPath = resolve(root, "src/services/item-recycler.ts");
  const recyclerSource = readFileSync(recyclerPath, "utf8");

  it("recycleItem scopes both of its queries to list_id, not just id", () => {
    // Scoped to the recycleItem function body on purpose: other functions in
    // this file (findRecyclableItems, findFuzzyMatch) also filter by
    // list_id, so an unscoped assertion over the whole file would pass even
    // if recycleItem's own two queries lost their list_id guard.
    const start = recyclerSource.indexOf("export async function recycleItem");
    expect(start, "recycleItem export not found in item-recycler.ts").toBeGreaterThanOrEqual(0);
    const nextExportIdx = recyclerSource.indexOf(
      "export",
      start + "export async function recycleItem".length
    );
    const fn = recyclerSource.slice(
      start,
      nextExportIdx === -1 ? recyclerSource.length : nextExportIdx
    );
    expect(fn.length).toBeGreaterThan(0);

    const occurrences = fn.split('.eq("list_id", listId)').length - 1;
    expect(
      occurrences,
      `recycleItem must scope both its lookup and its update by .eq("list_id", listId); ` +
        `found ${occurrences} occurrence(s). Dropping either one lets a cross-list itemId ` +
        `reach the write even when pickRecyclable is bypassed.`
    ).toBeGreaterThanOrEqual(2);
  });

  it("every recycleItem( call site across app/ and src/ passes listId as a third argument", () => {
    // A future caller cannot silently omit listId — this asserts on argument
    // count, not just presence of the word "listId", so a call site that
    // passes some other 3rd value still passes (that's caught by the two
    // tests above); this test's job is to keep a 2-argument call from ever
    // being reintroduced.
    const files = [...walk(resolve(root, "app")), ...walk(resolve(root, "src"))];
    const callSites: { file: string; args: string }[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const args of findRecycleItemCalls(source)) {
        callSites.push({ file: file.replace(root + "/", ""), args });
      }
    }

    expect(
      callSites.length,
      `expected exactly 3 live recycleItem( call sites (route.ts + 2 in voice-handler.ts), ` +
        `found ${callSites.length}: ${callSites.map((c) => c.file).join(", ")}`
    ).toBe(3);

    for (const { file, args } of callSites) {
      const argCount = args.split(",").length;
      expect(
        argCount,
        `recycleItem( call in ${file} passes ${argCount} argument(s) (${args.trim()}); ` +
          `it must pass exactly 3 (itemId, userId, listId) so listId can never be silently omitted`
      ).toBe(3);
    }
  });
});
