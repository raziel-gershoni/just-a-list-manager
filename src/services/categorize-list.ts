/**
 * Sort everything waiting in a grocery list into categories with at most one AI call.
 * Scheduled with after() from item and category routes and from voice adds; never
 * throws. See docs/superpowers/specs/2026-10-08-grocery-auto-categories-design.md.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getCategorizer, MAX_CATEGORIES_PER_LIST, type ItemCategorizer } from "@/src/services/categorizer";
import { redisListLock, type ListLock, type RerunMode } from "@/src/utils/categorize-lock";
import { orderWithNewCategories } from "@/src/utils/category-order";
import { categorizeRateLimiter, checkRateLimit } from "@/src/lib/rate-limit";
import { normalizeForCompare, normalizeForStorage } from "@/src/utils/text-normalize";

export type CategorizeMode = RerunMode;
export interface CategorizeDeps {
  supabase: SupabaseClient;
  categorizer?: ItemCategorizer;
  lock?: ListLock;
  allowAiCall?: (listId: string) => Promise<boolean>;
}

const MAX_ROUNDS = 3;

type CategoryRow = { id: string; name_en: string; position: number };
type ItemRow = {
  id: string;
  text: string;
  category_id: string | null;
  category_locked: boolean;
  deleted_at: string | null;
  created_at: string;
};
type Assignment = { id: string; text: string; category_id: string };

const textKey = (text: string) => normalizeForCompare(normalizeForStorage(text));

async function defaultAllowAiCall(listId: string): Promise<boolean> {
  return (await checkRateLimit(categorizeRateLimiter, listId, true)).success;
}

/** Normalized text -> category, from rows that have one: hand-placed first, then newest. */
function knownCategories(rows: ItemRow[]): Map<string, string> {
  const ranked = rows
    .filter((r) => r.category_id)
    .sort((a, b) =>
      Number(b.category_locked) - Number(a.category_locked) || b.created_at.localeCompare(a.created_at)
    );
  const known = new Map<string, string>();
  for (const r of ranked) {
    const key = textKey(r.text);
    if (!known.has(key)) known.set(key, r.category_id!);
  }
  return known;
}

async function runOnce(deps: Required<CategorizeDeps>, listId: string, mode: CategorizeMode) {
  const { supabase, categorizer, allowAiCall } = deps;

  // PostgREST returns failures instead of throwing. Going on without the categories would
  // tell the AI the list has none, and it would create duplicates of every one.
  const { data: categoryData, error: categoryError } = await supabase
    .from("list_categories")
    .select("id, name_en, position")
    .eq("list_id", listId)
    .order("position", { ascending: true });
  if (categoryError) {
    console.error("[Categorizer] could not load categories", { listId, error: categoryError });
    return;
  }
  const categories = ((categoryData ?? []) as CategoryRow[]).slice().sort((a, b) => a.position - b.position);

  const { data: itemData, error: itemError } = await supabase
    .from("items")
    .select("id, text, category_id, category_locked, deleted_at, created_at")
    .eq("list_id", listId);
  if (itemError) {
    console.error("[Categorizer] could not load items", { listId, error: itemError });
    return;
  }
  const rows = (itemData ?? []) as ItemRow[];

  const targets = rows.filter(
    (r) => !r.deleted_at && !r.category_locked && (mode === "rescan" || !r.category_id)
  );
  if (targets.length === 0) return;

  const assignments: Assignment[] = [];
  let remaining = targets;
  if (mode === "pending") {
    const known = knownCategories(rows);
    remaining = [];
    for (const t of targets) {
      const categoryId = known.get(textKey(t.text));
      if (categoryId) assignments.push({ id: t.id, text: t.text, category_id: categoryId });
      else remaining.push(t);
    }
  }

  if (remaining.length > 0) {
    if (!(await allowAiCall(listId))) {
      console.warn("[Categorizer] per-list AI limit reached", { listId });
    } else {
      const keyed = categories.map((c, k) => ({ key: `c${k + 1}`, id: c.id, name: c.name_en }));
      const room = MAX_CATEGORIES_PER_LIST - categories.length;
      const result = await categorizer.categorize({
        categories: keyed.map(({ key, name }) => ({ key, name })),
        items: remaining.map((r, i) => ({ i, text: r.text })),
        allowNew: room > 0,
        maxNew: Math.max(room, 0),
      });
      if (result) {
        const keyToId = new Map(keyed.map((k) => [k.key, k.id]));
        if (result.newCategories.length > 0) {
          const order = orderWithNewCategories(keyed.map((k) => k.key), result.newCategories);
          for (const created of result.newCategories) {
            const { data: inserted, error: insertError } = await supabase
              .from("list_categories")
              .insert({
                list_id: listId,
                name_en: created.en,
                name_he: created.he,
                name_ru: created.ru,
                position: order.indexOf(created.ref),
                created_by: null,
              })
              .select("id")
              .single();
            if (insertError) console.error("[Categorizer] category insert failed", { listId, error: insertError });
            const id = (inserted as { id?: string } | null)?.id;
            if (id) keyToId.set(created.ref, id);
          }
          for (const k of keyed) {
            const position = order.indexOf(k.key);
            const current = categories.find((c) => c.id === k.id)!;
            if (position !== current.position) {
              await supabase.from("list_categories").update({ position }).eq("id", k.id).eq("list_id", listId);
            }
          }
        }
        for (const a of result.assignments) {
          const categoryId = keyToId.get(a.category);
          const item = remaining[a.i];
          if (categoryId && item) assignments.push({ id: item.id, text: item.text, category_id: categoryId });
        }
      }
    }
  }

  if (assignments.length > 0) {
    const { error } = await supabase.rpc("apply_item_categories", {
      p_list_id: listId,
      p_assignments: assignments,
      p_only_null: mode === "pending",
    });
    if (error) console.error("[Categorizer] apply failed", { listId, error });
  }
}

export async function categorizeList(
  deps: CategorizeDeps,
  listId: string,
  mode: CategorizeMode
): Promise<void> {
  try {
    // Inside the try: building the default categorizer reads env and can throw.
    const full: Required<CategorizeDeps> = {
      supabase: deps.supabase,
      categorizer: deps.categorizer ?? getCategorizer(),
      lock: deps.lock ?? redisListLock,
      allowAiCall: deps.allowAiCall ?? defaultAllowAiCall,
    };
    const { data: list } = await full.supabase
      .from("lists")
      .select("type")
      .eq("id", listId)
      .is("deleted_at", null)
      .maybeSingle();
    if ((list as { type?: string } | null)?.type !== "grocery") return;

    if (!(await full.lock.acquire(listId))) {
      await full.lock.requestRerun(listId, mode);
      return;
    }
    try {
      let next: CategorizeMode | null = mode;
      for (let round = 0; next && round < MAX_ROUNDS; round++) {
        await runOnce(full, listId, next);
        next = await full.lock.takeRerun(listId);
      }
    } finally {
      await full.lock.release(listId);
    }
  } catch (error) {
    console.error("[Categorizer] categorizeList failed", { listId, mode }, error);
  }
}
