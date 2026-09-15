/**
 * Offline mutation queue with localStorage persistence.
 * Stores pending mutations when offline, flushes on reconnect.
 */

export interface QueuedMutation {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

const MAX_QUEUE_SIZE = 100;

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
    } catch {
      return [];
    }
  }

  private saveQueue(queue: QueuedMutation[]) {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(queue));
    } catch {
      // localStorage full or unavailable
    }
  }

  enqueue(mutation: Omit<QueuedMutation, "timestamp">): string {
    const queue = this.getQueue();
    const entry: QueuedMutation = {
      ...mutation,
      timestamp: Date.now(),
    };

    queue.push(entry);

    // Drop oldest if exceeded
    if (queue.length > MAX_QUEUE_SIZE) {
      queue.splice(0, queue.length - MAX_QUEUE_SIZE);
    }

    this.saveQueue(queue);
    return mutation.id;
  }

  dequeue(id: string) {
    const queue = this.getQueue().filter((m) => m.id !== id);
    this.saveQueue(queue);
  }

  clear() {
    try {
      localStorage.removeItem(this.storageKey);
    } catch {
      // ignore
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
