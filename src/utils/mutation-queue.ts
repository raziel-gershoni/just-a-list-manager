/**
 * Offline mutation queue with localStorage persistence.
 * Stores pending mutations when offline, flushes on reconnect.
 */

export interface QueuedMutation {
  id: string;
  type: string;
  payload: any;
  timestamp: number;
}

const MAX_QUEUE_SIZE = 100;

export class MutationQueue {
  private storageKey: string;

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

  enqueue(mutation: Omit<QueuedMutation, "id" | "timestamp">): string {
    const queue = this.getQueue();
    const id = `mut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: QueuedMutation = {
      id,
      ...mutation,
      timestamp: Date.now(),
    };

    queue.push(entry);

    // Drop oldest if exceeded
    if (queue.length > MAX_QUEUE_SIZE) {
      queue.splice(0, queue.length - MAX_QUEUE_SIZE);
    }

    this.saveQueue(queue);
    return id;
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
}
