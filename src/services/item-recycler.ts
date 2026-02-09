/**
 * Smart item recycling service.
 * Matches new items against completed/soft-deleted items to prevent duplicates.
 */

import { createServerClient } from "@/src/lib/supabase";

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
 * Searches both completed items and soft-deleted items (within 7-day window).
 * Uses ILIKE substring matching (fast for partial typing).
 */
export async function findRecyclableItems(
  listId: string,
  searchText: string
): Promise<RecyclableItem[]> {
  const supabase = createServerClient();
  const sevenDaysAgo = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000
  ).toISOString();

  // Search completed items (active and soft-deleted within 7 days)
  const { data: completedItems } = await supabase
    .from("items")
    .select("id, text, completed, completed_at, deleted_at, position")
    .eq("list_id", listId)
    .ilike("text", `%${escapeIlike(searchText)}%`)
    .or(
      `and(completed.eq.true,deleted_at.is.null),and(deleted_at.not.is.null,deleted_at.gte.${sevenDaysAgo})`
    )
    .order("completed_at", { ascending: false, nullsFirst: false })
    .limit(10);

  return (completedItems || []) as RecyclableItem[];
}

/**
 * Recycle an item — restore it to active state.
 * Sets completed=false, completed_at=null, deleted_at=null,
 * and position to MAX(position)+1 (top of list).
 */
export async function recycleItem(
  itemId: string
): Promise<RecyclableItem | null> {
  const supabase = createServerClient();

  // Get the item's list to find max position
  const { data: item } = await supabase
    .from("items")
    .select("list_id")
    .eq("id", itemId)
    .single();

  if (!item) return null;

  // Get max position
  const { data: maxPosResult } = await supabase
    .from("items")
    .select("position")
    .eq("list_id", item.list_id)
    .order("position", { ascending: false })
    .limit(1);

  const nextPosition = (maxPosResult?.[0]?.position || 0) + 1;

  const { data: recycled, error } = await supabase
    .from("items")
    .update({
      completed: false,
      completed_at: null,
      deleted_at: null,
      position: nextPosition,
    })
    .eq("id", itemId)
    .select("id, text, completed, completed_at, deleted_at, position")
    .single();

  if (error || !recycled) return null;
  return recycled as RecyclableItem;
}

/**
 * Find fuzzy matches for voice processing.
 * Uses pg_trgm similarity matching for typo tolerance.
 * Searches both completed and soft-deleted items within 7-day window.
 */
export async function findFuzzyMatch(
  listId: string,
  text: string
): Promise<RecyclableItem[]> {
  const supabase = createServerClient();
  const sevenDaysAgo = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000
  ).toISOString();

  // Use RPC for pg_trgm similarity search
  const { data, error } = await supabase.rpc("find_fuzzy_items", {
    p_list_id: listId,
    p_search_text: text,
    p_since: sevenDaysAgo,
    p_threshold: 0.3,
  });

  if (error) {
    console.error("[ItemRecycler] Fuzzy search error:", error);
    // Fallback to ILIKE
    return findRecyclableItems(listId, text);
  }

  return (data || []) as RecyclableItem[];
}
