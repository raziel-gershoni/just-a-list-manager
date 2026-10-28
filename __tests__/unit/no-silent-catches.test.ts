import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import ts from "typescript";

// No silent failures: every caught error is either rethrown or handed to console.error /
// console.warn, with the error object itself, on the handler's own path (a log inside a nested
// callback doesn't count). This covers try/catch, .catch(fn) and .then(ok, fn) in all app code.
// It checks that a log or rethrow is on the handler's path, not that every branch reaches it.
const ROOT = process.cwd();
const DIRS = ["app", "src", "components", "lib", "scripts"];
const ROOT_FILES = ["next.config.ts", "eslint.config.mjs", "postcss.config.mjs", "vitest.config.ts"];
const SOURCE = /\.(ts|tsx|js|mjs|cjs)$/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : walk(path);
    return SOURCE.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

function sourceFiles(): string[] {
  return [
    ...DIRS.flatMap((d) => walk(join(ROOT, d))),
    ...ROOT_FILES.map((f) => join(ROOT, f)),
  ].map((p) => relative(ROOT, p));
}

// Walks a handler body without entering nested functions.
function ownPath(body: ts.Node, visit: (n: ts.Node) => void) {
  const step = (n: ts.Node) => {
    visit(n);
    if (n !== body && ts.isFunctionLike(n)) return;
    ts.forEachChild(n, step);
  };
  step(body);
}

function mentions(node: ts.Node, name: string): boolean {
  if (ts.isIdentifier(node) && node.text === name) return true;
  return ts.forEachChild(node, (c) => mentions(c, name) || undefined) ?? false;
}

function isConsoleErrorOrWarn(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "console" &&
    (expr.name.text === "error" || expr.name.text === "warn")
  );
}

// True when the body rethrows, or logs `errName` with console.error/warn.
function handles(body: ts.Node, errName: string | undefined): boolean {
  let ok = false;
  ownPath(body, (n) => {
    if (ts.isThrowStatement(n)) ok = true;
    if (
      errName &&
      ts.isCallExpression(n) &&
      isConsoleErrorOrWarn(n.expression) &&
      n.arguments.some((a) => mentions(a, errName))
    ) {
      ok = true;
    }
  });
  return ok;
}

function paramName(fn: ts.ArrowFunction | ts.FunctionExpression): string | undefined {
  const p = fn.parameters[0];
  return p && ts.isIdentifier(p.name) ? p.name.text : undefined;
}

function findSilentCatches(file: string, src: string): string[] {
  const kind = file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const at = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const out: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isCatchClause(node)) {
      const decl = node.variableDeclaration;
      const name = decl && ts.isIdentifier(decl.name) ? decl.name.text : undefined;
      if (!handles(node.block, name)) out.push(`${at(node)} catch`);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const handler =
        method === "catch" ? node.arguments[0] : method === "then" ? node.arguments[1] : undefined;
      if (handler) {
        const fine =
          isConsoleErrorOrWarn(handler) ||
          ((ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) &&
            handles(handler.body, paramName(handler)));
        if (!fine) out.push(`${at(node.expression.name)} .${method}`);
      }
    }
    // Inline scripts (e.g. dangerouslySetInnerHTML) are code inside a string: check them too.
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (/\btry\b/.test(node.text) && /\bcatch\b/.test(node.text)) {
        const inner = findSilentCatches("inline.js", node.text);
        out.push(...inner.map((hit) => `${at(node)} inline script: ${hit.replace(/^inline\.js:\d+ /, "")}`));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// request.json() rejects with a SyntaxError that quotes part of the raw body (user content, or
// the OAuth code on the login route), so its catch logs describeBodyParseError(err), never err.
function mentionsOutsideWrapper(node: ts.Node, name: string): boolean {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "describeBodyParseError") {
    return false;
  }
  if (ts.isIdentifier(node) && node.text === name) return true;
  return ts.forEachChild(node, (c) => mentionsOutsideWrapper(c, name) || undefined) ?? false;
}

