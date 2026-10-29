import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { resolve, join } from "path";

// 5eb9dc4 closed a cross-list write: recycleItem used to be called with the
// client's raw recycleId, so any authenticated user could pass an arbitrary
// item id from someone else's list and have it resurrected/re-attributed into
// theirs. Since the sync repair (spec 2026-10-29, H8) the route hands the
// client's recycleId to recycleItem, and the service is the guard: its lookup
// is scoped to list_id and to live rows, it reuses only a row with the
// expected text, and its update is scoped to list_id again. The behaviour is
// proven in recycle-replay.test.ts and item-recycler.test.ts; this file keeps
// the call-site rules a future caller could break without any test noticing:
// all three queries keep list_id, and every call passes listId and the text.

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

  it("POST /api/lists/[id]/items makes one recycleItem call, with the list and the item's text", () => {
    // The text is what lets recycleItem refuse an id that names some other item, and
    // return an already-active item unchanged instead of a second copy.
    const calls = findRecycleItemCalls(routeSource);
    expect(calls.length, "expected exactly one recycleItem( call in this route").toBe(1);
    expect(calls[0].split(",").map((a) => a.trim())).toEqual(["recycleId", "auth.userId", "listId", "text"]);
  });

  const recyclerPath = resolve(root, "src/services/item-recycler.ts");
  const recyclerSource = readFileSync(recyclerPath, "utf8");

  it("recycleItem scopes all three of its queries to list_id, not just id", () => {
    // Scoped to the recycleItem function body on purpose: other functions in
    // this file (findRecyclableItems, findFuzzyMatch) also filter by
    // list_id, so an unscoped assertion over the whole file would pass even
    // if recycleItem's own lookup, max-position read or update lost its guard.
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
      `recycleItem must scope its lookup, its max-position read and its update by ` +
        `.eq("list_id", listId); found ${occurrences} occurrence(s). The route passes the ` +
        `client's recycleId straight in, so a lost guard lets a cross-list itemId reach the write.`
    ).toBe(3);
  });

  it("every recycleItem( call site across app/ and src/ passes listId and the expected text", () => {
    // A future caller cannot silently omit listId or the text — this asserts on
    // argument count, not on the names passed (the route's names are checked
    // above); its job is to keep a call that drops either from ever being
    // reintroduced, here or in a new caller.
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
      `expected exactly 2 live recycleItem( call sites (route.ts + recycleOrThrow in voice-handler.ts), ` +
        `found ${callSites.length}: ${callSites.map((c) => c.file).join(", ")}`
    ).toBe(2);

    for (const { file, args } of callSites) {
      const argCount = args.split(",").length;
      expect(
        argCount,
        `recycleItem( call in ${file} passes ${argCount} argument(s) (${args.trim()}); ` +
          `it must pass exactly 4 (itemId, userId, listId, text) so neither listId nor the text check can be silently omitted`
      ).toBe(4);
    }
  });
});
