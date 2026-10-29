/**
 * The sync engine: the one path every change the user makes takes to the server, online
 * and on replay. One engine per list id lives at module level, shared by every hook
 * instance and the provider, so a remount or a second hook never sends a change twice.
 *
 * - Changes are persisted first (`mutation_queue:<listId>`), then sent by executor-factory.
 * - Changes to one item run strictly in order (its chain); "reorder" and "unskip-all" are
 *   list-wide barriers that wait for every earlier change and hold every later one.
 * - A change on a `temp-` item waits behind that item's create. When the create returns,
 *   the temp → real id pair is saved (`sync_temp_ids:<listId>`) and stored payloads are
 *   rewritten, so later changes made with either id stay in the same chain.
 * - Nothing is sent without a JWT. A 401 keeps the change, asks for a reconnect and also
 *   retries with backoff; a network failure, 5xx, 408 or 429 keeps it for a retry with
 *   backoff; any other 4xx drops it. Every drop (refused, unknown type, orphaned temp id,
 *   queue cap, 24 h expiry) is reported through onError with `dropped: true`; one made
 *   while no page is open is reported to the next page that attaches.
 * - What to send comes from memory, so a change still goes out online when the device can't
 *   save it (storage full or disabled); storage is the copy that survives a reload.
 * - A saved entry it can't read is dropped and reported, never thrown at a tap.
 * - flush() resolves once every change it could send when it started has settled once. A
 *   request already in flight then (perhaps hanging on a dead socket) doesn't hold it, nor
 *   do changes added while it runs, so a reconnect that awaits it always goes on.
 *   flush({ includeInFlight: true }), for the list's first load only, also waits for the
 *   changes already in flight and those queued behind them, until each has landed, been
 *   dropped or been kept for a later flush.
 */
import { MutationQueue, type QueuedMutation } from "@/src/utils/mutation-queue";

export type { QueuedMutation } from "@/src/utils/mutation-queue";

/** Resolves with the server row ({ id, ... }) for "create" and "recycle"; throws Error("<Verb> failed: <status>") on a non-ok answer. */
export type Executor = () => Promise<unknown>;
/** null = unknown type. */
export type ExecutorFactory = (m: QueuedMutation, getJwt: () => string) => Executor | null;

export type MutationErrorInfo = {
  mutationId: string;
  type: string;
  httpStatus: number | null;
  message: string;
  dropped: boolean; // true if dequeued (non-retriable), false if kept for retry
  payload: Record<string, unknown>;
};

export type EngineHandlers = {
  getJwt: () => string | null;
  executorFactory: ExecutorFactory;
  onError?: (info: MutationErrorInfo) => void;
  onSuccess?: (m: QueuedMutation, result: unknown) => void;
  onAuthNeeded?: () => void; // a 401: entry kept, provider should reconnect
};

export interface SyncEngine {
  /** The open list page; returns detach. Without an attached page the engine runs with the handlers flushAllQueues passed. */
  attach(handlers: EngineHandlers): () => void;
  /** Persists, then runs in its chain. */
  add(m: { id: string; type: string; payload: Record<string, unknown> }): void;
  /**
   * Runs every queued entry not in flight, in chain order; resolves once those have settled
   * once. With includeInFlight it waits for every entry queued or in flight at its start,
   * until each has landed, been dropped or can't run before the next flush (kept for a retry,
   * held by a 401, or waiting behind one of those). No-op while getJwt() is null.
   */
  flush(opts?: { includeInFlight?: boolean }): Promise<void>;
  /** Fields touched by queued or in-flight entries for that item (after temp → real aliasing). */
  pendingFields(itemId: string): Set<string>;
  /** The entries queued or in flight now: a refresh takes it when its GET leaves. */
  pendingSnapshot(): QueuedMutation[];
  /** Fields those entries touch for that item, matched by real id at the time of the call. */
  pendingFieldsOf(entries: QueuedMutation[], itemId: string): Set<string>;
  /** The real id for a resolved temp id, else the id itself. */
  resolveId(id: string): string;
}

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// A saved temp → real pair is only needed while a change made before the create returned
// can still be queued, which is at most MAX_AGE_MS.
const TEMP_ID_MAX_AGE_MS = 2 * MAX_AGE_MS;
// Requests one list sends at once. Each chain still sends one at a time.
const MAX_IN_FLIGHT = 6;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60 * 1000;
const QUEUE_PREFIX = "mutation_queue:";
const TEMP_IDS_PREFIX = "sync_temp_ids:";
const BARRIER_TYPES = new Set(["reorder", "unskip-all"]);

