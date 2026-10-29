/**
 * Offline mutation queue with localStorage persistence: the storage layer of the sync
 * engine (src/sync/engine.ts), which decides what is sent and when.
 */

export interface QueuedMutation {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

export const MAX_QUEUE_SIZE = 500;

export class MutationQueue {
  private storageKey: string;
  // Ephemeral, per-session, never persisted: which queued mutations have a request
  // in flight right now. A queued mutation is only removed on success, so without
  // this a flush triggered mid-request (focus / visibilitychange / the 45-minute
  // timer) re-runs the same executor and the request lands twice.
  private inFlight = new Set<string>();

  constructor(listId: string) {
    this.storageKey = `mutation_queue:${listId}`;
  }

  getQueue(): QueuedMutation[] {
    try {
      const raw = localStorage.getItem(this.storageKey);
      return raw ? JSON.parse(raw) : [];
    } catch (err) {
      console.error(`[MutationQueue] Could not read the offline queue (${this.storageKey}):`, err);
      return [];
    }
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

  markInFlight(id: string) {
    this.inFlight.add(id);
  }

  clearInFlight(id: string) {
    this.inFlight.delete(id);
  }

  isInFlight(id: string): boolean {
    return this.inFlight.has(id);
  }
}
