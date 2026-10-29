import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getSyncEngine,
  flushAllQueues,
  resetSyncEngines,
  type EngineHandlers,
  type ExecutorFactory,
  type MutationErrorInfo,
  type QueuedMutation,
  type SyncEngine,
} from "@/src/sync/engine";

// Runs the real engine over a fake localStorage and a fake executor factory. Each request
// the factory "sends" is logged as "<type> <target> <value>"; replies are set per line and
// consumed in order: "ok" (default), an HTTP status, "neterr" (offline) or "hold" (in
// flight until released). `server` keeps the last value each item got, as the items PATCH
// does (last write wins).
type Reply = "ok" | number | "neterr" | "hold";

const DAY = 24 * 60 * 60 * 1000;

function world(listId = "L") {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    get length() {
      return storage.size;
    },
    key: (i: number) => [...storage.keys()][i] ?? null,
  });
  vi.stubGlobal("navigator", { onLine: true });

  const sent: string[] = [];
  const server = new Map<string, unknown>();
  const replies = new Map<string, Reply[]>();
  const held = new Map<string, (r: Reply) => void>();
  const noRow = new Set<string>(); // temp ids whose create answers without an item
  const jwt = { current: "jwt" as string | null };

  const factory: ExecutorFactory = (m, getJwt) => {
    if (m.type === "bogus") return null;
    return async () => {
      const p = m.payload;
      const target =
        m.type === "create" ? p.tempId : m.type === "reorder" ? (p.orderedIds as string[]).join(",") : p.itemId;
      const line = `${m.type} ${String(target)}${"value" in p ? ` ${String(p.value)}` : ""}`;
      sent.push(line);
      expect(getJwt()).toBe(jwt.current);
      let reply = replies.get(line)?.shift() ?? "ok";
      if (reply === "hold") reply = await new Promise<Reply>((resolve) => held.set(line, resolve));
      if (reply === "neterr") throw new TypeError("Failed to fetch");
      if (typeof reply === "number") throw new Error(`Change failed: ${reply}`);
      if (m.type === "create") return noRow.has(p.tempId as string) ? {} : { id: `r-${p.tempId}` };
      if ("value" in p) server.set(String(p.itemId), p.value);
      return {};
    };
  };

  const errors: MutationErrorInfo[] = [];
  const successes: QueuedMutation[] = [];
  let authNeeded = 0;
  const handlers: EngineHandlers = {
    getJwt: () => jwt.current,
    executorFactory: factory,
    onError: (info) => errors.push(info),
    onSuccess: (m) => successes.push(m),
    onAuthNeeded: () => authNeeded++,
  };
  let engine: SyncEngine = getSyncEngine(listId);
  let detach = engine.attach(handlers);
  let n = 0;

  return {
    engine: () => engine,
    factory,
    sent,
    server,
    jwt,
    errors,
    successes,
    noRow,
    authNeeded: () => authNeeded,
    when: (line: string, ...r: Reply[]) => replies.set(line, r),
    release: (line: string, r: Reply = "ok") => held.get(line)!(r),
    add: (type: string, payload: Record<string, unknown>) => {
      const id = `m${++n}`;
      engine.add({ id, type, payload: { listId, ...payload } });
      return id;
    },
    stored: (id = listId) => JSON.parse(storage.get(`mutation_queue:${id}`) ?? "[]") as QueuedMutation[],
    seed: (id: string, entries: QueuedMutation[]) => storage.set(`mutation_queue:${id}`, JSON.stringify(entries)),
    detach: () => detach(),
    // The page opens the list again (same handlers).
    attach: () => {
      detach = engine.attach(handlers);
    },
    // A page reload: every engine is forgotten, storage stays, the page attaches again.
    reload: () => {
      resetSyncEngines();
      engine = getSyncEngine(listId);
      detach = engine.attach(handlers);
    },
  };
}

// Let queued promise chains run without moving the clock.
const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
};

// A token for this Telegram account, readable the way the client reads the app's JWT (unverified).
const jwtFor = (telegramUserId: number) =>
  `h.${btoa(JSON.stringify({ telegram_user_id: telegramUserId })).replace(/=+$/, "")}.sig`;

const entry = (id: string, type: string, payload: Record<string, unknown>, timestamp = Date.now()): QueuedMutation => ({
  id,
  type,
  payload: { listId: "L", ...payload },
  timestamp,
});