// Item fields each change type touches (spec §4); "deleted" and "created" stand for presence.
const FIELDS: Record<string, string[]> = {
  toggle: ["completed", "completed_at"],
  edit: ["text"],
  skip: ["skipped_at"],
  // "On the way" also clears a skip.
  order: ["ordered_at", "skipped_at"],
  "set-category": ["category_id", "category_locked"],
  "set-recurring": ["recurring"],
  // Restoring a recurring item also unticks it, clears skip / on the way and moves it.
  "restore-recurring": ["recurring", "completed", "completed_at", "skipped_at", "ordered_at", "position"],
  delete: ["deleted"],
  restore: ["deleted"],
};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const isTempId = (id: string) => id.startsWith("temp-");
const reportedOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/** The item a change is about: its itemId, the tempId of a create, the recycled item of a recycle. */
function itemOf(m: QueuedMutation): string | undefined {
  if (m.type === "create") return str(m.payload.tempId);
  if (m.type === "recycle") return str(m.payload.recycleId);
  return str(m.payload.itemId);
}

/** [item id, fields] pairs a change touches. */
function touched(m: QueuedMutation): [string, string[]][] {
  if (m.type === "reorder") return strings(m.payload.orderedIds).map((id) => [id, ["position"]]);
  if (m.type === "unskip-all") return strings(m.payload.itemIds).map((id) => [id, ["skipped_at"]]);
  const id = itemOf(m);
  if (!id) return [];
  if (m.type === "create" || m.type === "recycle") return [[id, ["created"]]];
  const fields = FIELDS[m.type];
  return fields ? [[id, fields]] : [];
}

class ListSyncEngine implements SyncEngine {
  private readonly queue: MutationQueue;
  private readonly tempIdsKey: string;
  private tempIds = new Map<string, { id: string; at: number }>();
  private attached: EngineHandlers | null = null;
  private fallback: EngineHandlers | null = null;
  private readonly inFlight = new Set<string>();
  // Kept after a failure: not sent again until the next flush (a retry, a reconnect, a mount).
  private readonly parked = new Set<string>();
  // Set by a 401: nothing more is sent until the next flush (the backoff retry or a reconnect).
  private authHold = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  // Each running flush() and the entries it waits for: those queued and not in flight when
  // it started (with includeInFlight, those in flight too). It resolves once none of them is
  // in flight any more (sent and settled, or unable to run until the next flush).
  private flushWaiters: { ids: Set<string>; resolve: () => void }[] = [];
  // Every queued and in-flight entry, in queue order: the source of what to send, so a
  // change the device couldn't save is still sent, and pendingFields never reads or parses
  // localStorage (refresh and realtime ask it per row). Storage mirrors it for reloads.
  private readonly index = new Map<string, QueuedMutation>();
  // Drops reported while no page was open to show them; handed to the next page that attaches.
  private unreported: MutationErrorInfo[] = [];

  constructor(private readonly listId: string) {
    this.queue = new MutationQueue(listId);
    this.tempIdsKey = `${TEMP_IDS_PREFIX}${listId}`;
    this.loadTempIds();
    const { entries, skipped } = this.queue.load();
    for (const m of entries) this.index.set(m.id, m);
    // Logged by the queue; reported to the first page that opens the list.
    for (const raw of skipped) {
      const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const m: QueuedMutation = {
        id: str(r.id) ?? "unknown",
        type: str(r.type) ?? "unknown",
        payload: {},
        timestamp: Date.now(),
      };
      this.report(m, null, "A saved change could not be read", true);
    }
  }

  private get handlers(): EngineHandlers | null {
    return this.attached ?? this.fallback;
  }

  attach(handlers: EngineHandlers): () => void {
    this.attached = handlers;
    if (handlers.onError && this.unreported.length > 0) {
      const missed = this.unreported;
      this.unreported = [];
      for (const info of missed) this.callHandler("onError", () => handlers.onError?.(info));
    }
    return () => {
      if (this.attached !== handlers) return;
      this.attached = null;
      // Keep sending after the page closes, without its screen callbacks.
      if (!this.fallback) {
        this.fallback = {
          getJwt: handlers.getJwt,
          executorFactory: handlers.executorFactory,
          onAuthNeeded: handlers.onAuthNeeded,
        };
      }
    };
  }

