"use client";

import { useEffect, useRef } from "react";

const DEFAULT_DELAYS = [30_000, 60_000, 120_000];

/**
 * Items that stay under "Sorting…" mean a sort request was lost or its AI call refused.
 * Re-requesting the list makes GET /items schedule another sort, so while the same items
 * stay unsorted this calls `refresh` after each delay in turn, then stops. Any change to
 * the set starts over from the first delay; an empty set cancels.
 * `delays` must keep its identity across renders (the default does).
 */
export function useSortingRetry({
  sortingIds,
  refresh,
  delays = DEFAULT_DELAYS,
}: {
  sortingIds: string[];
  refresh: () => unknown;
  delays?: number[];
}) {
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // The set, not the array: a refresh hands back new arrays of the same items.
  const sortingKey = [...sortingIds].sort().join("\n");

  useEffect(() => {
    if (!sortingKey) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = (step: number) => {
      if (step >= delays.length) return;
      timer = setTimeout(() => {
        refreshRef.current();
        wait(step + 1);
      }, delays[step]);
    };
    wait(0);
    return () => clearTimeout(timer);
  }, [sortingKey, delays]);
}
