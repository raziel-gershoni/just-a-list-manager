import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";
import { recycleItem, type RecyclableItem } from "@/src/services/item-recycler";
import { createItemIdempotentSchema, createItemSchema, updateItemSchema } from "@/src/schemas/items";
import { parseBody, readJsonBody } from "@/src/lib/api-validation";
import { dbError } from "@/src/lib/api-errors";
import { normalizeForStorage } from "@/src/utils/text-normalize";
import { categorizeList } from "@/src/services/categorize-list";

// Upper bound for position values. Requires BIGINT column (migration 010).
const MAX_SAFE_POSITION = Number.MAX_SAFE_INTEGER;

// How far back a tap time is honoured: the offline queue's own 24-hour limit.
const TAP_TIME_WINDOW_MS = 24 * 60 * 60 * 1000;

// The time for completed_at / skipped_at / ordered_at: when the user tapped (`at`), so a
// change replayed from the offline queue, or delivered twice, keeps the time it was made
// rather than the time it synced. Clamped to the last 24 hours and never in the future, so
// a wrong device clock can't push an item far out of order. A missing or unparseable `at`
// falls back to now.
function tapTime(at: string | undefined): string {
  const now = Date.now();
  const tapped = at ? Date.parse(at) : NaN;
  if (Number.isNaN(tapped)) return new Date(now).toISOString();
  return new Date(Math.min(now, Math.max(now - TAP_TIME_WINDOW_MS, tapped))).toISOString();
}

