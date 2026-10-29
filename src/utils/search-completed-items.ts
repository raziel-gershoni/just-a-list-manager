import type { ItemData } from "@/src/types";
import { normalizeForCompare, normalizeForStorage } from "@/src/utils/text-normalize";

export interface Suggestion {
  id: string;
  text: string;
}

function ts(s: string | null): number | null {
  if (!s) return null;
  const n = new Date(s).getTime();
  return Number.isNaN(n) ? null : n;
}

/**
 * Local equivalent of findRecyclableItems: completed, non-deleted items whose text
 * contains the query (case-insensitive), most recently completed first, top `limit`.
 * Must mirror the server, which re-validates every recycle against its own result.
 */
export function searchCompletedItems(items: ItemData[], query: string, limit = 10): Suggestion[] {
  const canonical = normalizeForStorage(query);
  if (!canonical) return [];
  const needle = normalizeForCompare(canonical);

  return items
    .filter(
      (i) =>
        i.completed &&
        !i.deleted_at &&
        !i._pending &&
        normalizeForCompare(i.text).includes(needle)
    )
    .sort((a, b) => {
      const ta = ts(a.completed_at);
      const tb = ts(b.completed_at);
      if (ta === tb) return 0;
      if (ta === null) return 1;
      if (tb === null) return -1;
      return tb - ta;
    })
    .slice(0, limit)
    .map((i) => ({ id: i.id, text: i.text }));
}

/**
 * The completed item a typed add recycles: the same text after normalization (no
 * substring), most recently completed first, skipping ids in `exclude`. Looks through
 * every completed item on screen, not just the top-10 suggestions: the server recycles by
 * id and checks only the text, so a typed add and a tap on the matching suggestion do the
 * same thing.
 */
export function findCompletedExactMatch(
  items: ItemData[],
  text: string,
  exclude: ReadonlySet<string> = new Set()
): Suggestion | undefined {
  const canonical = normalizeForStorage(text);
  if (!canonical) return undefined;
  const needle = normalizeForCompare(canonical);
  return searchCompletedItems(items, canonical, items.length).find(
    (s) => !exclude.has(s.id) && normalizeForCompare(s.text) === needle
  );
}

/**
 * Suggestions for the add-item input: searches only the text after the last comma.
 * Pure so it can be derived from live items.
 */
export function computeSuggestions(items: ItemData[], value: string): Suggestion[] {
  const segments = value.split(",");
  const currentSegment = segments[segments.length - 1].trim();
  return searchCompletedItems(items, currentSegment);
}
