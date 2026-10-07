import type { ItemData } from "@/src/types";
import { normalizeForCompare, normalizeForStorage } from "@/src/utils/text-normalize";

export interface Suggestion {
  id: string;
  text: string;
}

/** Whether the add-item input should suggest completed items while typing. */
export function shouldSearchWhileTyping(listType: "regular" | "reminders" | "grocery"): boolean {
  return listType !== "reminders";
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
