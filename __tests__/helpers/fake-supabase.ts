// Stand-in for the PostgREST builder used by route and service tests. Every chain is
// recorded as one call; `resolve` decides what it returns when awaited.
export type FakeCall = {
  table: string;
  op: "select" | "insert" | "update" | "delete" | "rpc";
  values?: unknown;
  cols?: string;
  filters: string[];
};
export type FakeResult = { data: unknown; error: unknown };

export function fakeSupabase(resolve: (call: FakeCall) => FakeResult) {
  const calls: FakeCall[] = [];
  const chain = (call: FakeCall) => {
    calls.push(call);
    const c: Record<string, unknown> = {};
    const add = (f: string) => { call.filters.push(f); return c; };
    c.eq = (k: string, v: unknown) => add(`eq:${k}=${v}`);
    c.neq = (k: string, v: unknown) => add(`neq:${k}=${v}`);
    c.is = (k: string, v: unknown) => add(`is:${k}=${v}`);
    c.in = (k: string, v: unknown[]) => add(`in:${k}=${v.join(",")}`);
    c.not = (k: string, o: string, v: unknown) => add(`not:${k}:${o}:${v}`);
    c.lt = (k: string, v: unknown) => add(`lt:${k}=${v}`);
    c.gt = (k: string, v: unknown) => add(`gt:${k}=${v}`);
    c.order = (k: string, o?: { ascending?: boolean }) => add(`order:${k}:${o?.ascending ?? true}`);
    c.limit = (n: number) => add(`limit:${n}`);
    c.select = (cols?: string) => { if (cols) call.cols = call.cols ?? cols; return add(`select:${cols ?? "*"}`); };
    c.single = () => add("single");
    c.maybeSingle = () => add("maybeSingle");
    c.then = (ok: (r: FakeResult) => unknown, err?: (e: unknown) => unknown) =>
      Promise.resolve().then(() => resolve(call)).then(ok, err);
    return c;
  };
  const client = {
    from: (table: string) => ({
      select: (cols?: string) => chain({ table, op: "select", cols, filters: [] }),
      insert: (values: unknown) => chain({ table, op: "insert", values, filters: [] }),
      update: (values: unknown) => chain({ table, op: "update", values, filters: [] }),
      delete: () => chain({ table, op: "delete", filters: [] }),
    }),
    rpc: (name: string, args: unknown) => chain({ table: name, op: "rpc", values: args, filters: [] }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, calls };
}
