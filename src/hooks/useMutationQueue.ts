"use client";

import { useRef, useCallback, useEffect } from "react";
import { MutationQueue, QueuedMutation } from "@/src/utils/mutation-queue";

interface Mutation {
  type: string;
  payload: any;
  execute: () => Promise<void>;
}

export type ExecutorFactory = (
  mutation: QueuedMutation
) => (() => Promise<void>) | null;

export function useMutationQueue(
  listId: string,
  executorFactory?: ExecutorFactory
) {
  const queueRef = useRef(new MutationQueue(listId));
  const isFlushingRef = useRef(false);
  const pendingExecutors = useRef<Map<string, () => Promise<void>>>(
    new Map()
  );
  const executorFactoryRef = useRef(executorFactory);
  executorFactoryRef.current = executorFactory;

  const executeMutation = useCallback(
    async (id: string, execute: () => Promise<void>) => {
      try {
        await execute();
        queueRef.current.dequeue(id);
        pendingExecutors.current.delete(id);
      } catch (error: any) {
        // If offline, keep in queue
        if (
          error?.message?.includes("fetch") ||
          error?.message?.includes("network") ||
          !navigator.onLine
        ) {
          console.log("[MutationQueue] Offline — queued for later:", id);
          return;
        }

        // If 404/410, silently drop (entity deleted by another user)
        if (error?.status === 404 || error?.status === 410) {
          console.log("[MutationQueue] Entity gone — dropping:", id);
          queueRef.current.dequeue(id);
          pendingExecutors.current.delete(id);
          return;
        }

        // Other errors — keep in queue
        console.error("[MutationQueue] Error:", error);
      }
    },
    []
  );

  const flushQueue = useCallback(async () => {
    if (isFlushingRef.current) return;
    isFlushingRef.current = true;

    const queue = queueRef.current.getQueue();
    for (const mutation of queue) {
      let executor = pendingExecutors.current.get(mutation.id);
      if (!executor && executorFactoryRef.current) {
        executor = executorFactoryRef.current(mutation) ?? undefined;
        if (executor) {
          pendingExecutors.current.set(mutation.id, executor);
        }
      }
      if (executor) {
        await executeMutation(mutation.id, executor);
      } else {
        // Executor lost and no factory — can't replay, remove
        console.log("[MutationQueue] No executor for mutation, dropping:", mutation.id, mutation.type);
        queueRef.current.dequeue(mutation.id);
      }
    }

    isFlushingRef.current = false;
  }, [executeMutation]);

  const addMutation = useCallback(
    (mutation: Mutation) => {
      const id = queueRef.current.enqueue({
        type: mutation.type,
        payload: mutation.payload,
      });

      pendingExecutors.current.set(id, mutation.execute);

      // Try to execute immediately
      executeMutation(id, mutation.execute);
    },
    [executeMutation]
  );

  // Flush on reconnect
  useEffect(() => {
    const handleOnline = () => {
      console.log("[MutationQueue] Online — flushing queue");
      flushQueue();
    };

    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [flushQueue]);

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
