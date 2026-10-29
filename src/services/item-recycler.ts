/**
 * Smart item recycling service.
 * Matches new items against completed items to prevent duplicates.
 */

import { createServerClient } from "@/src/lib/supabase";
import { normalizeForCompare, normalizeForStorage } from "@/src/utils/text-normalize";

/** Escape ILIKE special characters to prevent wildcard injection */
function escapeIlike(input: string): string {
  return input.replace(/[%_\\]/g, "\\$&");
}

export interface RecyclableItem {
  id: string;
  text: string;
  completed: boolean;
  completed_at: string | null;
  deleted_at: string | null;
  position: number;
}

/**
 * Find recyclable items for UI typeahead autocomplete.
 * Searches completed items only (deleted items excluded).
 * Uses ILIKE substring matching (fast for partial typing).
 */
export async function findRecyclableItems(
  listId: string,
  searchText: string
): Promise<RecyclableItem[]> {
  const supabase = createServerClient();
  const canonical = normalizeForStorage(searchText);

  // Search completed items (not deleted)
  const { data: completedItems, error } = await supabase
    .from("items")
    .select("id, text, completed, completed_at, deleted_at, position")
    .eq("list_id", listId)
    .ilike("text", `%${escapeIlike(canonical)}%`)
    .eq("completed", true)
    .is("deleted_at", null)
    .order("completed_at", { ascending: false, nullsFirst: false })
    .limit(10);

  // Throw rather than answer []: "no match" makes callers create a duplicate.
  if (error) {
    console.error("[ItemRecycler] Recyclable items read failed:", { listId }, error);
    throw new Error("Recyclable items read failed", { cause: error });
  }

  return (completedItems || []) as RecyclableItem[];
}

const RECYCLE_COLUMNS = "id, text, completed, completed_at, deleted_at, position";

/**
 * Recycle an item — bring it back to the top of the active list.
 * Acts only on a live row of this list that still has the text the caller expects
 * (`text`, compared normalized); anything else answers null and writes nothing.
 * - Completed: sets completed=false, clears completed_at, skipped_at and ordered_at,
 *   and moves it to MAX(position)+1 (top of list).
 * - Already active: returned unchanged. A replayed recycle, or a second device tapping
 *   the same suggestion, lands once instead of adding a second copy.
 * A failed read or write is logged and thrown, so a caller never mistakes it for
 * "nothing to recycle".
 */
export async function recycleItem(
  itemId: string,
  userId: string,
  listId: string,
  text: string
): Promise<RecyclableItem | null> {
  const supabase = createServerClient();

  // The caller may pass a client-supplied id. Scoped to listId, so an id from another
  // list never reaches the update below, and to live rows, so a deleted item stays
  // deleted (deleting is final).
  const { data: item, error: lookupError } = await supabase
    .from("items")
    .select(RECYCLE_COLUMNS)
    .eq("id", itemId)
    .eq("list_id", listId)
    .is("deleted_at", null)
    .maybeSingle();

  if (lookupError) {
    console.error("[ItemRecycler] Item lookup failed:", { listId, itemId }, lookupError);
    throw new Error("Recycle item lookup failed", { cause: lookupError });
  }
  if (!item) return null;
  // The id must name the item the caller means: an id with other text is not reused.
  if (normalizeForCompare(normalizeForStorage(item.text)) !== normalizeForCompare(normalizeForStorage(text))) {
    return null;
  }
  if (!item.completed) {
    console.warn("[ItemRecycler] Item already active, returning it unchanged:", { listId, itemId });
    return item as RecyclableItem;
  }

  // Get max position
  const { data: maxPosResult, error: maxPosError } = await supabase
    .from("items")
    .select("position")
    .eq("list_id", listId)
    .order("position", { ascending: false })
    .limit(1);

  if (maxPosError) {
    console.error("[ItemRecycler] Max position read failed:", { listId }, maxPosError);
    throw new Error("Max position read failed", { cause: maxPosError });
  }

  const nextPosition = (maxPosResult?.[0]?.position || 0) + 1;

  const { data: recycled, error } = await supabase
    .from("items")
    .update({
      completed: false,
      completed_at: null,
      deleted_at: null,
      skipped_at: null,
      ordered_at: null,
      position: nextPosition,
      created_by: userId,
    })
    .eq("id", itemId)
    .eq("list_id", listId)
    .select(RECYCLE_COLUMNS)
    .maybeSingle();

  if (error) {
    console.error("[ItemRecycler] Recycle update failed:", { listId, itemId }, error);
    throw new Error("Recycle update failed", { cause: error });
  }
  // The row went away between the lookup and the update.
  if (!recycled) return null;
  return recycled as RecyclableItem;
}

/**
 * Find fuzzy matches for voice processing.
 * Uses pg_trgm similarity matching for typo tolerance.
 * Searches completed items only (deleted items excluded).
 */
export async function findFuzzyMatch(
  listId: string,
  text: string
): Promise<RecyclableItem[]> {
  const supabase = createServerClient();
  const canonical = normalizeForStorage(text);

  // Use RPC for pg_trgm similarity search
  const { data, error } = await supabase.rpc("find_fuzzy_items", {
    p_list_id: listId,
    p_search_text: canonical,
    p_threshold: 0.3,
  });

  if (error) {
    console.error("[ItemRecycler] Fuzzy search error:", error);
    // Fallback to ILIKE
    return findRecyclableItems(listId, canonical);
  }

  return (data || []) as RecyclableItem[];
}
