/**
 * Offline mutation queue with localStorage persistence: the storage layer of the sync
 * engine (src/sync/engine.ts), which decides what is sent and when.
 */

export interface QueuedMutation {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
  // The telegram_user_id of the account signed in when the change was made. Absent (saved
  // before owners existed, or made with no token): it belongs to whoever replays it.
  owner?: number;
}

export const MAX_QUEUE_SIZE = 500;

function isQueuedMutation(v: unknown): v is QueuedMutation {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    typeof m.type === "string" &&
    typeof m.timestamp === "number" &&
    (m.owner === undefined || typeof m.owner === "number") &&
    !!m.payload &&
    typeof m.payload === "object" &&
    !Array.isArray(m.payload)
  );
}

export class MutationQueue {
  private storageKey: string;

  constructor(listId: string) {
    this.storageKey = `mutation_queue:${listId}`;
  }

  /** The stored entries in order. A stored value it can't use (written by an older or broken version) is logged and left out. */
  getQueue(): QueuedMutation[] {
    return this.read().entries;
  }

  /** Reads the queue once (at startup): returns what it left out too, and saves the queue without it. */
  load(): { entries: QueuedMutation[]; skipped: unknown[] } {
    const result = this.read();
    if (result.skipped.length > 0) this.saveQueue(result.entries);
    return result;
  }

  private read(): { entries: QueuedMutation[]; skipped: unknown[] } {
    let parsed: unknown;
    try {
      const raw = localStorage.getItem(this.storageKey);
      parsed = raw ? JSON.parse(raw) : [];
    } catch (err) {
      console.error(`[MutationQueue] Could not read the offline queue (${this.storageKey}):`, err);
      return { entries: [], skipped: [] };
    }
    if (!Array.isArray(parsed)) {
      console.error(`[MutationQueue] The offline queue (${this.storageKey}) is not a list, ignoring it:`, typeof parsed);
      return { entries: [], skipped: [parsed] };
    }
    const entries: QueuedMutation[] = [];
    const skipped: unknown[] = [];
    parsed.forEach((m, index) => {
      if (isQueuedMutation(m)) {
        entries.push(m);
        return;
      }
      skipped.push(m);
      // Shape only: a payload carries item text.
      const r = m && typeof m === "object" ? (m as Record<string, unknown>) : {};
      console.error(`[MutationQueue] Skipping an unreadable entry in the offline queue (${this.storageKey}):`, {
        index,
        id: typeof r.id === "string" ? r.id : undefined,
        type: typeof r.type === "string" ? r.type : undefined,
      });
    });
    return { entries, skipped };
  }

  private saveQueue(queue: QueuedMutation[]) {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(queue));
    } catch (err) {
      console.error(`[MutationQueue] Could not persist the offline queue (${this.storageKey}, ${queue.length} entries):`, err);
      // localStorage full or unavailable
    }
  }

  /** Appends a change. Past MAX_QUEUE_SIZE the oldest entries are evicted and handed to `onEvict`. */
  enqueue(
    mutation: Omit<QueuedMutation, "timestamp">,
    onEvict?: (evicted: QueuedMutation[]) => void
  ): string {
    const queue = this.getQueue();
    const entry: QueuedMutation = {
      ...mutation,
      timestamp: Date.now(),
    };

    queue.push(entry);

    const evicted = queue.length > MAX_QUEUE_SIZE ? queue.splice(0, queue.length - MAX_QUEUE_SIZE) : [];

    this.saveQueue(queue);
    if (evicted.length > 0) onEvict?.(evicted);
    return mutation.id;
  }

  dequeue(id: string) {
    const queue = this.getQueue().filter((m) => m.id !== id);
    this.saveQueue(queue);
  }

  /** Rewrites stored payloads in place (e.g. a temp id swapped for the real one). `rewrite` returns the same object when nothing changes. */
  rewritePayloads(rewrite: (payload: Record<string, unknown>) => Record<string, unknown>) {
    let changed = false;
    const next = this.getQueue().map((m) => {
      const payload = rewrite(m.payload);
      if (payload === m.payload) return m;
      changed = true;
      return { ...m, payload };
    });
    if (changed) this.saveQueue(next);
  }

  clear() {
    try {
      localStorage.removeItem(this.storageKey);
    } catch (err) {
      console.warn(`[MutationQueue] Could not clear the offline queue (${this.storageKey}):`, err);
    }
  }
}