  /** Handlers used while no page is attached (flushAllQueues). */
  setFallback(handlers: EngineHandlers) {
    this.fallback = handlers;
  }

  add(m: { id: string; type: string; payload: Record<string, unknown> }): void {
    const payload = this.rewrite(m.payload);
    this.queue.enqueue({ id: m.id, type: m.type, payload }, (evicted) => {
      for (const e of evicted) {
        this.index.delete(e.id);
        console.error("[SyncEngine] Offline queue full, dropping its oldest change:", this.ctx(e));
        this.report(e, null, "Evicted: the offline queue is full", true);
      }
    });
    this.index.set(m.id, { id: m.id, type: m.type, payload, timestamp: Date.now() });
    this.pump();
  }

  async flush(opts?: { includeInFlight?: boolean }): Promise<void> {
    const handlers = this.handlers;
    if (!handlers || !handlers.getJwt()) return;
    this.clearRetry();
    this.parked.clear();
    this.authHold = false;
    this.expire();
    // By default only what this flush can send: a request already in flight may hang (a
    // dead socket, a suspended WebView) and changes added after this point don't extend it,
    // so neither can hold a reconnect that awaits it. The list's first load passes
    // includeInFlight: it must not read the list before an earlier flush's replay landed.
    const strict = !!opts?.includeInFlight;
    const ids = new Set([...this.index.keys()].filter((id) => strict || !this.inFlight.has(id)));
    const done = new Promise<void>((resolve) => this.flushWaiters.push({ ids, resolve }));
    this.pump();
    this.settleFlushes();
    await done;
  }

  pendingFields(itemId: string): Set<string> {
    return this.pendingFieldsOf(this.index.values(), itemId);
  }

  pendingSnapshot(): QueuedMutation[] {
    return [...this.index.values()];
  }

  pendingFieldsOf(entries: Iterable<QueuedMutation>, itemId: string): Set<string> {
    const target = this.resolveId(itemId);
    const fields = new Set<string>();
    for (const m of entries) {
      for (const [id, touchedFields] of touched(m)) {
        if (this.resolveId(id) === target) for (const f of touchedFields) fields.add(f);
      }
    }
    return fields;
  }

  resolveId(id: string): string {
    return this.tempIds.get(id)?.id ?? id;
  }

  dispose() {
    this.clearRetry();
    this.attached = null;
    this.fallback = null;
    this.unreported = [];
    const waiters = this.flushWaiters;
    this.flushWaiters = [];
    for (const w of waiters) w.resolve();
  }

  // --- sending ---

  private chainKey(m: QueuedMutation): string {
    const item = itemOf(m);
    return item ? this.resolveId(item) : `mutation:${m.id}`;
  }

  /** Starts every entry whose chain is free, in queue order. */
  private pump(): void {
    const handlers = this.handlers;
    if (!handlers || this.authHold) return;
    const jwt = handlers.getJwt();
    if (!jwt) return;

    // A copy: a drop or a synchronous failure below changes the index.
    const queue = [...this.index.values()];
    const pendingCreates = new Set(
      queue.filter((m) => m.type === "create").map((m) => str(m.payload.tempId))
    );
    const busyChains = new Set<string>();
    let earlierAny = false;
    let earlierBarrier = false;
    let droppedAny = false;

    for (const m of queue) {
      const barrier = BARRIER_TYPES.has(m.type);
      const key = this.chainKey(m);
      const blocked = barrier ? earlierAny : earlierBarrier || busyChains.has(key);
      earlierAny = true;
      if (barrier) earlierBarrier = true;
      else busyChains.add(key);
      if (blocked || this.inFlight.has(m.id) || this.parked.has(m.id)) continue;
      if (this.inFlight.size >= MAX_IN_FLIGHT) break;

      // A change on a temp id whose create is gone (refused, evicted, expired, or queued by
      // an older app version that kept no id map) can never be sent.
      if (m.type !== "create" && isTempId(key) && !pendingCreates.has(key)) {
        console.error("[SyncEngine] Change for an item that was never created, dropping it:", this.ctx(m));
        this.remove(m);
        this.report(m, null, "Its item was never created", true);
        droppedAny = true;
        continue;
      }

      const resolved: QueuedMutation = { ...m, payload: this.rewrite(m.payload) };
      const executor = handlers.executorFactory(resolved, () => this.handlers?.getJwt() ?? jwt);
      if (!executor) {
        console.error("[SyncEngine] No executor for a queued change, dropping it:", this.ctx(m));
        this.remove(m);
        this.report(m, null, `No executor for "${m.type}"`, true);
        droppedAny = true;
        continue;
      }
      void this.run(m, executor);
    }
    // A drop can free a chain behind it.
    if (droppedAny) this.pump();
  }

