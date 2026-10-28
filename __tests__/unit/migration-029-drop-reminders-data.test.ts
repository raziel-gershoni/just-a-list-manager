import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";

// Migration 029 is release 2 of the reminders sunset
// (docs/superpowers/specs/2026-10-28-sunset-reminders-design.md). It runs on production before
// `next build`, can run twice (scripts/migrate.mjs records it in a separate step), and drops
// data, so the order of its statements and its preconditions matter.
const raw = readFileSync(
  resolve(process.cwd(), "supabase/migrations/029_drop_reminders_data.sql"),
  "utf8"
);
// Comments may quote the forms forbidden below, so check only the SQL that runs.
const sql = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");

const SOFT_DELETE =
  /UPDATE\s+lists\s+SET\s+deleted_at\s*=\s*now\(\)\s+WHERE\s+type\s*=\s*'reminders'\s+AND\s+deleted_at\s+IS\s+NULL\s*;/i;
const RETYPE = /UPDATE\s+lists\s+SET\s+type\s*=\s*'regular'\s+WHERE\s+type\s*=\s*'reminders'\s*;/i;

describe("migration 029_drop_reminders_data", () => {
  it("soft-deletes straggler reminders lists before retyping them", () => {
    const softDelete = sql.search(SOFT_DELETE);
    const retype = sql.search(RETYPE);
    expect(softDelete).toBeGreaterThanOrEqual(0);
    expect(retype, "retyping first would turn live stragglers into visible regular lists").toBeGreaterThan(
      softDelete
    );
  });

  it("adds the lists.type CHECK only when missing, after the retype", () => {
    const retype = sql.search(RETYPE);
    const guard = sql.search(
      /IF\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+pg_constraint\s+WHERE\s+conname\s*=\s*'lists_type_check'/i
    );
    const add = sql.search(
      /ALTER\s+TABLE\s+lists\s+ADD\s+CONSTRAINT\s+lists_type_check\s+CHECK\s*\(\s*type\s+IN\s*\(\s*'regular'\s*,\s*'grocery'\s*\)\s*\)\s*;/i
    );
    const endIf = sql.search(/END\s+IF\s*;/i);
    expect(retype).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(retype);
    expect(add).toBeGreaterThan(guard);
    expect(endIf).toBeGreaterThan(add);
  });

  it("drops the reminders table and the time zone column, idempotently and without CASCADE", () => {
    expect(sql).toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+item_reminders\s*;/i);
    expect(sql).toMatch(/ALTER\s+TABLE\s+users\s+DROP\s+COLUMN\s+IF\s+EXISTS\s+timezone\s*;/i);
    expect(sql, "an unexpected dependent must fail the deploy, not vanish silently").not.toMatch(/\bCASCADE\b/i);
  });

  it("never calls cron.unschedule by job name and leaves cleanup-soft-deletes alone", () => {
    expect(sql).not.toMatch(/cron\.unschedule\s*\(\s*'/i);
    expect(sql).not.toContain("cleanup-soft-deletes");
  });

  it("has no transaction control of its own", () => {
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|END)\s*;/im);
    expect(sql).not.toMatch(/\bSTART\s+TRANSACTION\b/i);
  });
});

// Dropping a table or column that live code still reads breaks production at runtime with no
// type error, so release 2 is safe only while nothing reads them.
function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx|mjs|js)$/.test(full)) acc.push(full);
  }
  return acc;
}

describe("release 2 precondition", () => {
  it("no app code or script reads item_reminders or users.timezone", () => {
    const root = process.cwd();
    const patterns = [
      /\.from\(\s*["'`]item_reminders["'`]\s*\)/,
      /\.select\(\s*["'`][^"'`]*\btimezone\b[^"'`]*["'`]/,
      /\.timezone\b/,
    ];
    const offenders: string[] = [];
    for (const dir of ["app", "src", "components", "scripts"].map((d) => resolve(root, d))) {
      for (const file of walk(dir)) {
        const text = readFileSync(file, "utf8");
        if (patterns.some((p) => p.test(text))) offenders.push(file.replace(root + "/", ""));
      }
    }
    expect(
      offenders,
      `these files still read data that migration 029 drops: ${offenders.join(", ")}`
    ).toEqual([]);
  });
});