function findRawBodyParseLogs(file: string, src: string): { checked: string[]; raw: string[] } {
  const kind = file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const at = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const checked: string[] = [];
  const raw: string[] = [];

  const judge = (site: ts.Node, body: ts.Node, errName: string | undefined) => {
    checked.push(at(site));
    let wrapped = false;
    let leaked = false;
    ownPath(body, (n) => {
      if (!ts.isCallExpression(n) || !isConsoleErrorOrWarn(n.expression)) return;
      for (const a of n.arguments) {
        if (errName && mentionsOutsideWrapper(a, errName)) leaked = true;
        if (ts.isCallExpression(a) && ts.isIdentifier(a.expression) && a.expression.text === "describeBodyParseError") wrapped = true;
      }
    });
    if (leaked || !wrapped) raw.push(at(site));
  };

  const visit = (node: ts.Node) => {
    const isBodyParse =
      ts.isCallExpression(node) &&
      node.arguments.length === 0 &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "json" &&
      ts.isIdentifier(node.expression.expression) &&
      ["request", "req"].includes(node.expression.expression.text);
    if (isBodyParse) {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.name.text === "catch" && ts.isCallExpression(parent.parent)) {
        const handler = parent.parent.arguments[0];
        if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
          judge(node, handler.body, paramName(handler));
        } else {
          raw.push(at(node));
        }
      } else {
        for (let a: ts.Node = node; a.parent; a = a.parent) {
          if (ts.isFunctionLike(a)) break;
          if (ts.isTryStatement(a.parent) && a.parent.tryBlock === a && a.parent.catchClause) {
            const c = a.parent.catchClause;
            const decl = c.variableDeclaration;
            judge(node, c.block, decl && ts.isIdentifier(decl.name) ? decl.name.text : undefined);
            break;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { checked, raw };
}

describe("no silent catches", () => {
  it("every caught error in app code is logged with the error, or rethrown", () => {
    const silent = sourceFiles().flatMap((f) =>
      findSilentCatches(f, readFileSync(join(ROOT, f), "utf8"))
    );
    expect(silent).toEqual([]);
  });

  it("the checker scans the app's source folders", () => {
    const files = sourceFiles();
    for (const f of [
      "src/services/voice-handler.ts",
      "app/api/webhook/route.ts",
      "components/TelegramProvider.tsx",
      "lib/utils.ts",
      "scripts/migrate.mjs",
    ]) {
      expect(files).toContain(f);
    }
  });
});

describe("the checker itself", () => {
  const check = (src: string) => findSilentCatches("x.ts", src);

  it("flags empty, comment-only and fallback-only catches", () => {
    expect(check("try { a() } catch {}")).toHaveLength(1);
    expect(check("try { a() } catch { /* ignore */ }")).toHaveLength(1);
    expect(check("try { a() } catch (e) { return null }")).toHaveLength(1);
  });

  it("flags a log that drops the error, or uses console.log", () => {
    expect(check('try { a() } catch (e) { console.error("[X] failed") }')).toHaveLength(1);
    expect(check('try { a() } catch (e) { console.log("[X] failed", e) }')).toHaveLength(1);
  });

  it("flags a log that only happens inside a nested callback", () => {
    expect(check('try { a() } catch (e) { setTimeout(() => console.error("[X]", e)) }')).toHaveLength(1);
  });

  it("flags swallowing promise handlers", () => {
    expect(check("p.catch(() => {})")).toHaveLength(1);
    expect(check("p.catch(() => null)")).toHaveLength(1);
    expect(check("p.then(() => 1, () => {})")).toHaveLength(1);
    expect(check("p.catch(noop)")).toHaveLength(1);
  });

  it("flags a silent catch inside an inline script string", () => {
    expect(check("const html = `try { a() } catch(e) {}`;")).toHaveLength(1);
    expect(check("const html = `try { a() } catch(e) { console.warn('[X]', e); }`;")).toEqual([]);
  });

  it("accepts a logged error, a rethrow, and console.error passed directly", () => {
    expect(check('try { a() } catch (e) { console.warn("[X] failed:", e); return null }')).toEqual([]);
    expect(check('try { a() } catch (e) { throw new Error("x", { cause: e }) }')).toEqual([]);
    expect(check('p.catch((err) => { console.error("[X] failed:", err) })')).toEqual([]);
    expect(check("p.catch(console.error)")).toEqual([]);
    expect(check("p.then((v) => v)")).toEqual([]);
  });
});

describe("a failed request.json() is logged without the body", () => {
  it("every caught body-parse error logs describeBodyParseError(err), not the raw error", () => {
    const results = sourceFiles().map((f) => findRawBodyParseLogs(f, readFileSync(join(ROOT, f), "utf8")));
    expect(results.flatMap((r) => r.raw)).toEqual([]);
    const checked = results.flatMap((r) => r.checked).join("\n");
    expect(checked).toContain("app/api/auth/telegram-login/route.ts");
    expect(checked).toContain("app/api/webhook/route.ts");
    expect(checked).toContain("app/api/lists/[id]/categories/route.ts");
  });

  it("the rule flags a raw error and accepts the wrapped one", () => {
    const check = (src: string) => findRawBodyParseLogs("x.ts", src).raw;
    expect(check('request.json().catch((err) => { console.warn("[X]", err); return null; })')).toHaveLength(1);
    expect(check('try { b = await request.json(); } catch (err) { console.warn("[X]", err); }')).toHaveLength(1);
    expect(check('request.json().catch(() => null)')).toHaveLength(1);
    expect(check('req.json().catch((err) => { console.warn("[X]", err); return null; })')).toHaveLength(1);
    expect(check('request.json().catch((err) => { console.warn("[X]", describeBodyParseError(err)); return null; })')).toEqual([]);
    expect(check('try { b = await request.json(); } catch (err) { console.warn("[X]", describeBodyParseError(err)); }')).toEqual([]);
  });
});