beforeEach(() => {
  resetSyncEngines();
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  resetSyncEngines();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("nothing is sent or thrown away without a token (H3)", () => {
  it("a flush with no token leaves every saved change in place and sends nothing", async () => {
    const w = world();
    w.seed("L", [entry("a", "toggle", { itemId: "i1", value: true }), entry("b", "edit", { itemId: "i2", value: "x" })]);
    w.jwt.current = null;
    w.reload();

    await w.engine().flush();
    await settle();

    expect(w.sent).toEqual([]);
    expect(w.stored().map((m) => m.id)).toEqual(["a", "b"]);
    expect(w.errors).toEqual([]);
  });

  it("a flush with no token touches nothing, not even a change past 24 hours", async () => {
    const w = world();
    w.jwt.current = null;
    w.add("toggle", { itemId: "i1", value: true });
    vi.setSystemTime(Date.now() + DAY + 1);

    await w.engine().flush();
    expect(w.stored()).toHaveLength(1);
    expect(w.errors).toEqual([]);

    w.jwt.current = "jwt";
    await w.engine().flush();
    expect(w.errors).toMatchObject([{ dropped: true, message: "Expired after 24 hours" }]);
  });

  it("a change made with no token is saved, not sent, and goes out on the flush after the token arrives", async () => {
    const w = world();
    w.jwt.current = null;
    w.add("toggle", { itemId: "i1", value: true });
    await settle();
    expect(w.sent).toEqual([]);
    expect(w.stored()).toHaveLength(1);

    w.jwt.current = "jwt";
    await w.engine().flush();

    expect(w.sent).toEqual(["toggle i1 true"]);
    expect(w.stored()).toEqual([]);
  });

  it("a 401 keeps the change, asks once for a reconnect, and holds later changes until the next flush", async () => {
    const w = world();
    w.when("toggle i1 true", 401);
    w.add("toggle", { itemId: "i1", value: true });
    await settle();
    w.add("toggle", { itemId: "i3", value: true });
    await settle();

    expect(w.sent).toEqual(["toggle i1 true"]);
    expect(w.authNeeded()).toBe(1);
    expect(w.errors).toMatchObject([{ httpStatus: 401, dropped: false }]);
    expect(w.stored()).toHaveLength(2);

    await w.engine().flush();

    expect(w.sent).toEqual(["toggle i1 true", "toggle i1 true", "toggle i3 true"]);
    expect(w.stored()).toEqual([]);
  });

  it("a 401 is also retried on the backoff timer, so sync resumes without waiting for a flush", async () => {
    const w = world();
    w.when("toggle i1 true", 401);
    w.add("toggle", { itemId: "i1", value: true });
    await settle();
    expect(w.sent).toEqual(["toggle i1 true"]);

    await vi.advanceTimersByTimeAsync(2000);
    await settle();

    expect(w.sent).toEqual(["toggle i1 true", "toggle i1 true"]);
    expect(w.stored()).toEqual([]);
  });

  it("drops a change whose type has no executor, and reports it", async () => {
    const w = world();
    w.add("bogus", { itemId: "i1" });
    await settle();

    expect(w.stored()).toEqual([]);
    expect(w.errors).toMatchObject([{ type: "bogus", dropped: true, httpStatus: null }]);
  });

  it("drops a change the server refuses with a 4xx, and reports it", async () => {
    const w = world();
    w.when("toggle i1 true", 404);
    w.add("toggle", { itemId: "i1", value: true });
    await settle();

    expect(w.stored()).toEqual([]);
    expect(w.errors).toMatchObject([{ type: "toggle", httpStatus: 404, dropped: true }]);
  });
});

describe("one item's changes land in the order they were made (H4)", () => {
  it("a tick that failed stays ahead of the untick made after it", async () => {
    const w = world();
    w.when("toggle i1 true", 500);
    w.add("toggle", { itemId: "i1", value: true });
    await settle();
    w.add("toggle", { itemId: "i1", value: false });
    await settle();
    expect(w.sent).toEqual(["toggle i1 true"]);

    await w.engine().flush();

    expect(w.sent).toEqual(["toggle i1 true", "toggle i1 true", "toggle i1 false"]);
    expect(w.server.get("i1")).toBe(false);
    expect(w.stored()).toEqual([]);
  });

  it("a change waits while the previous one for that item is in flight", async () => {
    const w = world();
    w.when("toggle i1 true", "hold");
    w.add("toggle", { itemId: "i1", value: true });
    w.add("toggle", { itemId: "i1", value: false });
    await settle();
    expect(w.sent).toEqual(["toggle i1 true"]);

    w.release("toggle i1 true");
    await settle();

    expect(w.sent).toEqual(["toggle i1 true", "toggle i1 false"]);
    expect(w.server.get("i1")).toBe(false);
  });

  it("a flush while a change is in flight does not send it twice", async () => {
    const w = world();
    w.when("toggle i1 true", "hold");
    w.add("toggle", { itemId: "i1", value: true });
    await settle();
    void w.engine().flush();
    await settle();
    expect(w.sent).toEqual(["toggle i1 true"]);

    w.release("toggle i1 true");
    await settle();
    expect(w.sent).toEqual(["toggle i1 true"]);
    expect(w.stored()).toEqual([]);
  });

  it("a flush resolves once what it sent has landed", async () => {
    const w = world();
    w.when("toggle i1 true", "hold");
    w.jwt.current = null;
    w.add("toggle", { itemId: "i1", value: true });
    w.jwt.current = "jwt";
    let done = false;
    void w.engine().flush().then(() => (done = true));
    await settle();
    expect(done).toBe(false);

    w.release("toggle i1 true");
    await settle();
    expect(done).toBe(true);
  });

  it("a flush is not held by changes made while it runs", async () => {
    const w = world();
    w.when("toggle i1 true", "hold");
    w.when("toggle i2 true", "hold");
    w.jwt.current = null;
    w.add("toggle", { itemId: "i1", value: true });
    w.jwt.current = "jwt";
    let done = false;
    void w.engine().flush().then(() => (done = true));
    await settle();

    w.add("toggle", { itemId: "i2", value: true }); // the user keeps tapping
    await settle();
    expect(done).toBe(false);
    w.release("toggle i1 true");
    await settle();

    expect(w.sent).toEqual(["toggle i1 true", "toggle i2 true"]);
    expect(done).toBe(true);
    w.release("toggle i2 true");
    await settle();
  });

  it("a flush started while an earlier request hangs still resolves, and the reconnect can go on", async () => {
    const w = world();
    w.when("toggle i1 true", "hold"); // sent before the network dropped; never answers
    w.when("toggle i2 true", 500);
    w.add("toggle", { itemId: "i1", value: true });
    w.add("toggle", { itemId: "i2", value: true });
    await settle();
    expect(w.sent).toEqual(["toggle i1 true", "toggle i2 true"]);

    // The reconnect awaits the flush before it rejoins realtime and refreshes.
    let reconnected = false;
    void w.engine().flush().then(() => (reconnected = true));
    await settle();

    expect(w.sent).toEqual(["toggle i1 true", "toggle i2 true", "toggle i2 true"]);
    expect(reconnected).toBe(true);
    expect(w.engine().pendingFields("i1")).toEqual(new Set(["completed", "completed_at"]));

    w.release("toggle i1 true");
    await settle();
    expect(w.stored()).toEqual([]);
  });

  it("a flush resolves when a change it sent fails again, without waiting for the change held behind it", async () => {
    const w = world();
    w.when("toggle i1 true", 500, 500);
    w.add("toggle", { itemId: "i1", value: true });
    await settle();
    w.add("toggle", { itemId: "i1", value: false });

    await w.engine().flush();

    expect(w.sent).toEqual(["toggle i1 true", "toggle i1 true"]);
    expect(w.stored()).toHaveLength(2);
  });

  it("changes to different items do not wait for each other", async () => {
    const w = world();
    w.when("toggle i1 true", "hold");
    w.add("toggle", { itemId: "i1", value: true });
    w.add("toggle", { itemId: "i2", value: true });
    await settle();

    expect(w.sent).toEqual(["toggle i1 true", "toggle i2 true"]);
  });

  it("a reorder waits for every earlier change and holds every later one", async () => {
    const w = world();
    w.when("toggle i1 true", "hold");
    w.add("toggle", { itemId: "i1", value: true });
    w.add("reorder", { orderedIds: ["i1", "i2"] });
    w.add("toggle", { itemId: "i2", value: true });
    await settle();
    expect(w.sent).toEqual(["toggle i1 true"]);

    w.release("toggle i1 true");
    await settle();

    expect(w.sent).toEqual(["toggle i1 true", "reorder i1,i2", "toggle i2 true"]);
  });

  it("a failed change keeps its place after a reload", async () => {
    const w = world();
    w.when("toggle i1 true", 500);
    w.add("toggle", { itemId: "i1", value: true });
    await settle();
    w.add("toggle", { itemId: "i1", value: false });
    await settle();

    w.reload();
    await w.engine().flush();

    expect(w.sent).toEqual(["toggle i1 true", "toggle i1 true", "toggle i1 false"]);
    expect(w.server.get("i1")).toBe(false);
  });

  it("retries a change kept after a server error, with growing delays", async () => {
    const w = world();
    w.when("toggle i1 true", 500, 503);
    w.add("toggle", { itemId: "i1", value: true });
    await settle();
    expect(w.sent).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(w.sent).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(3999);
    await settle();
    expect(w.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(w.sent).toHaveLength(3);
    expect(w.stored()).toEqual([]);
  });

  it("does not retry on a timer while the device reports it is offline", async () => {
    const w = world();
    vi.stubGlobal("navigator", { onLine: false });
    w.when("toggle i1 true", "neterr");
    w.add("toggle", { itemId: "i1", value: true });
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);
    await settle();

    expect(w.sent).toEqual(["toggle i1 true"]);
    expect(w.stored()).toHaveLength(1);
  });
});

describe("the first load's strict flush waits for every saved change, in flight or not (R3)", () => {
  // The provider's replay after auth starts first: the tick is in flight, the edit waits behind it.
  const replayStarted = async (w: ReturnType<typeof world>) => {
    w.seed("L", [entry("a", "toggle", { itemId: "i1", value: true }), entry("b", "edit", { itemId: "i1", value: "x" })]);
    w.reload();
    void flushAllQueues(() => "jwt", w.factory);
    await settle();
    expect(w.sent).toEqual(["toggle i1 true"]);
  };

  it("resolves only once the change in flight and the one queued behind it have both landed", async () => {
    const w = world();
    w.when("toggle i1 true", "hold");
    w.when("edit i1 x", "hold");
    await replayStarted(w);

    let done = false;
    void w.engine().flush({ includeInFlight: true }).then(() => (done = true));
    await settle();
    expect(done).toBe(false);

    w.release("toggle i1 true");
    await settle();
    expect(w.sent).toEqual(["toggle i1 true", "edit i1 x"]);
    expect(done).toBe(false);

    w.release("edit i1 x");
    await settle();
    expect(done).toBe(true);
    expect(w.stored()).toEqual([]);
  });

  it("the plain flush still resolves at once, so a hung request never holds a reconnect", async () => {
    const w = world();
    w.when("toggle i1 true", "hold");
    await replayStarted(w);

    let done = false;
    void w.engine().flush().then(() => (done = true));
    await settle();

    expect(done).toBe(true);
    expect(w.sent).toEqual(["toggle i1 true"]);
    w.release("toggle i1 true");
    await settle();
  });

  it("is not held by a change kept for a retry, nor by the change waiting behind it", async () => {
    const w = world();
    w.when("toggle i1 true", "hold");
    await replayStarted(w);

    let done = false;
    void w.engine().flush({ includeInFlight: true }).then(() => (done = true));
    await settle();
    w.release("toggle i1 true", 500);
    await settle();

    expect(done).toBe(true);
    expect(w.sent).toEqual(["toggle i1 true"]);
    expect(w.stored().map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("is not held after a 401, which holds everything until the next flush", async () => {
    const w = world();
    w.when("toggle i1 true", "hold");
    await replayStarted(w);

    let done = false;
    void w.engine().flush({ includeInFlight: true }).then(() => (done = true));
    await settle();
    w.release("toggle i1 true", 401);
    await settle();

    expect(done).toBe(true);
    expect(w.stored().map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("a change it waits for that the server refuses does not hold it", async () => {
    const w = world();
    w.when("toggle i1 true", "hold");
    await replayStarted(w);

    let done = false;
    void w.engine().flush({ includeInFlight: true }).then(() => (done = true));
    await settle();
    w.release("toggle i1 true", 404);
    await settle();
    expect(w.sent).toEqual(["toggle i1 true", "edit i1 x"]);

    expect(done).toBe(true);
    expect(w.stored()).toEqual([]);
  });
});

describe("changes on a just-added item wait for its create (H5)", () => {
  it("a tick on a temp item is sent with the real id once the create returns", async () => {
    const w = world();
    w.when("create temp-1", "hold");
    w.add("create", { tempId: "temp-1", text: "milk" });
    w.add("toggle", { itemId: "temp-1", value: true });
    await settle();
    expect(w.sent).toEqual(["create temp-1"]);

    w.release("create temp-1");
    await settle();

    expect(w.sent).toEqual(["create temp-1", "toggle r-temp-1 true"]);
    expect(w.engine().resolveId("temp-1")).toBe("r-temp-1");
    expect(w.successes.map((m) => m.payload.itemId)).toEqual([undefined, "r-temp-1"]);
    expect(w.errors).toEqual([]);
  });

  it("a change made with the real id still waits behind the temp item's chain", async () => {
    const w = world();
    w.when("toggle r-temp-1 true", "hold");
    w.add("create", { tempId: "temp-1", text: "milk" });
    w.add("toggle", { itemId: "temp-1", value: true });
    await settle();
    expect(w.sent).toEqual(["create temp-1", "toggle r-temp-1 true"]);

    w.add("edit", { itemId: "r-temp-1", value: "oat milk" });
    w.add("toggle", { itemId: "temp-1", value: false }); // a handler still holding the temp id
    await settle();
    expect(w.sent).toEqual(["create temp-1", "toggle r-temp-1 true"]);
    expect(w.stored().map((m) => m.payload.itemId)).toEqual(["r-temp-1", "r-temp-1", "r-temp-1"]);

    w.release("toggle r-temp-1 true");
    await settle();
    expect(w.sent).toEqual(["create temp-1", "toggle r-temp-1 true", "edit r-temp-1 oat milk", "toggle r-temp-1 false"]);
  });

  it("a change that failed after its create landed is stored with the real id, so a reload sends it right", async () => {
    const w = world();
    w.when("toggle r-temp-1 true", 503);
    w.add("create", { tempId: "temp-1", text: "milk" });
    w.add("toggle", { itemId: "temp-1", value: true });
    await settle();
    expect(w.stored().map((m) => m.payload.itemId)).toEqual(["r-temp-1"]);

    w.reload();
    await w.engine().flush();

    expect(w.sent).toEqual(["create temp-1", "toggle r-temp-1 true", "toggle r-temp-1 true"]);
    expect(w.engine().resolveId("temp-1")).toBe("r-temp-1");
    expect(w.errors.filter((e) => e.dropped)).toEqual([]);
  });

  it("a reload before the create returns replays the create, then its changes with the real id", async () => {
    const w = world();
    w.when("create temp-1", "neterr");
    w.add("create", { tempId: "temp-1", text: "milk" });
    w.add("toggle", { itemId: "temp-1", value: true });
    await settle();
    expect(w.stored().map((m) => m.type)).toEqual(["create", "toggle"]);

    w.reload();
    await w.engine().flush();

    expect(w.sent).toEqual(["create temp-1", "create temp-1", "toggle r-temp-1 true"]);
    expect(w.stored()).toEqual([]);
  });

  it("a drag made while an item was pending sends the item's real id", async () => {
    const w = world();
    w.when("create temp-1", "hold");
    w.add("create", { tempId: "temp-1", text: "milk" });
    w.add("reorder", { orderedIds: ["temp-1", "i2"] });
    await settle();
    w.release("create temp-1");
    await settle();

    expect(w.sent).toEqual(["create temp-1", "reorder r-temp-1,i2"]);
  });

  it("drops and reports a change for a temp item that was never created, without a request", async () => {
    const w = world();
    w.seed("L", [entry("old", "toggle", { itemId: "temp-9", value: true })]);
    w.reload();
    await w.engine().flush();

    expect(w.sent).toEqual([]);
    expect(w.stored()).toEqual([]);
    expect(w.errors).toMatchObject([{ mutationId: "old", type: "toggle", dropped: true }]);
  });

  it("when a create is refused, the changes waiting on it are dropped and reported, not sent", async () => {
    const w = world();
    w.when("create temp-1", 400);
    w.add("create", { tempId: "temp-1", text: "milk" });
    w.add("toggle", { itemId: "temp-1", value: true });
    await settle();

    expect(w.sent).toEqual(["create temp-1"]);
    expect(w.stored()).toEqual([]);
    expect(w.errors.map((e) => [e.type, e.dropped])).toEqual([["create", true], ["toggle", true]]);
  });

  it("drops and reports a create that was answered without an item", async () => {
    const w = world();
    w.noRow.add("temp-1");
    w.add("create", { tempId: "temp-1", text: "milk" });
    await settle();

    expect(w.stored()).toEqual([]);
    expect(w.successes).toEqual([]);
    expect(w.errors).toMatchObject([{ type: "create", dropped: true }]);
  });

  it("pendingFields covers queued and in-flight changes, under the temp and the real id", async () => {
    const w = world();
    w.when("create temp-1", "hold");
    w.when("toggle r-temp-1 true", "hold");
    w.add("create", { tempId: "temp-1", text: "milk" });
    w.add("toggle", { itemId: "temp-1", value: true });
    w.add("edit", { itemId: "temp-1", value: "oat milk" });
    w.add("reorder", { orderedIds: ["i2", "temp-1"] });
    await settle();
    expect(w.engine().pendingFields("temp-1")).toEqual(new Set(["created", "completed", "completed_at", "text", "position"]));
    expect(w.engine().pendingFields("i2")).toEqual(new Set(["position"]));

    w.release("create temp-1");
    await settle();
    expect(w.engine().pendingFields("r-temp-1")).toEqual(new Set(["completed", "completed_at", "text", "position"]));
    expect(w.engine().pendingFields("temp-1")).toEqual(new Set(["completed", "completed_at", "text", "position"]));

    w.release("toggle r-temp-1 true");
    await settle();
    expect(w.engine().pendingFields("r-temp-1")).toEqual(new Set());
  });
});

describe("pendingFields", () => {
  it("covers every field an order, a restore-recurring and a Restore all change", async () => {
    const w = world();
    w.jwt.current = null;
    w.add("order", { itemId: "i1", ordered: true });
    w.add("restore-recurring", { itemId: "i2" });
    w.add("unskip-all", { itemIds: ["i3", "i4"] });

    expect(w.engine().pendingFields("i1")).toEqual(new Set(["ordered_at", "skipped_at"]));
    expect(w.engine().pendingFields("i2")).toEqual(
      new Set(["recurring", "completed", "completed_at", "skipped_at", "ordered_at", "position"])
    );
    expect(w.engine().pendingFields("i4")).toEqual(new Set(["skipped_at"]));
  });

  it("answers from memory, without reading storage on each call", async () => {
    const w = world();
    w.seed("L", [entry("a", "toggle", { itemId: "i1", value: true })]);
    w.jwt.current = null;
    w.reload();
    w.add("edit", { itemId: "i1", value: "x" });
    const reads = vi.spyOn(localStorage, "getItem");

    for (let i = 0; i < 50; i++) w.engine().pendingFields("i1");

    expect(reads).not.toHaveBeenCalled();
    expect(w.engine().pendingFields("i1")).toEqual(new Set(["completed", "completed_at", "text"]));
  });

  it("a snapshot keeps the fields of changes that landed after it, matched under the item's saved id", async () => {
    const w = world();
    w.when("create temp-1", "hold");
    w.add("create", { tempId: "temp-1", text: "milk" });
    w.add("toggle", { itemId: "temp-1", value: true });
    await settle();
    const snapshot = w.engine().pendingSnapshot();

    w.release("create temp-1");
    await settle();

    expect(w.engine().pendingFields("r-temp-1")).toEqual(new Set());
    expect(w.engine().pendingFieldsOf(snapshot, "r-temp-1")).toEqual(new Set(["created", "completed", "completed_at"]));
  });

  it("pendingCreateFor names the oldest create of that text still on its way, in flight or kept for a retry", async () => {
    const w = world();
    w.when("create temp-1", "hold");
    w.when("create temp-2", 500); // kept for a retry: queued, not in flight
    w.add("create", { tempId: "temp-1", text: "milk" });
    w.add("create", { tempId: "temp-2", text: "milk" });
    w.add("create", { tempId: "temp-3", text: "eggs" });
    await settle();

    expect(w.engine().pendingCreateFor("milk")).toBe("temp-1");
    expect(w.engine().pendingCreateFor("eggs")).toBeUndefined(); // already saved
    expect(w.engine().pendingCreateFor("bread")).toBeUndefined();

    w.release("create temp-1");
    await settle();
    expect(w.engine().pendingCreateFor("milk")).toBe("temp-2");
  });

  it("no longer lists a change by the time its page hears it landed", async () => {
    const w = world();
    const seen: Set<string>[] = [];
    w.engine().attach({
      getJwt: () => "jwt",
      executorFactory: w.factory,
      onSuccess: (m) => seen.push(w.engine().pendingFields(String(m.payload.itemId))),
    });
    w.add("toggle", { itemId: "i1", value: true });
    await settle();

    expect(seen).toEqual([new Set()]);
  });
});

describe("a full queue or an old change is reported, never silent (H15)", () => {
  it("past 500 queued changes the oldest is evicted and reported", async () => {
    const w = world();
    w.jwt.current = null;
    for (let i = 0; i <= 500; i++) w.add("toggle", { itemId: `i${i}`, value: true });

    expect(w.stored()).toHaveLength(500);
    expect(w.stored()[0].payload.itemId).toBe("i1");
    expect(w.errors).toMatchObject([{ mutationId: "m1", dropped: true }]);
    expect(w.engine().pendingFields("i0")).toEqual(new Set());
  });

  it("a change older than 24 hours is dropped and reported on the next flush", async () => {
    const w = world();
    w.jwt.current = null;
    w.add("toggle", { itemId: "i1", value: true });
    vi.setSystemTime(Date.now() + DAY + 1);
    w.jwt.current = "jwt";

    await w.engine().flush();

    expect(w.sent).toEqual([]);
    expect(w.stored()).toEqual([]);
    expect(w.errors).toMatchObject([{ type: "toggle", dropped: true, message: "Expired after 24 hours" }]);
  });

  it("flushAllQueues sends the saved changes of a list no page has open", async () => {
    const w = world();
    w.seed("other", [{ ...entry("o", "toggle", { itemId: "o1", value: true }), payload: { listId: "other", itemId: "o1", value: true } }]);
    resetSyncEngines();

    await flushAllQueues(() => "jwt", w.factory);

    expect(w.sent).toEqual(["toggle o1 true"]);
    expect(w.stored("other")).toEqual([]);
  });

  it("flushAllQueues sends nothing without a token", async () => {
    const w = world();
    w.seed("other", [entry("o", "toggle", { itemId: "o1", value: true })]);
    resetSyncEngines();

    await flushAllQueues(() => null, w.factory);

    expect(w.sent).toEqual([]);
    expect(w.stored("other")).toHaveLength(1);
  });

  it("a change dropped while no page is open is reported when the list opens again", async () => {
    const w = world();
    w.jwt.current = null;
    w.add("toggle", { itemId: "i1", value: true });
    w.detach();
    vi.setSystemTime(Date.now() + DAY + 1);

    await flushAllQueues(() => "jwt", w.factory);
    expect(w.stored()).toEqual([]);
    expect(w.errors).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
      "[SyncEngine] Dropping a change older than 24 hours:",
      { listId: "L", mutationId: "m1", type: "toggle" }
    );

    w.attach();
    expect(w.errors).toMatchObject([{ mutationId: "m1", dropped: true, message: "Expired after 24 hours" }]);

    w.detach();
    w.attach();
    expect(w.errors).toHaveLength(1);
  });

  it("a list keeps retrying after its page closes, without calling the closed page", async () => {
    const w = world();
    w.when("toggle i1 true", 500);
    w.add("toggle", { itemId: "i1", value: true });
    await settle();
    w.detach();

    await vi.advanceTimersByTimeAsync(2000);
    await settle();

    expect(w.sent).toEqual(["toggle i1 true", "toggle i1 true"]);
    expect(w.stored()).toEqual([]);
    expect(w.successes).toEqual([]);
  });
});

describe("saved changes belong to the account that made them (C2)", () => {
  it("a change saved by one account is not sent with another's token, stays saved, and goes out once its account is back", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const w = world();
    w.jwt.current = jwtFor(1);
    w.when("toggle i1 true", "neterr");
    w.add("toggle", { itemId: "i1", value: true });
    await settle();
    expect(w.sent).toEqual(["toggle i1 true"]);

    // User 1 signs out offline; user 2 signs in on the same device.
    w.jwt.current = jwtFor(2);
    w.reload();
    w.add("toggle", { itemId: "i2", value: true });
    await flushAllQueues(() => w.jwt.current, w.factory);
    await w.engine().flush({ includeInFlight: true });

    expect(w.sent).toEqual(["toggle i1 true", "toggle i2 true"]);
    expect(w.stored().map((m) => m.payload.itemId)).toEqual(["i1"]);
    expect(w.errors.filter((e) => e.dropped)).toEqual([]);
    expect(w.engine().pendingFields("i1")).toEqual(new Set());
    expect(info).toHaveBeenCalledWith(expect.stringContaining("[SyncEngine]"), { listId: "L", count: 1 });

    w.jwt.current = jwtFor(1);
    await w.engine().flush();

    expect(w.sent).toEqual(["toggle i1 true", "toggle i2 true", "toggle i1 true"]);
    expect(w.stored()).toEqual([]);
  });

  it("a change saved without an account (before owners existed, or with no token) is sent by whoever replays it", async () => {
    const w = world();
    w.seed("L", [entry("old", "toggle", { itemId: "i1", value: true })]);
    w.jwt.current = jwtFor(2);
    w.reload();

    await flushAllQueues(() => w.jwt.current, w.factory);

    expect(w.sent).toEqual(["toggle i1 true"]);
    expect(w.stored()).toEqual([]);
  });

  it("another account's change past 24 hours is left for that account, not dropped or reported here", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const w = world();
    w.seed("L", [{ ...entry("theirs", "toggle", { itemId: "i1", value: true }, Date.now() - DAY - 1), owner: 1 }]);
    w.jwt.current = jwtFor(2);
    w.reload();

    await w.engine().flush();

    expect(w.stored().map((m) => m.id)).toEqual(["theirs"]);
    expect(w.errors).toEqual([]);
  });

  it("another account's change on an item does not hold this account's change on it", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const w = world();
    w.seed("L", [{ ...entry("theirs", "toggle", { itemId: "i1", value: true }), owner: 1 }]);
    w.jwt.current = jwtFor(2);
    w.reload();
    w.add("edit", { itemId: "i1", value: "x" });
    await w.engine().flush();

    expect(w.sent).toEqual(["edit i1 x"]);
    expect(w.stored().map((m) => m.id)).toEqual(["theirs"]);
  });
});

describe("storage that can't be written or read back cleanly", () => {
  it("a change is still sent online when the device can't save it, and leaves pendingFields once it lands", async () => {
    const w = world();
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    w.add("toggle", { itemId: "i1", value: true });
    await settle();
    expect(w.sent).toEqual(["toggle i1 true"]);
    expect(w.engine().pendingFields("i1")).toEqual(new Set());
    expect(w.errors).toEqual([]);
  });

  it("a change the device couldn't save is still retried after a server error", async () => {
    const w = world();
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    w.when("toggle i1 true", 500);
    w.add("toggle", { itemId: "i1", value: true });
    await settle();

    await w.engine().flush();

    expect(w.sent).toEqual(["toggle i1 true", "toggle i1 true"]);
    expect(w.engine().pendingFields("i1")).toEqual(new Set());
  });

  it("a change the device couldn't save still expires after 24 hours, with a report", async () => {
    const w = world();
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    w.jwt.current = null;
    w.add("toggle", { itemId: "i1", value: true });
    vi.setSystemTime(Date.now() + DAY + 1);
    w.jwt.current = "jwt";

    await w.engine().flush();

    expect(w.sent).toEqual([]);
    expect(w.errors).toMatchObject([{ type: "toggle", dropped: true, message: "Expired after 24 hours" }]);
    expect(w.engine().pendingFields("i1")).toEqual(new Set());
  });

  it("a saved entry it can't read is dropped and reported, and the valid one next to it is still sent", async () => {
    const w = world();
    w.seed("L", [
      { id: "bad", type: "toggle", payload: null, timestamp: Date.now() } as unknown as QueuedMutation,
      "junk" as unknown as QueuedMutation,
      entry("a", "toggle", { itemId: "i1", value: true }),
    ]);
    w.reload();

    w.add("edit", { itemId: "i2", value: "x" }); // a tap after the page opens must not throw
    await w.engine().flush();

    expect(w.sent).toEqual(["toggle i1 true", "edit i2 x"]);
    expect(w.stored()).toEqual([]);
    expect(w.errors).toMatchObject([
      { mutationId: "bad", type: "toggle", dropped: true, payload: {} },
      { mutationId: "unknown", type: "unknown", dropped: true, payload: {} },
    ]);
  });

  it("a saved queue that isn't a list is dropped and reported, and new changes still go out", async () => {
    const w = world();
    localStorage.setItem("mutation_queue:L", JSON.stringify({ not: "a list" }));
    w.reload();

    w.add("toggle", { itemId: "i1", value: true });
    await settle();

    expect(w.sent).toEqual(["toggle i1 true"]);
    expect(w.errors).toMatchObject([{ mutationId: "unknown", dropped: true }]);
  });
});

describe("page callbacks", () => {
  it("hands the server's row of a create to onSuccess", async () => {
    const w = world();
    w.add("create", { tempId: "temp-1", text: "milk" });
    await settle();

    expect(w.successes.map((m) => m.payload.tempId)).toEqual(["temp-1"]);
  });

  it("a callback that throws is logged and never stops the item's next change", async () => {
    const w = world();
    const engine = w.engine();
    engine.attach({ getJwt: () => "jwt", executorFactory: w.factory, onSuccess: () => { throw new Error("page bug"); } });
    w.add("toggle", { itemId: "i1", value: true });
    w.add("toggle", { itemId: "i1", value: false });
    await settle();

    expect(w.sent).toEqual(["toggle i1 true", "toggle i1 false"]);
    expect(console.error).toHaveBeenCalledWith("[SyncEngine] The onSuccess handler failed:", { listId: "L" }, expect.any(Error));
  });
});
