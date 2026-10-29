// A stateful items table behind the fakeSupabase builder. Reads and updates apply their
// filters to the rows, and the insert RPC adds a row, so a route test can assert what the
// database holds afterwards instead of which query text was sent.
import { fakeSupabase, type FakeCall, type FakeResult } from "./fake-supabase";

export type ItemRow = {
  id: string;
  list_id: string;
  text: string;
  completed: boolean;
  completed_at: string | null;
  deleted_at: string | null;
  skipped_at: string | null;
  ordered_at: string | null;
  recurring: boolean;
  position: number;
  created_by: string | null;
  // Set by the insert RPC when it is given p_idempotency_key.
  idempotency_key?: string | null;
};

export function itemRow(over: Partial<ItemRow> & { id: string }): ItemRow {
  return {
    list_id: "L",
    text: "x",
    completed: false,
    completed_at: null,
    deleted_at: null,
    skipped_at: null,
    ordered_at: null,
    recurring: false,
    position: 1,
    created_by: null,
    ...over,
  };
}

const SHAPE = /^(select:|order:|limit:|single$|maybeSingle$)/;

const escapeRegExp = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Postgres ILIKE: % is any run, _ is one character, a backslash escapes either.
function ilike(value: string, pattern: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) re += escapeRegExp(pattern[++i]);
    else if (c === "%") re += ".*";
    else if (c === "_") re += ".";
    else re += escapeRegExp(c);
  }
  return new RegExp(`^${re}$`, "is").test(value);
}

function matches(row: ItemRow, filter: string): boolean {
  const cell = (k: string) => (row as Record<string, unknown>)[k];
  let m: RegExpMatchArray | null;
  if ((m = filter.match(/^eq:([^=]+)=(.*)$/))) return String(cell(m[1])) === m[2];
  if ((m = filter.match(/^is:([^=]+)=null$/))) return cell(m[1]) == null;
  if ((m = filter.match(/^in:([^=]+)=(.*)$/))) return m[2].split(",").includes(String(cell(m[1])));
  if ((m = filter.match(/^not:([^:]+):is:null$/))) return cell(m[1]) != null;
  // Rows here carry no created_at, so the idempotency-key sweep (created_at older than 24 h) matches none.
  if ((m = filter.match(/^lt:([^=]+)=(.*)$/))) return cell(m[1]) != null && String(cell(m[1])) < m[2];
  if ((m = filter.match(/^ilike:([^=]+)=(.*)$/))) return ilike(String(cell(m[1])), m[2]);
  if (SHAPE.test(filter)) return true;
  // An unknown filter must fail the test loudly, never match everything by accident.
  throw new Error(`fake-items-table: unsupported filter ${filter}`);
}

function shape(call: FakeCall, rows: ItemRow[]): FakeResult {
  let out = rows.map((r) => ({ ...r }));
  const order = call.filters.find((f) => f.startsWith("order:"));
  if (order) {
    const [, col, asc] = order.split(":");
    const v = (r: ItemRow) => {
      const x = (r as Record<string, unknown>)[col];
      return typeof x === "number" ? x : x == null ? -Infinity : Date.parse(String(x));
    };
    out.sort((a, b) => (asc === "true" ? v(a) - v(b) : v(b) - v(a)));
  }
  const limit = call.filters.find((f) => f.startsWith("limit:"));
  if (limit) out = out.slice(0, Number(limit.slice("limit:".length)));
  if (call.filters.includes("maybeSingle")) return { data: out[0] ?? null, error: null };
  if (call.filters.includes("single")) {
    return out.length === 1
      ? { data: out[0], error: null }
      : { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
  }
  return { data: out, error: null };
}

export function fakeItemsTable(initial: ItemRow[]) {
  const rows = initial.map((r) => ({ ...r }));
  let created = 0;
  const fake = fakeSupabase((call: FakeCall): FakeResult => {
    if (call.op === "rpc" && call.table === "insert_item_if_under_limit") {
      const v = call.values as { p_list_id: string; p_text: string; p_position: number; p_created_by: string; p_idempotency_key?: string };
      const row = itemRow({ id: `new-${++created}`, list_id: v.p_list_id, text: v.p_text, position: v.p_position, created_by: v.p_created_by });
      if (v.p_idempotency_key !== undefined) row.idempotency_key = v.p_idempotency_key;
      rows.push(row);
      return { data: [{ ...row }], error: null };
    }
    if (call.table !== "items") return { data: null, error: null };
    const hit = rows.filter((r) => call.filters.every((f) => matches(r, f)));
    if (call.op === "select") return shape(call, hit);
    if (call.op === "update") {
      for (const r of hit) Object.assign(r, call.values as Partial<ItemRow>);
      return call.filters.some((f) => f.startsWith("select:")) ? shape(call, hit) : { data: null, error: null };
    }
    throw new Error(`fake-items-table: unsupported ${call.op} on items`);
  });
  return { client: fake.client, calls: fake.calls, rows };
}
