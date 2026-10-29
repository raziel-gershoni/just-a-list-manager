import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import type { ItemData } from "@/src/types";
import { isActiveItem, isParkedRecurringItem } from "@/src/utils/list-helpers";

// Owner decision 4 (docs/superpowers/specs/2026-10-29-sync-engine-repair-design.md): a Home card's
// counts match the list's own sections. There is no Postgres in the test run, so this reads the two
// FILTER predicates out of the migration, evaluates them on every combination of the item states,
// and compares the result with the predicates the list page itself uses.
const DIR = resolve(process.cwd(), "supabase/migrations");
const FILE = "030_list_item_counts_match_list.sql";
const raw = readFileSync(resolve(DIR, FILE), "utf8");
// Comments may quote other forms, so check only the SQL that runs.
const sql = raw.replace(/--.*$/gm, "");

function filterOf(alias: string): string {
  const m = sql.match(new RegExp(`COUNT\\(\\*\\)\\s+FILTER\\s*\\(\\s*WHERE\\s+([^()]*?)\\s*\\)\\s+AS\\s+${alias}\\b`, "i"));
  if (!m) throw new Error(`no COUNT(*) FILTER (WHERE ...) AS ${alias} in ${FILE}`);
  return m[1];
}

// Evaluates the small SQL subset these predicates use: `i.col = true|false`, `i.col IS [NOT] NULL`, AND.
function evaluate(predicate: string, row: ItemData): boolean {
  return predicate.split(/\s+AND\s+/i).every((term) => {
    const cell = (col: string) => (row as unknown as Record<string, unknown>)[col];
    let m: RegExpMatchArray | null;
    if ((m = term.trim().match(/^i\.(\w+)\s*=\s*(true|false)$/i))) return cell(m[1]) === (m[2].toLowerCase() === "true");
    if ((m = term.trim().match(/^i\.(\w+)\s+IS\s+NULL$/i))) return cell(m[1]) == null;
    if ((m = term.trim().match(/^i\.(\w+)\s+IS\s+NOT\s+NULL$/i))) return cell(m[1]) != null;
    throw new Error(`unsupported term in the counts filter: ${term}`);
  });
}

// Every combination of the states that decide an item's section. Deleted rows are left out:
// the function's WHERE drops them before either count.
const ROWS: ItemData[] = [];
for (const completed of [false, true])
  for (const skipped_at of [null, "2026-10-29T10:00:00.000Z"])
    for (const ordered_at of [null, "2026-10-29T10:00:00.000Z"])
      for (const recurring of [false, true])
        ROWS.push({
          id: `${completed}-${!!skipped_at}-${!!ordered_at}-${recurring}`,
          text: "x", completed, completed_at: completed ? "2026-10-29T11:00:00.000Z" : null,
          deleted_at: null, skipped_at, ordered_at, recurring, position: 1,
          created_by: null, creator_name: null, edited_by: null, editor_name: null,
        });

describe(`migration ${FILE}`, () => {
  it("counts as active exactly the items the list shows as still to do (skipped ones left out)", () => {
    const active = filterOf("active_count");
    for (const row of ROWS) expect(evaluate(active, row), row.id).toBe(isActiveItem(row));
  });

  it("counts as completed exactly the items the list shows under Completed (parked recurring ones left out)", () => {
    const completed = filterOf("completed_count");
    for (const row of ROWS) expect(evaluate(completed, row), row.id).toBe(row.completed && !isParkedRecurringItem(row));
  });

  it("still drops deleted rows before counting", () => {
    expect(sql).toMatch(/WHERE\s+i\.list_id\s*=\s*ANY\(p_list_ids\)\s+AND\s+i\.deleted_at\s+IS\s+NULL/i);
  });

  it("keeps the function's signature and attributes, so CREATE OR REPLACE keeps its grants", () => {
    expect(sql).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+get_list_item_counts\s*\(\s*p_list_ids\s+UUID\[\]\s*\)/i);
    expect(sql).toMatch(/RETURNS\s+TABLE\s*\(\s*list_id\s+UUID\s*,\s*active_count\s+BIGINT\s*,\s*completed_count\s+BIGINT\s*\)/i);
    expect(sql).toMatch(/LANGUAGE\s+sql\s+SECURITY\s+DEFINER\s+STABLE\s+SET\s+search_path\s*=\s*public\s*;/i);
  });

  it("has no transaction control and drops nothing", () => {
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    expect(sql).not.toMatch(/\bDROP\b/i);
  });

  it("is the last migration that defines get_list_item_counts, so its version is the one that applies", () => {
    const definers = readdirSync(DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .filter((f) => /FUNCTION\s+get_list_item_counts\b/i.test(readFileSync(resolve(DIR, f), "utf8")));
    expect(definers.at(-1)).toBe(FILE);
  });
});
