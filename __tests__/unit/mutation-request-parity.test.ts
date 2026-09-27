import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Every queued mutation is implemented TWICE: an inline `execute` closure in
// addMutation({...}) (src/hooks/useItemHandlers.ts, src/hooks/useListDragDrop.ts)
// that runs while online, and a `case` in src/utils/executor-factory.ts that
// rebuilds the executor on replay after a page reload (pendingExecutors in
// useMutationQueue.ts is an in-memory ref and does not survive one). If the two
// disagree about the request to send, the app behaves differently online vs.
// after a reload -- silently.
//
// This already happened in production: the "toggle" case POSTed to
// /complete-recurring when online but did a plain PATCH /items on replay.
// Tapping Done on a recurring reminder while offline, then reopening the app,
// marked the item complete and never created the next occurrence -- silently
// ending the user's recurring series. Fixed in 5f3dd51.
//
// __tests__/unit/executor-factory.test.ts already asserts every mutation type
// HAS a factory case -- it catches a missing case, not a divergent one, which
// is what actually bit. This test closes that gap by extracting the set of
// (method, url) pairs each side can send, per type, and asserting the two
// sets match exactly.
//
// The two implementations are deliberately asymmetric (optimistic setItems +
// React-scope reads on the inline side; no optimistic insert + a Realtime-only
// successor on the factory side; a drag-lock `finally` in useListDragDrop.ts
// the factory structurally can't reproduce) -- unifying them was considered
// and rejected. Only the request shape needs to agree, so this is a
// source-inspection test (pattern: recycle-scoping.test.ts,
// no-deleted-item-leak.test.ts, reminder-callback-auth.test.ts) rather than a
// behavioral one: vitest runs in node here, with no jsdom, so the inline
// closures (which live inside React hooks) cannot actually be invoked.

type Pair = { method: string; url: string };

function pairKey(p: Pair): string {
  return `${p.method} ${p.url}`;
}

// Template interpolations differ cosmetically between the two sides (e.g.
// `${payload.listId}` on the factory side vs. `${listId}` on the inline side)
// but must refer to the same value. Collapse every `${...}` to a placeholder
// so the two normalize to the same string.
function normalizeUrl(url: string): string {
  return url.replace(/\$\{[^}]*\}/g, "{}");
}

// Returns the index of the close bracket matching the open bracket at
// `openIndex` (which must point AT the open character). Backtick template
// literals and quoted strings are treated as opaque spans -- so a `${...}`
// interpolation's braces inside a template literal never perturb the depth
// count -- which is what makes this safe to use on a URL template literal
// passed as a fetch() argument.
function findMatchingClose(
  source: string,
  openIndex: number,
  openChar: string,
  closeChar: string
): number {
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const c = source[i];
    if (c === "`" || c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < source.length && source[i] !== quote) {
        i += source[i] === "\\" ? 2 : 1;
      }
      i++;
      continue;
    }
    if (c === openChar) {
      depth++;
    } else if (c === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  throw new Error(`no matching "${closeChar}" found for "${openChar}" at index ${openIndex}`);
}

// Extracts every `fetch(\`URL\`, { method: "METHOD", ... })` call inside
// `slice`, as normalized (method, url) pairs. Requires `method` to be the
// request-init object's first key -- true of every fetch() call in both
// source files this test reads (verified by hand while writing this test);
// the "at least one pair per case" sanity test below would fail loudly if a
// future call site broke that assumption instead of this silently matching
// zero pairs.
function extractFetchPairs(slice: string): Pair[] {
  const re = /fetch\(\s*`([^`]*)`\s*,\s*\{\s*method:\s*"([A-Z]+)"/g;
  const pairs: Pair[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) {
    pairs.push({ method: m[2], url: normalizeUrl(m[1]) });
  }
  return pairs;
}

function pairSetToString(pairs: Pair[]): string {
  return [...new Set(pairs.map(pairKey))].sort().join(", ") || "(none)";
}

// executor-factory.ts is one flat `switch (type)` with no nesting between
// cases, so slicing each `case "<type>":` up to the next `case "` (or the
// trailing `default:`) is safe -- there is no code between two case labels
// that belongs to neither.
function extractFactoryCases(source: string): Map<string, Pair[]> {
  const result = new Map<string, Pair[]>();
  const caseRe = /case\s*"([a-zA-Z-]+)":/g;
  const starts: { type: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(source)) !== null) {
    starts.push({ type: m[1], index: m.index });
  }
  if (starts.length === 0) {
    throw new Error('no `case "...":` labels found in executor-factory.ts -- extraction regex is stale');
  }

  const defaultIdx = source.indexOf("default:");
  if (defaultIdx <= 0) {
    throw new Error("no `default:` label found in executor-factory.ts -- expected end-of-switch anchor");
  }

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].index;
    const end = i + 1 < starts.length ? starts[i + 1].index : defaultIdx;
    const slice = source.slice(start, end);
    const existing = result.get(starts[i].type) ?? [];
    result.set(starts[i].type, [...existing, ...extractFetchPairs(slice)]);
  }
  return result;
}

