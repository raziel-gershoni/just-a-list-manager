/**
 * Sort everything waiting in a grocery list into categories with at most one AI call.
 * Scheduled with after() from item and category routes and from voice adds; never
 * throws. See docs/superpowers/specs/2026-10-08-grocery-auto-categories-design.md.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getCategorizer, MAX_CATEGORIES_PER_LIST, type ItemCategorizer } from "@/src/services/categorizer";
import { redisListLock, type ListLock, type RerunMode } from "@/src/utils/categorize-lock";
import { categorizeGlobalRateLimiter, categorizeRateLimiter, checkRateLimit } from "@/src/lib/rate-limit";
import { normalizeForCompare, normalizeForStorage } from "@/src/utils/text-normalize";

export type CategorizeMode = RerunMode;
export interface CategorizeDeps {
  supabase: SupabaseClient;
  categorizer?: ItemCategorizer;
  lock?: ListLock;
  allowAiCall?: (listId: string) => Promise<boolean>;
  now?: () => number;
  /** How long a pending run waits after taking the lock before it reads the items. */
  settleMs?: number;
}

// A run takes waiting requests until this much time has passed; one left waiting then is
// picked up by the next trigger or the client's retry.
const RUN_BUDGET_MS = 50_000;
// Items added together (a comma list, two people) land within this, so they share one AI call.
const SETTLE_MS = 1500;
// Items per AI call, so a list's long completed history cannot push the reply past the
// 25 s AI timeout on every attempt.
const AI_BATCH_LIMIT = 100;

type CategoryRow = { id: string; name_en: string; position: number };
type ItemRow = {
  id: string;
  text: string;
  completed: boolean;
  category_id: string | null;
  category_locked: boolean;
  deleted_at: string | null;
  created_at: string;
};
type Assignment = { id: string; text: string; category_id: string };

const textKey = (text: string) => normalizeForCompare(normalizeForStorage(text));