  private async run(m: QueuedMutation, executor: Executor): Promise<void> {
    this.inFlight.add(m.id);
    let result: unknown;
    let ok = false;
    try {
      result = await executor();
      ok = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const statusMatch = message.match(/:\s*(\d{3})$/);
      const status = statusMatch ? parseInt(statusMatch[1], 10) : null;
      if (status === 401) {
        console.warn("[SyncEngine] Change refused with 401, keeping it until the session reconnects:", this.ctx(m), err);
        this.parked.add(m.id);
        this.report(m, status, message, false);
        if (!this.authHold) {
          this.authHold = true;
          this.callHandler("onAuthNeeded", () => this.handlers?.onAuthNeeded?.());
        }
        // Also retry on the backoff timer, so sync resumes even if the reconnect that
        // onAuthNeeded asks for never comes (e.g. one already running swallowed it).
        this.scheduleRetry();
      } else if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        console.error("[SyncEngine] Change refused by the server, dropping it:", this.ctx(m), err);
        this.remove(m);
        this.report(m, status, message, true);
      } else {
        const offline = status === null && (message.includes("fetch") || message.includes("network") || reportedOffline());
        console.warn(
          offline ? "[SyncEngine] Offline, keeping the change for later:" : "[SyncEngine] Change failed, keeping it for a retry:",
          this.ctx(m),
          err
        );
        this.parked.add(m.id);
        this.report(m, status, message, false);
        // While the device says it is offline, the "online" event's reconnect flushes.
        if (!reportedOffline()) this.scheduleRetry();
      }
    } finally {
      this.inFlight.delete(m.id);
    }
    if (ok) this.succeeded(m, result);
    this.pump();
    this.settleFlushes();
  }

  private succeeded(m: QueuedMutation, result: unknown) {
    if (m.type === "create") {
      const realId = result && typeof result === "object" ? str((result as { id?: unknown }).id) : undefined;
      if (!realId) {
        // e.g. the list hit its item limit: nothing was created.
        console.error("[SyncEngine] Create answered without an item, dropping it:", this.ctx(m));
        this.remove(m);
        this.report(m, null, "Create returned no item", true);
        return;
      }
      const tempId = str(m.payload.tempId);
      if (tempId) this.recordTempId(tempId, realId);
    }
    this.remove(m);
    this.retryAttempt = 0;
    this.callHandler("onSuccess", () => this.handlers?.onSuccess?.(m, result));
  }

  private expire() {
    const now = Date.now();
    for (const m of [...this.index.values()]) {
      if (this.inFlight.has(m.id) || now - m.timestamp <= MAX_AGE_MS) continue;
      console.warn("[SyncEngine] Dropping a change older than 24 hours:", this.ctx(m));
      this.remove(m);
      this.report(m, null, "Expired after 24 hours", true);
    }
  }

  private scheduleRetry() {
    if (this.retryTimer) return;
    const delay = Math.min(RETRY_BASE_MS * 2 ** this.retryAttempt, RETRY_MAX_MS);
    this.retryAttempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, delay);
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * Resolves each flush none of whose entries is still in flight (call after a pump). For a
   * strict flush that means each has landed, been dropped (a drop never leaves one in flight,
   * so it needs no call of its own) or can't run before the next flush: an entry queued
   * behind a request in flight waits behind one the flush also took, since chains and
   * barriers run in queue order.
   */
  private settleFlushes() {
    this.flushWaiters = this.flushWaiters.filter((w) => {
      for (const id of w.ids) if (this.inFlight.has(id)) return true;
      w.resolve();
      return false;
    });
  }

  private remove(m: QueuedMutation) {
    this.queue.dequeue(m.id);
    this.index.delete(m.id);
  }

  // --- temp ids ---

  /** Swaps resolved temp ids in a payload's itemId, orderedIds and itemIds. Returns the same object when nothing changes. */
  private rewrite(payload: Record<string, unknown>): Record<string, unknown> {
    let out = payload;
    const itemId = str(payload.itemId);
    if (itemId && this.tempIds.has(itemId)) out = { ...out, itemId: this.resolveId(itemId) };
    for (const key of ["orderedIds", "itemIds"]) {
      const ids = payload[key];
      if (Array.isArray(ids) && ids.some((id) => typeof id === "string" && this.tempIds.has(id))) {
        out = { ...out, [key]: ids.map((id) => (typeof id === "string" ? this.resolveId(id) : id)) };
      }
    }
    return out;
  }

  private recordTempId(tempId: string, realId: string) {
    this.tempIds.set(tempId, { id: realId, at: Date.now() });
    try {
      localStorage.setItem(this.tempIdsKey, JSON.stringify(Object.fromEntries(this.tempIds)));
    } catch (err) {
      console.error("[SyncEngine] Could not save a created item's id:", { listId: this.listId }, err);
    }
    this.queue.rewritePayloads((p) => this.rewrite(p));
    for (const [id, m] of this.index) {
      const payload = this.rewrite(m.payload);
      if (payload !== m.payload) this.index.set(id, { ...m, payload });
    }
  }

  private loadTempIds() {
    try {
      const raw = localStorage.getItem(this.tempIdsKey);
      const saved: Record<string, { id?: unknown; at?: unknown }> = raw ? JSON.parse(raw) : {};
      const now = Date.now();
      for (const [tempId, entry] of Object.entries(saved)) {
        if (typeof entry?.id === "string" && typeof entry.at === "number" && now - entry.at < TEMP_ID_MAX_AGE_MS) {
          this.tempIds.set(tempId, { id: entry.id, at: entry.at });
        }
      }
    } catch (err) {
      console.error("[SyncEngine] Could not read saved item ids:", { listId: this.listId }, err);
    }
  }

  // --- reporting ---

  // Ids and type only: payloads carry item text.
  private ctx(m: QueuedMutation) {
    return { listId: this.listId, mutationId: m.id, type: m.type };
  }

  private report(m: QueuedMutation, httpStatus: number | null, message: string, dropped: boolean) {
    const info: MutationErrorInfo = { mutationId: m.id, type: m.type, httpStatus, message, dropped, payload: m.payload };
    const onError = this.handlers?.onError;
    if (onError) this.callHandler("onError", () => onError(info));
    // No page is open (flushAllQueues, or a page that closed): show the drop when the list opens.
    else if (dropped) this.unreported.push(info);
  }

  /** A page callback that throws must never break the engine. */
  private callHandler(name: string, call: () => void) {
    try {
      call();
    } catch (err) {
      console.error(`[SyncEngine] The ${name} handler failed:`, { listId: this.listId }, err);
    }
  }
}

