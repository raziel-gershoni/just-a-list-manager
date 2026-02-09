"use client";

import { useRef, useCallback, useEffect } from "react";
import { MutationQueue } from "@/src/utils/mutation-queue";

interface Mutation {
  type: string;
  payload: any;
  execute: () => Promise<void>;
}

export function useMutationQueue(listId: string) {
  const queueRef = useRef(new MutationQueue(listId));
  const isFlushingRef = useRef(false);
  const pendingExecutors = useRef<Map<string, () => Promise<void>>>(
    new Map()
  );

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
    [listId]
  );

  const executeMutation = async (
    id: string,
    execute: () => Promise<void>
  ) => {
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
  };

  const flushQueue = useCallback(async () => {
    if (isFlushingRef.current) return;
    isFlushingRef.current = true;

    const queue = queueRef.current.getQueue();
    for (const mutation of queue) {
      const executor = pendingExecutors.current.get(mutation.id);
      if (executor) {
        await executeMutation(mutation.id, executor);
      } else {
        // Executor lost (page reload) — can't replay, remove
        queueRef.current.dequeue(mutation.id);
      }
    }

    isFlushingRef.current = false;
  }, []);

  // Flush on reconnect
  useEffect(() => {
    const handleOnline = () => {
      console.log("[MutationQueue] Online — flushing queue");
      flushQueue();
    };

    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [flushQueue]);

  return { addMutation, flushQueue };
}