// Sort new or changed grocery items after the response (categorizeList skips other
// list types and never throws).
function scheduleCategorize(supabase: ReturnType<typeof createServerClient>, listId: string) {
  after(() => categorizeList({ supabase }, listId, "pending"));
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: listId } = await params;
  const auth = await verifyUserAuth(request, apiRateLimiter, "items-get");
  if (!auth.success) return auth.response;

  const perm = await verifyListPermission(auth.userId, listId, "view");
  if (!perm.allowed) {
    return NextResponse.json(
      { error: "Access denied" },
      { status: 403 }
    );
  }

  const supabase = createServerClient();
  const { searchParams } = new URL(request.url);
  const cursor = searchParams.get("cursor");
  const limit = Math.min(parseInt(searchParams.get("limit") || "200"), 500);

  // Active items only. Deleting is final — a soft-deleted row is never returned,
  // never respawns, and is purged by the 7-day cleanup cron.
  let query = supabase
    .from("items")
    .select("id, text, completed, completed_at, deleted_at, skipped_at, ordered_at, recurring, category_id, category_locked, position, created_by, edited_by, created_at, users!created_by(name), editor:users!edited_by(name)")
    .eq("list_id", listId)
    .is("deleted_at", null)
    .order("position", { ascending: false })
    .limit(limit);

  if (cursor) {
    query = query.lt("position", parseInt(cursor));
  }

  // The list's type and owed re-scan decide the sweep below; read alongside the items.
  const [{ data: items, error }, { data: list, error: listError }] = await Promise.all([
    query,
    supabase.from("lists").select("type, categories_rescan_at").eq("id", listId).maybeSingle(),
  ]);

  if (error) return dbError("items/GET", "Items read", error, { listId });
  // Only the sweep needs the list's type: without it, skip the sweep for this load.
  if (listError) console.warn("[items/GET] List type read failed, skipping the category sweep:", { listId }, listError);

  const nextCursor =
    items && items.length === limit
      ? items[items.length - 1].position
      : null;

  // Sweep grocery lists: first scan after deploy, failed runs, and a re-scan still owed.
  if (
    list?.type === "grocery" &&
    (list.categories_rescan_at || (items || []).some((i) => !i.category_id))
  ) {
    scheduleCategorize(supabase, listId);
  }

  return NextResponse.json({ items: items || [], nextCursor });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: listId } = await params;
  const auth = await verifyUserAuth(request, apiRateLimiter, "items-create");
  if (!auth.success) return auth.response;

  const perm = await verifyListPermission(auth.userId, listId, "edit");
  if (!perm.allowed) {
    return NextResponse.json(
      { error: "You don't have permission to edit this list" },
      { status: 403 }
    );
  }

  const body = await readJsonBody(request, "items/POST");
  // Both create paths read fields off the body before validating it, so anything that is not
  // a JSON object (unparseable, a literal null, a number) is refused here instead of throwing
  // a TypeError that the route would answer with an untagged 500.
  if (typeof body !== "object" || body === null) {
    console.warn("[items/POST] Request body is not a JSON object:", body === null ? "null" : typeof body);
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const fields = body as Record<string, unknown>;
  const supabase = createServerClient();

  // Idempotent single-item create (from mutation queue replay)
  if (fields.idempotencyKey && typeof fields.text === "string") {
    const parsed = parseBody(createItemIdempotentSchema, body);
    if (!parsed.success) return parsed.response;

    const text = normalizeForStorage(parsed.data.text);
    if (!text) {
      return NextResponse.json(
        { error: "Item text is required (max 500 chars)" },
        { status: 400 }
      );
    }

    // Check for existing item with same idempotency key. maybeSingle: no row is the normal
    // answer, so `error` is a real failure (500, the queue retries).
    const { data: existing, error: lookupError } = await supabase
      .from("items")
      .select()
      .eq("list_id", listId)
      .eq("idempotency_key", parsed.data.idempotencyKey)
      .maybeSingle();
    if (lookupError) return dbError("items/POST", "Idempotency lookup", lookupError, { listId });

    if (existing) {
      // Duplicate — return existing item without creating a new one
      return NextResponse.json(
        { items: [{ ...existing, recycled: false }] },
        { status: 200 }
      );
    }

    // Use client-provided position if available (avoids concurrent position collisions),
    // otherwise fall back to max+1
    let position = typeof parsed.data.position === "number" && Number.isFinite(parsed.data.position) && parsed.data.position > 0 && parsed.data.position <= MAX_SAFE_POSITION
      ? parsed.data.position
      : null;
    if (position === null) {
      const { data: maxPosResult, error: maxPosError } = await supabase
        .from("items")
        .select("position")
        .eq("list_id", listId)
        .order("position", { ascending: false })
        .limit(1);
      // Falling back to 1 would bury the new item at the bottom of the list.
      if (maxPosError) return dbError("items/POST", "Max position read", maxPosError, { listId });
      position = (maxPosResult?.[0]?.position || 0) + 1;
    }

    // Atomic count check + insert to prevent race condition on 500-item limit
    const { data: rpcRows, error } = await supabase.rpc("insert_item_if_under_limit", {
      p_list_id: listId,
      p_text: text,
      p_position: position,
      p_created_by: auth.userId,
      p_idempotency_key: parsed.data.idempotencyKey,
    });

    if (error) {
      console.error("[items/POST] RPC insert_item_if_under_limit error:", error);
      if (error.message?.includes("ITEM_LIMIT_REACHED")) {
        return NextResponse.json(
          { error: "This list has reached the 500-item limit." },
          { status: 400 }
        );
      }
      return NextResponse.json(
        { error: "Failed to create item" },
        { status: 500 }
      );
    }

    const item = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;

    if (!item) {
      console.error("[items/POST] RPC returned null item for list:", listId);
      return NextResponse.json(
        { error: "Failed to create item" },
        { status: 500 }
      );
    }

    // Piggyback cleanup: nullify old idempotency keys (>24h) to free unique constraint
    // Fire-and-forget — doesn't block the response
    supabase
      .from("items")
      .update({ idempotency_key: null })
      .eq("list_id", listId)
      .not("idempotency_key", "is", null)
      .lt("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .limit(10)
      .then(
        ({ error: cleanupError }) => {
          if (cleanupError) console.warn("[items/POST] Idempotency key cleanup failed, listId:", listId, cleanupError);
        },
        (err) => {
          console.warn("[items/POST] Idempotency key cleanup failed, listId:", listId, err);
        }
      );

    scheduleCategorize(supabase, listId);
    return NextResponse.json(
      { items: [{ ...item, recycled: false }] },
      { status: 201 }
    );
  }

  // Non-idempotent path: support single item or comma-separated group
  const parsedCreate = parseBody(createItemSchema, body);
  if (!parsedCreate.success) return parsedCreate.response;

  let itemTexts: string[] = [];
  if (parsedCreate.data.text) {
    itemTexts = parsedCreate.data.text
      .split(",")
      .map((t: string) => normalizeForStorage(t))
      .filter((t: string) => t.length > 0 && t.length <= 500);
  } else if (Array.isArray(parsedCreate.data.items)) {
    itemTexts = parsedCreate.data.items
      .map((item) => normalizeForStorage(item.text))
      .filter((t: string) => t.length > 0 && t.length <= 500);
  }

  if (itemTexts.length === 0) {
    return NextResponse.json(
      { error: "Item text is required" },
      { status: 400 }
    );
  }

  // Get current max position. Checked before the loop, so nothing is inserted or recycled
  // at a wrong position.
  const { data: maxPosResult, error: maxPosError } = await supabase
    .from("items")
    .select("position")
    .eq("list_id", listId)
    .order("position", { ascending: false })
    .limit(1);
  if (maxPosError) return dbError("items/POST", "Max position read", maxPosError, { listId });

  let nextPosition = (maxPosResult?.[0]?.position || 0) + 1;

  const results: Record<string, unknown>[] = [];
  let skipped = 0;
  let limitReached = false;
  // Items that failed for a reason other than the item limit, and the last such error.
  let failures = 0;
  let lastError: unknown = null;

  for (const text of itemTexts) {
    if (limitReached) {
      skipped++;
      continue;
    }

    // A suggestion tap names the item to recycle. recycleItem checks the client-supplied id
    // itself (this list, not deleted, same text): a completed item comes back to the top, one
    // that is already active (a replay, or another device was first) comes back unchanged, and
    // anything else answers null so the text is added as a new item. It logs and throws on a
    // DB error: skip the item then, the loop's rule for an insert error, so a failed check
    // never adds a duplicate.
    const recycleId = parsedCreate.data.recycleId;
    if (recycleId) {
      let recycled: RecyclableItem | null;
      try {
        recycled = await recycleItem(recycleId, auth.userId, listId, text);
      } catch (err) {
        console.error("[items/POST] Recycle check failed, skipping item (batch):", { listId }, err);
        failures++;
        lastError = err;
        continue;
      }
      if (recycled) {
        results.push({ ...recycled, recycled: true });
        continue;
      }
    }

    // Atomic count check + insert to prevent race condition on 500-item limit
    const { data: rpcRows, error } = await supabase.rpc("insert_item_if_under_limit", {
      p_list_id: listId,
      p_text: text,
      p_position: nextPosition++,
      p_created_by: auth.userId,
    });

    if (error) {
      console.error("[items/POST] RPC insert_item_if_under_limit error (batch):", error);
      if (error.message?.includes("ITEM_LIMIT_REACHED")) {
        limitReached = true;
        skipped++;
        continue;
      }
      // Other errors — skip this item but continue
      failures++;
      lastError = error;
      continue;
    }

    const item = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
    if (item) {
      results.push({ ...item, recycled: false });
    }
  }

  // Nothing written and something failed (not just the item limit): a 500 the queue retries.
  // Safe to retry, no item was created.
  if (results.length === 0 && failures > 0) {
    return dbError("items/POST", "Item create", lastError, { listId });
  }

  const response: { items: Record<string, unknown>[]; warning?: string } = { items: results };
  if (skipped > 0) {
    response.warning = `Added ${results.length} items. ${skipped} items skipped — this list has a 500-item limit.`;
  }

  if (results.length > 0) scheduleCategorize(supabase, listId);
  return NextResponse.json(response, { status: 201 });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: listId } = await params;
  const auth = await verifyUserAuth(request, apiRateLimiter, "items-update");
  if (!auth.success) return auth.response;

  const perm = await verifyListPermission(auth.userId, listId, "edit");
  if (!perm.allowed) {
    return NextResponse.json(
      { error: "You don't have permission to edit this list" },
      { status: 403 }
    );
  }

  const body = await readJsonBody(request, "items/PATCH");
  const parsed = parseBody(updateItemSchema, body);
  if (!parsed.success) return parsed.response;

  const { itemId, ...updates } = parsed.data;

  const supabase = createServerClient();

  if (updates.categoryId) {
    const { data: category, error: categoryError } = await supabase
      .from("list_categories")
      .select("id")
      .eq("id", updates.categoryId)
      .eq("list_id", listId)
      .maybeSingle();
    if (categoryError) {
      // 500, not 400: the mutation queue drops 4xx, and this move should be retried.
      return dbError("items/PATCH", "Category check", categoryError, { listId, categoryId: updates.categoryId });
    }
    if (!category) {
      return NextResponse.json({ error: "Unknown category" }, { status: 400 });
    }
  }

  const patchData: Record<string, unknown> = {};
  const stamp = tapTime(updates.at);

  if (typeof updates.completed === "boolean") {
    patchData.completed = updates.completed;
    patchData.completed_at = updates.completed ? stamp : null;
  }

  if (typeof updates.text === "string") {
    const canonical = normalizeForStorage(updates.text);
    if (canonical.length > 0 && canonical.length <= 500) {
      patchData.text = canonical;
      patchData.edited_by = auth.userId;
    }
  }

  if (typeof updates.position === "number" && Number.isFinite(updates.position) && updates.position > 0 && updates.position <= MAX_SAFE_POSITION) {
    patchData.position = updates.position;
  }

  if (typeof updates.skipped === "boolean") {
    patchData.skipped_at = updates.skipped ? stamp : null;
    if (updates.skipped) patchData.ordered_at = null; // mutually exclusive states
  }

  if (typeof updates.ordered === "boolean") {
    patchData.ordered_at = updates.ordered ? stamp : null;
    if (updates.ordered) patchData.skipped_at = null; // mutually exclusive states
  }

  if (typeof updates.recurring === "boolean") {
    patchData.recurring = updates.recurring;
  }

  // Bring a recurring item back to active: clear all "out-of-active" flags atomically.
  // deleted_at is deliberately NOT cleared — deleting is final, and leaving it out
  // means the `.is("deleted_at", null)` guard below still applies to this branch,
  // so a stale queued restore can never resurrect a row someone has since deleted.
  if (updates.restoreRecurring === true) {
    patchData.completed = false;
    patchData.completed_at = null;
    patchData.skipped_at = null;
    patchData.ordered_at = null;
    patchData.position = Date.now();
  }

  // Allow restoring soft-deleted items (undo support)
  if (updates.deleted_at === null) {
    patchData.deleted_at = null;
  }

  if (updates.categoryId) {
    patchData.category_id = updates.categoryId;
    patchData.category_locked = true;
  }

  if (Object.keys(patchData).length === 0) {
    return NextResponse.json(
      { error: "No valid fields to update" },
      { status: 400 }
    );
  }

  // Omit deleted_at filter when restoring (undo), otherwise only target active items
  let query = supabase
    .from("items")
    .update(patchData)
    .eq("id", itemId)
    .eq("list_id", listId);

  if (patchData.deleted_at !== null) {
    query = query.is("deleted_at", null);
  }

  // maybeSingle: zero rows (missing, or already deleted) is { data: null, error: null },
  // so `error` is always a real DB failure. That must be a 500, which the queue retries;
  // a 404 would make it drop the change.
  const { data: item, error } = await query.select().maybeSingle();

  if (error) return dbError("items/PATCH", "Item update", error, { listId, itemId });
  if (!item) {
    console.warn("[items/PATCH] Item not found:", { listId, itemId });
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  // A text change re-sorts the item, unless a person placed it by hand. Guarded on the
  // new text so a later edit's own run is never undone by this one.
  if (typeof patchData.text === "string" && !updates.categoryId && item.category_locked === false) {
    const { error: resetError } = await supabase
      .from("items")
      .update({ category_id: null })
      .eq("id", itemId)
      .eq("list_id", listId)
      .eq("category_locked", false)
      .eq("text", patchData.text);
    // The edit is saved, but a 500 makes the queue replay it, and the replay redoes the
    // reset. Otherwise the item keeps its old category for good.
    if (resetError) return dbError("items/PATCH", "Category reset", resetError, { listId, itemId });
    scheduleCategorize(supabase, listId);
  }

  return NextResponse.json(item);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: listId } = await params;
  const auth = await verifyUserAuth(request, apiRateLimiter, "items-delete");
  if (!auth.success) return auth.response;

  const perm = await verifyListPermission(auth.userId, listId, "edit");
  if (!perm.allowed) {
    return NextResponse.json(
      { error: "You don't have permission to edit this list" },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(request.url);
  const itemId = searchParams.get("itemId");

  if (!itemId) {
    return NextResponse.json(
      { error: "Missing itemId" },
      { status: 400 }
    );
  }

  // A still-pending item carries a temp-... id. The uuid column rejects it (22P02), which
  // would be a 500 the queue retries for 24 hours; a 400 is dropped at once.
  if (!z.string().uuid().safeParse(itemId).success) {
    console.warn("[items/DELETE] Invalid item id:", { listId });
    return NextResponse.json({ error: "Invalid item id" }, { status: 400 });
  }

  const supabase = createServerClient();

  // Soft-delete for undo support
  const { error } = await supabase
    .from("items")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", itemId)
    .eq("list_id", listId);

  if (error) return dbError("items/DELETE", "Delete", error, { listId, itemId });

  return NextResponse.json({ success: true });
}
