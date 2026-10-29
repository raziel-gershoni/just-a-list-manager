"use client";

import { useRef, useCallback, useEffect } from "react";
import {
  getSyncEngine,
  type ExecutorFactory,
  type MutationErrorInfo,
  type QueuedMutation,
} from "@/src/sync/engine";
import { createExecutorFactory } from "@/src/utils/executor-factory";

export type { ExecutorFactory, MutationErrorInfo, QueuedMutation } from "@/src/sync/engine";

const defaultExecutorFactory = createExecutorFactory();

/**
 * The list page's handle on its list's sync engine (src/sync/engine.ts). Every change goes
 * through addMutation and is sent by the executor factory, online and on replay. Nothing is
 * flushed here on mount: the page flushes once a JWT exists, and the provider flushes every
 * list after auth.
 */
export function useMutationQueue(
  listId: string,
  getJwt: () => string | null,
  executorFactory?: ExecutorFactory,
  onMutationError?: (info: MutationErrorInfo) => void,
  onMutationSuccess?: (m: QueuedMutation, result: unknown) => void,
  onAuthNeeded?: () => void
) {
  // Latest callbacks, read when the engine calls back, so a re-render never re-attaches.
  const latest = useRef({ getJwt, executorFactory, onMutationError, onMutationSuccess, onAuthNeeded });
  useEffect(() => {
    latest.current = { getJwt, executorFactory, onMutationError, onMutationSuccess, onAuthNeeded };
  });

  useEffect(
    () =>
      getSyncEngine(listId).attach({
        getJwt: () => latest.current.getJwt(),
        executorFactory: (m, jwt) => (latest.current.executorFactory ?? defaultExecutorFactory)(m, jwt),
        onError: (info) => latest.current.onMutationError?.(info),
        onSuccess: (m, result) => latest.current.onMutationSuccess?.(m, result),
        onAuthNeeded: () => latest.current.onAuthNeeded?.(),
      }),
    [listId]
  );

  const addMutation = useCallback(
    (mutation: { id: string; type: string; payload: Record<string, unknown> }) => getSyncEngine(listId).add(mutation),
    [listId]
  );
  // includeInFlight: the list's first load also waits for a replay already in flight.
  const flushQueue = useCallback(
    (opts?: { includeInFlight?: boolean }) => getSyncEngine(listId).flush(opts),
    [listId]
  );
  const pendingFields = useCallback((itemId: string) => getSyncEngine(listId).pendingFields(itemId), [listId]);

  return { addMutation, flushQueue, pendingFields };
}
