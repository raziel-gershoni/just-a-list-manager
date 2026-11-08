import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

// The categories switch is race-safe only because of a few lines of SQL: the categorizer's
// write and the category insert check the switch under the list row lock, and the off cleans up
// in one function. A later migration that re-creates one of these functions (to add a
// parameter, say) must keep them. Each check reads the function as the newest migration
// defines it, with SQL comments stripped so a comment can't stand in for the code.
const dir = resolve(process.cwd(), "supabase/migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

function latestBody(name: string): { file: string; body: string } {
  const marker = `CREATE OR REPLACE FUNCTION ${name}(`;
  for (const file of [...files].reverse()) {
    const sql = readFileSync(join(dir, file), "utf8");
    const at = sql.lastIndexOf(marker);
    if (at === -1) continue;
    const open = sql.indexOf("AS $$", at);
    const close = sql.indexOf("$$ LANGUAGE", open + 5);
    if (open === -1 || close === -1) throw new Error(`${file}: no $$ body for ${name}`);
    return { file, body: sql.slice(open + 5, close).replace(/--[^\n]*/g, "") };
  }
  throw new Error(`no migration defines ${name}`);
}

const at = (body: string, re: RegExp) => body.search(re);

describe("the SQL behind the categories switch", () => {
  it("apply_item_categories writes nothing while the list's categories are off", () => {
    const { body } = latestBody("apply_item_categories");
    const guard = at(body, /PERFORM\s+1\s+FROM\s+lists\s+WHERE\s+id\s*=\s*p_list_id\s+AND\s+categories_enabled\s+FOR\s+SHARE\s*;\s*IF\s+NOT\s+FOUND\s+THEN\s+RETURN\s+0\s*;/i);
    const write = at(body, /UPDATE\s+items\b/i);
    expect(guard).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(guard);
  });

  it("insert_list_category adds nothing while the list's categories are off", () => {
    const { body } = latestBody("insert_list_category");
    const guard = at(body, /PERFORM\s+1\s+FROM\s+lists\s+WHERE\s+id\s*=\s*p_list_id\s+AND\s+categories_enabled\s+FOR\s+UPDATE\s*;\s*IF\s+NOT\s+FOUND\s+THEN\s+RETURN\s*;/i);
    const insert = at(body, /INSERT\s+INTO\s+list_categories\b/i);
    expect(guard).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(guard);
  });

  describe("set_list_categories_enabled", () => {
    const { body } = latestBody("set_list_categories_enabled");
    const first = body.replace(/^\s*BEGIN\s+/i, "").split(";")[0];

    it("takes the list row first, setting the switch on a list that is not deleted", () => {
      expect(first).toMatch(/^UPDATE\s+lists\s+SET\b/i);
      expect(first).toMatch(/\bcategories_enabled\s*=\s*p_enabled\b/i);
      expect(first).toMatch(/\bdeleted_at\s+IS\s+NULL\b/i);
    });

    it("clears an owed re-scan when off", () => {
      expect(first).toMatch(/\bcategories_rescan_at\s*=\s*CASE\s+WHEN\s+p_enabled\s+THEN\s+categories_rescan_at\s+ELSE\s+NULL\s+END\b/i);
    });

    it("off deletes the list's categories, then takes every item out of them", () => {
      const start = at(body, /IF\s+NOT\s+p_enabled\s+THEN\b/i);
      expect(start).toBeGreaterThan(-1);
      const rest = body.slice(start);
      const branch = rest.slice(0, at(rest, /END\s+IF\s*;/i));
      const del = at(branch, /DELETE\s+FROM\s+list_categories\s+WHERE\s+list_id\s*=\s*p_list_id\b/i);
      const clear = at(branch, /UPDATE\s+items\s+SET\s+category_id\s*=\s*NULL\s*,\s*category_locked\s*=\s*false\b[^;]*\bWHERE\s+list_id\s*=\s*p_list_id\b/i);
      expect(del).toBeGreaterThan(-1);
      expect(clear).toBeGreaterThan(del);
    });
  });
});