// useItemHandlers.ts / useListDragDrop.ts call `addMutation({ id, type,
// payload, execute })` at the top level of a handler -- calls are never
// nested inside one another. Rather than slicing from one `type: "..."` to
// the next (which would run past the current call's `execute` closure and
// into unrelated code whenever the NEXT addMutation call is far away, or
// there is no next one -- e.g. "restore-recurring" is the last addMutation
// call in useItemHandlers.ts, so a naive slice-to-next-type would run to EOF
// and vacuum up unrelated fetch() calls from handleClearCompleted,
// sendSignal, etc.), this finds each literal `addMutation({` call site and
// brace-matches its object-literal argument precisely, so the slice is
// exactly that one call's `{ id, type, payload, execute }` -- nothing more,
// nothing less.
function extractAddMutationCases(source: string): Map<string, Pair[]> {
  const result = new Map<string, Pair[]>();
  const anchor = "addMutation({";
  let searchFrom = 0;
  let callCount = 0;
  while (true) {
    const idx = source.indexOf(anchor, searchFrom);
    if (idx === -1) break;
    callCount++;
    const openBrace = idx + "addMutation(".length; // index of the "{"
    const closeBrace = findMatchingClose(source, openBrace, "{", "}");
    const slice = source.slice(openBrace, closeBrace + 1);

    const typeMatch = slice.match(/type:\s*"([a-zA-Z-]+)"/);
    if (!typeMatch) {
      throw new Error(`addMutation({ call at source index ${idx} has no type: "..." field`);
    }
    const type = typeMatch[1];

    const existing = result.get(type) ?? [];
    result.set(type, [...existing, ...extractFetchPairs(slice)]);
    searchFrom = closeBrace + 1;
  }
  if (callCount === 0) {
    throw new Error("no addMutation({ call sites found -- extraction anchor is stale");
  }
  return result;
}

describe("mutation request parity: online (inline) vs. replay (factory)", () => {
  const factorySource = readFileSync(
    resolve(process.cwd(), "src/utils/executor-factory.ts"),
    "utf8"
  );
  const handlersSource = readFileSync(
    resolve(process.cwd(), "src/hooks/useItemHandlers.ts"),
    "utf8"
  );
  // "reorder" is enqueued from the drag-and-drop hook, not useItemHandlers.ts.
  const dragDropSource = readFileSync(
    resolve(process.cwd(), "src/hooks/useListDragDrop.ts"),
    "utf8"
  );

  const factoryCases = extractFactoryCases(factorySource);
  const inlineCases = extractAddMutationCases(handlersSource);
  for (const [type, pairs] of extractAddMutationCases(dragDropSource)) {
    const existing = inlineCases.get(type) ?? [];
    inlineCases.set(type, [...existing, ...pairs]);
  }

  it("sanity: every extracted case yielded at least one (method, url) pair", () => {
    for (const [type, pairs] of factoryCases) {
      expect(
        pairs.length,
        `factory case "${type}" yielded zero fetch(...) calls -- extractFetchPairs likely failed to match its shape`
      ).toBeGreaterThan(0);
    }
    for (const [type, pairs] of inlineCases) {
      expect(
        pairs.length,
        `inline mutation "${type}" yielded zero fetch(...) calls -- extractFetchPairs likely failed to match its shape`
      ).toBeGreaterThan(0);
    }
  });

  it("factory and inline sides handle the exact same set of mutation types", () => {
    const factoryTypes = [...factoryCases.keys()].sort();
    const inlineTypes = [...inlineCases.keys()].sort();
    expect(inlineTypes).toEqual(factoryTypes);
  });

  const allTypes = [...new Set([...factoryCases.keys(), ...inlineCases.keys()])].sort();

  for (const type of allTypes) {
    it(`"${type}": online and replay send the same request(s)`, () => {
      const factoryPairs = factoryCases.get(type) ?? [];
      const inlinePairs = inlineCases.get(type) ?? [];
      const factorySet = [...new Set(factoryPairs.map(pairKey))].sort();
      const inlineSet = [...new Set(inlinePairs.map(pairKey))].sort();

      expect(
        inlineSet,
        `mutation type "${type}" diverges between online and replay -- this is the exact class of ` +
          `bug fixed in 5f3dd51 (recurring "toggle" silently ending the series on replay).\n` +
          `  inline (online, useItemHandlers.ts / useListDragDrop.ts): ${pairSetToString(inlinePairs)}\n` +
          `  factory (replay, executor-factory.ts):                    ${pairSetToString(factoryPairs)}`
      ).toEqual(factorySet);
    });
  }
});