// The list's own budget first, so a list over its budget does not spend the app-wide one.
async function defaultAllowAiCall(listId: string): Promise<boolean> {
  return (
    (await checkRateLimit(categorizeRateLimiter, listId, true)).success &&
    (await checkRateLimit(categorizeGlobalRateLimiter, "global", true)).success
  );
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

async function runOnce(deps: Required<CategorizeDeps>, listId: string, requested: CategorizeMode) {
  const { supabase, categorizer, allowAiCall } = deps;

  // A re-scan the user asked for stays owed until one gets an AI answer, so every run
  // re-scans until then. Read under the lock: a later request changes the value.
  const { data: listData, error: listError } = await supabase
    .from("lists")
    .select("categories_rescan_at")
    .eq("id", listId)
    .maybeSingle();
  if (listError) console.error("[Categorizer] could not read the owed re-scan", { listId, error: listError });
  const owed = (listData as { categories_rescan_at?: string | null } | null)?.categories_rescan_at ?? null;
  const mode: CategorizeMode = owed ? "rescan" : requested;
  // Compare-and-swap: a re-scan asked for while this one ran stays owed.
  const settleOwed = async () => {
    if (!owed) return;
    const { error } = await supabase
      .from("lists")
      .update({ categories_rescan_at: null })
      .eq("id", listId)
      .eq("categories_rescan_at", owed);
    if (error) console.error("[Categorizer] could not clear the owed re-scan", { listId, error });
  };

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
    .select("id, text, completed, category_id, category_locked, deleted_at, created_at")
    .eq("list_id", listId);
  if (itemError) {
    console.error("[Categorizer] could not load items", { listId, error: itemError });
    return;
  }
  const rows = (itemData ?? []) as ItemRow[];

  // A hand-placed item keeps its category, unless that category is gone (a manual move
  // that raced a category delete leaves it locked with no category): sort it again.
  const targets = rows.filter(
    (r) =>
      !r.deleted_at &&
      (!r.category_locked || !r.category_id) &&
      (mode === "rescan" || !r.category_id)
  );
  if (targets.length === 0) {
    await settleOwed();
    return;
  }

  const assignments: Assignment[] = [];
  let answered = false;
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

  // Items still to buy first, then the newest. Pending items left out stay uncategorized
  // for the next run (the GET sweep); in a rescan they keep their current category.
  const batch = remaining
    .slice()
    .sort((a, b) => Number(a.completed) - Number(b.completed) || b.created_at.localeCompare(a.created_at))
    .slice(0, AI_BATCH_LIMIT);

  if (batch.length > 0) {
    if (!(await allowAiCall(listId))) {
      console.warn("[Categorizer] AI limit reached", { listId });
    } else {
      const keyed = categories.map((c, k) => ({ key: `c${k + 1}`, id: c.id, name: c.name_en }));
      const room = MAX_CATEGORIES_PER_LIST - categories.length;
      const result = await categorizer.categorize({
        categories: keyed.map(({ key, name }) => ({ key, name })),
        items: batch.map((r, i) => ({ i, text: r.text })),
        allowNew: room > 0,
        maxNew: Math.max(room, 0),
      });
      if (result) {
        answered = true;
        const keyToId = new Map(keyed.map((k) => [k.key, k.id]));
        // The RPC places each one against the list's current positions under the list lock.
        // after=null ones lead, each after the end of the leading run so far, and one chained
        // onto that end joins the run: a first scan keeps the AI's walk order. An `after`
        // that is not a category (yet) goes last.
        let leadingEnd: string | null = null;
        for (const created of result.newCategories) {
          const afterId: string | null = created.after === null ? leadingEnd : keyToId.get(created.after) ?? null;
          const placement = afterId ? "after" : created.after === null ? "first" : "last";
          const { data: insertedRows, error: insertError } = await supabase.rpc("insert_list_category", {
            p_list_id: listId,
            p_name_en: created.en,
            p_name_he: created.he,
            p_name_ru: created.ru,
            p_created_by: null,
            p_placement: placement,
            p_after_id: afterId,
            p_max: MAX_CATEGORIES_PER_LIST,
          });
          if (insertError) console.error("[Categorizer] category insert failed", { listId, error: insertError });
          const inserted = (Array.isArray(insertedRows) ? insertedRows[0] : insertedRows) as { id?: string } | null | undefined;
          // No row: the list reached the cap meanwhile. Its items stay uncategorized.
          if (!inserted?.id) continue;
          keyToId.set(created.ref, inserted.id);
          if (created.after === null || (afterId && afterId === leadingEnd)) leadingEnd = inserted.id;
        }
        for (const a of result.assignments) {
          const categoryId = keyToId.get(a.category);
          const item = batch[a.i];
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
    if (error) {
      console.error("[Categorizer] apply failed", { listId, error });
      return;
    }
  }
  if (answered) await settleOwed();
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The lock and the mode to run in, or null when another run holds the lock. */
async function takeLock(lock: ListLock, listId: string, mode: CategorizeMode) {
  const token = await lock.acquire(listId);
  if (token) return { token, mode };
  await lock.requestRerun(listId, mode);
  // The holder looks for requests after it releases. If it released and looked between
  // our attempt and our request, nobody would see the request: try once more.
  const retry = await lock.acquire(listId);
  if (!retry) return null;
  // Our request and any other waiting one: a re-scan wins.
  const waiting = await lock.takeRerun(listId);
  return { token: retry, mode: waiting === "rescan" ? "rescan" : mode };
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
      now: deps.now ?? Date.now,
      settleMs: deps.settleMs ?? SETTLE_MS,
    };
    const started = full.now();
    const { data: list } = await full.supabase
      .from("lists")
      .select("type")
      .eq("id", listId)
      .is("deleted_at", null)
      .maybeSingle();
    if ((list as { type?: string } | null)?.type !== "grocery") return;

    // The lock is taken per round, so each round gets a fresh expiry however slow the AI
    // is. A trigger that finds it held leaves a request, and the holder looks for one
    // after releasing, so a request made while it was releasing is not missed.
    let next: CategorizeMode | null = mode;
    for (let round = 0; next; round++) {
      const held = await takeLock(full.lock, listId, next);
      if (!held) return;
      try {
        if (round === 0 && held.mode === "pending" && full.settleMs > 0) await sleep(full.settleMs);
        await runOnce(full, listId, held.mode);
      } finally {
        await full.lock.release(listId, held.token);
      }
      // Out of time: a waiting request stays for the next trigger or the client's retry.
      if (full.now() - started >= RUN_BUDGET_MS) return;
      next = await full.lock.takeRerun(listId);
    }
  } catch (error) {
    console.error("[Categorizer] categorizeList failed", { listId, mode }, error);
  }
}
