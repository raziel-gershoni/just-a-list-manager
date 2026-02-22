"use client";

import { useRef, useCallback, useEffect } from "react";
import { MutationQueue, QueuedMutation } from "@/src/utils/mutation-queue";

interface Mutation {
  id: string;
  type: string;
  payload: any;
  execute: () => Promise<string | void>;
}

export type ExecutorFactory = (
  mutation: QueuedMutation,
  getJwt: () => string
) => (() => Promise<string | void>) | null;

const MUTATION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export function useMutationQueue(
  listId: string,
  getJwt: () => string | null,
  executorFactory?: ExecutorFactory
) {
  const queueRef = useRef(new MutationQueue(listId));
  const isFlushingRef = useRef(false);
  const pendingExecutors = useRef<Map<string, () => Promise<string | void>>>(
    new Map()
  );
  const executorFactoryRef = useRef(executorFactory);
  executorFactoryRef.current = executorFactory;

  const executeMutation = useCallback(
    async (id: string, execute: () => Promise<string | void>): Promise<string | void> => {
      try {
        const result = await execute();
        queueRef.current.dequeue(id);
        pendingExecutors.current.delete(id);
        return result;
      } catch (error: any) {
        const message = error?.message || "";

        // If offline, keep in queue for later
        if (
          message.includes("fetch") ||
          message.includes("network") ||
          message.includes("Failed to fetch") ||
          !navigator.onLine
        ) {
          console.log("[MutationQueue] Offline — queued for later:", id);
          return;
        }

        // Extract HTTP status from error message (e.g. "Create failed: 404")
        const statusMatch = message.match(/:\s*(\d{3})$/);
        const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : null;

        // 4xx client errors (except 408 timeout / 429 rate limit) won't succeed on retry — dequeue
        if (httpStatus && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429) {
          console.log("[MutationQueue] Client error — dropping:", id, httpStatus);
          queueRef.current.dequeue(id);
          pendingExecutors.current.delete(id);
          return;
        }

        // 5xx server errors, 408, 429, or unknown — keep in queue for retry
        console.error("[MutationQueue] Error (will retry):", id, message);
      }
    },
    []
  );

  const flushQueue = useCallback(async () => {
    if (isFlushingRef.current) return;
    isFlushingRef.current = true;

    const queue = queueRef.current.getQueue();
    const tempToRealId = new Map<string, string>();
    // Track temp IDs whose create mutation failed — skip dependent mutations
    const failedTempIds = new Set<string>();

    for (const mutation of queue) {
      // Drop mutations older than 24 hours
      if (Date.now() - mutation.timestamp > MUTATION_MAX_AGE_MS) {
        console.log("[MutationQueue] Dropping stale mutation (>24h):", mutation.id, mutation.type);
        queueRef.current.dequeue(mutation.id);
        pendingExecutors.current.delete(mutation.id);
        continue;
      }

      // Skip mutations that depend on a failed create (temp ID never resolved)
      if (mutation.payload?.itemId && failedTempIds.has(mutation.payload.itemId)) {
        console.log("[MutationQueue] Skipping mutation (parent create failed):", mutation.id, mutation.type);
        continue;
      }

      // Resolve temp IDs in payload for chained mutations (use a clone to avoid mutating persisted queue)
      const resolvedMutation = (mutation.payload?.itemId && tempToRealId.has(mutation.payload.itemId))
        ? { ...mutation, payload: { ...mutation.payload, itemId: tempToRealId.get(mutation.payload.itemId)! } }
        : mutation;

      let executor = pendingExecutors.current.get(mutation.id);
      // If payload was resolved (temp→real ID swap), discard the stored executor
      // so the factory creates a fresh one with the resolved ID in its closure
      if (resolvedMutation !== mutation && executor) {
        pendingExecutors.current.delete(mutation.id);
        executor = undefined;
      }
      if (!executor && executorFactoryRef.current) {
        const jwt = getJwt();
        if (jwt) {
          executor = executorFactoryRef.current(resolvedMutation, () => getJwt()!) ?? undefined;
          if (executor) {
            pendingExecutors.current.set(mutation.id, executor);
          }
        }
      }

      if (executor) {
        const result = await executeMutation(mutation.id, executor);
        // If create mutation returned a server-assigned ID, track for temp→real resolution
        if (typeof result === "string" && resolvedMutation.type === "create" && resolvedMutation.payload?.tempId) {
          tempToRealId.set(resolvedMutation.payload.tempId, result);
        }
        // If create mutation failed (still in queue — no dequeue happened), mark temp ID as failed
        if (result === undefined && resolvedMutation.type === "create" && resolvedMutation.payload?.tempId) {
          const stillInQueue = queueRef.current.getQueue().some((m) => m.id === mutation.id);
          if (stillInQueue) {
            failedTempIds.add(resolvedMutation.payload.tempId);
          }
        }
      } else {
        // Executor lost and no factory — can't replay, remove
        console.log("[MutationQueue] No executor for mutation, dropping:", mutation.id, mutation.type);
        queueRef.current.dequeue(mutation.id);
      }
    }

    isFlushingRef.current = false;
  }, [executeMutation, getJwt]);

  const addMutation = useCallback(
    (mutation: Mutation) => {
      queueRef.current.enqueue({
        id: mutation.id,
        type: mutation.type,
        payload: mutation.payload,
      });

      pendingExecutors.current.set(mutation.id, mutation.execute);

      // Skip immediate execution if flush is in progress
      if (isFlushingRef.current) return;

      // Try to execute immediately
      executeMutation(mutation.id, mutation.execute);
    },
    [executeMutation]
  );

  // Flush on mount — replays any mutations persisted from a previous session
  useEffect(() => {
    const queue = queueRef.current.getQueue();
    if (queue.length > 0) {
      console.log("[MutationQueue] Found", queue.length, "persisted mutations — flushing");
      flushQueue();
    }
  }, [flushQueue]);

  return { addMutation, flushQueue };
}
