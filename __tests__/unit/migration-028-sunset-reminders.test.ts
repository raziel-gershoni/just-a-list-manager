import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Migration 028 runs on production before `next build` (scripts/migrate.mjs runs each
// file as one implicit transaction, then records it in a separate statement). Any statement
// that errors fails the whole deploy, and a file that ran but wasn't recorded runs again.
// These checks hold the properties docs/superpowers/specs/2026-10-28-sunset-reminders-design.md
// relies on.
const raw = readFileSync(
  resolve(process.cwd(), "supabase/migrations/028_sunset_reminders.sql"),
  "utf8"
);
// Comments may quote the forms forbidden below, so check only the SQL that runs.
const sql = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");

describe("migration 028_sunset_reminders", () => {
  it("soft-deletes only reminders lists that are still live", () => {
    expect(sql).toMatch(
      /UPDATE\s+lists\s+SET\s+deleted_at\s*=\s*now\(\)\s+WHERE\s+type\s*=\s*'reminders'\s+AND\s+deleted_at\s+IS\s+NULL\s*;/i
    );
    const updates = sql.match(/\bUPDATE\b[\s\S]*?;/gi) ?? [];
    expect(updates, "028 must write nothing but the reminders-list soft-delete").toHaveLength(1);
  });

  it("unschedules both reminder jobs with the filtered form, inside a pg_cron guard", () => {
    expect(sql).toMatch(/DO\s+\$\$[\s\S]*END\s+\$\$\s*;/i);
    const guard = sql.search(
      /IF\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+pg_extension\s+WHERE\s+extname\s*=\s*'pg_cron'\s*\)\s+THEN/i
    );
    const unschedule = sql.search(
      /PERFORM\s+cron\.unschedule\(\s*jobid\s*\)\s+FROM\s+cron\.job\s+WHERE\s+jobname\s+IN\s*\(\s*'process-reminders'\s*,\s*'reminder-digest'\s*\)\s*;/i
    );
    const endIf = sql.search(/END\s+IF\s*;/i);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(unschedule).toBeGreaterThan(guard);
    expect(endIf).toBeGreaterThan(unschedule);
  });

  it("never calls cron.unschedule by job name (it raises when the job is missing)", () => {
    expect(sql).not.toMatch(/cron\.unschedule\s*\(\s*'/i);
  });

  it("leaves the cleanup-soft-deletes job alone", () => {
    expect(sql).not.toContain("cleanup-soft-deletes");
  });

  it("drops or alters nothing the old code still reads during the deploy", () => {
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bALTER\s+TABLE\b/i);
  });

  it("has no transaction control of its own", () => {
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|END)\s*;/im);
    expect(sql).not.toMatch(/\bSTART\s+TRANSACTION\b/i);
  });
});