const engines = new Map<string, ListSyncEngine>();

function engineFor(listId: string): ListSyncEngine {
  let engine = engines.get(listId);
  if (!engine) {
    engine = new ListSyncEngine(listId);
    engines.set(listId, engine);
  }
  return engine;
}

export function getSyncEngine(listId: string): SyncEngine {
  return engineFor(listId);
}

/** Flushes every `mutation_queue:*` list in localStorage, so a list the user doesn't reopen still syncs. */
export async function flushAllQueues(
  getJwt: () => string | null,
  executorFactory: ExecutorFactory,
  onAuthNeeded?: () => void
): Promise<void> {
  if (!getJwt()) return;
  const listIds: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(QUEUE_PREFIX)) listIds.push(key.slice(QUEUE_PREFIX.length));
    }
  } catch (err) {
    console.error("[SyncEngine] Could not list the saved offline queues:", err);
    return;
  }
  await Promise.all(
    listIds.map((listId) => {
      const engine = engineFor(listId);
      engine.setFallback({ getJwt, executorFactory, onAuthNeeded });
      return engine.flush();
    })
  );
}

/** Forgets every engine, as a page reload does. Tests only. */
export function resetSyncEngines(): void {
  for (const engine of engines.values()) engine.dispose();
  engines.clear();
}
