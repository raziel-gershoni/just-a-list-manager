import { NextRequest, NextResponse, after } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";
import { findRecyclableItems, recycleItem } from "@/src/services/item-recycler";
import { createItemIdempotentSchema, createItemSchema, updateItemSchema } from "@/src/schemas/items";
import { parseBody } from "@/src/lib/api-validation";
import { normalizeForCompare, normalizeForStorage } from "@/src/utils/text-normalize";
import { pickRecyclable } from "@/src/utils/pick-recyclable";
import { completeItemRespectingRecurrence, isPureCompletion } from "@/src/services/recurring";
import { categorizeList } from "@/src/services/categorize-list";

// Upper bound for position values. Requires BIGINT column (migration 010).
const MAX_SAFE_POSITION = Number.MAX_SAFE_INTEGER;

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

  const { data: items, error } = await query;

  if (error) {
    return NextResponse.json({ error: "Failed to fetch items" }, { status: 500 });
  }

  const nextCursor =
    items && items.length === limit
      ? items[items.length - 1].position
      : null;

  // Sweep: first scan after deploy, lists switched to grocery, and failed runs.
  if ((items || []).some((i) => !i.category_id)) scheduleCategorize(supabase, listId);

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

  const body = await request.json();
  const supabase = createServerClient();

  // Idempotent single-item create (from mutation queue replay)
  if (body.idempotencyKey && typeof body.text === "string") {
    const parsed = parseBody(createItemIdempotentSchema, body);
    if (!parsed.success) return parsed.response;

    const text = normalizeForStorage(parsed.data.text);
    if (!text) {
      return NextResponse.json(
        { error: "Item text is required (max 500 chars)" },
        { status: 400 }
      );
    }

    // Check for existing item with same idempotency key
    const { data: existing } = await supabase
      .from("items")
      .select()
      .eq("list_id", listId)
      .eq("idempotency_key", parsed.data.idempotencyKey)
      .single();

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
      const { data: maxPosResult } = await supabase
        .from("items")
        .select("position")
        .eq("list_id", listId)
        .order("position", { ascending: false })
        .limit(1);
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
      .then(() => {}, () => {});

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

  // Get current max position
  const { data: maxPosResult } = await supabase
    .from("items")
    .select("position")
    .eq("list_id", listId)
    .order("position", { ascending: false })
    .limit(1);

  let nextPosition = (maxPosResult?.[0]?.position || 0) + 1;

  const results: Record<string, unknown>[] = [];
  let skipped = 0;
  let limitReached = false;

  for (const text of itemTexts) {
    if (limitReached) {
      skipped++;
      continue;
    }

    // Check for recyclable items
    const recyclable = await findRecyclableItems(listId, text);
    const exactMatch = recyclable.find(
      (r) => normalizeForCompare(r.text) === normalizeForCompare(text)
    );

    // Explicit recycle request from UI autocomplete. The client-supplied recycleId is
    // never trusted directly — it must resolve against `recyclable`, the set the server
    // itself just looked up for this list (list-scoped, completed-only). Otherwise a
    // client could pass any uuid and recycleItem would resurrect/re-attribute an
    // arbitrary row in someone else's list.
    const toRecycle = exactMatch && pickRecyclable(recyclable, parsedCreate.data.recycleId);
    if (toRecycle) {
      const recycled = await recycleItem(toRecycle.id, auth.userId, listId);
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
      continue;
    }

    const item = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
    if (item) {
      results.push({ ...item, recycled: false });
    }
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

  const body = await request.json();
  const parsed = parseBody(updateItemSchema, body);
  if (!parsed.success) return parsed.response;

  const { itemId, ...updates } = parsed.data;

  const supabase = createServerClient();

  if (updates.categoryId) {
    const { data: category } = await supabase
      .from("list_categories")
      .select("id")
      .eq("id", updates.categoryId)
      .eq("list_id", listId)
      .maybeSingle();
    if (!category) {
      return NextResponse.json({ error: "Unknown category" }, { status: 400 });
    }
  }

  // A pure "mark completed" on an item with a live recurring reminder must advance
  // the series, whoever completes it. A collaborator's client can't take the
  // complete-recurring route itself: it never sees someone else's reminder
  // (reminders GET is scoped to created_by = caller).
  if (isPureCompletion(updates)) {
    const outcome = await completeItemRespectingRecurrence(supabase, { itemId, listId });
    if (outcome.status === "error") {
      // 500 so the client mutation queue retries (it drops 4xx); the helper
      // already released its claim, so the retry can win again.
      return NextResponse.json({ error: "Failed to complete item" }, { status: 500 });
    }
    if (outcome.status !== "not-recurring") {
      // created or already-completed: respond as the plain path would
      const { data: done } = await supabase
        .from("items").select().eq("id", itemId).eq("list_id", listId).single();
      return NextResponse.json(done ?? { id: itemId, completed: true });
    }
  }

  const patchData: Record<string, unknown> = {};

  if (typeof updates.completed === "boolean") {
    patchData.completed = updates.completed;
    patchData.completed_at = updates.completed
      ? new Date().toISOString()
      : null;
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
    patchData.skipped_at = updates.skipped ? new Date().toISOString() : null;
    if (updates.skipped) patchData.ordered_at = null; // mutually exclusive states
  }

  if (typeof updates.ordered === "boolean") {
    patchData.ordered_at = updates.ordered ? new Date().toISOString() : null;
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

  const { data: item, error } = await query.select().single();

  if (error || !item) {
    return NextResponse.json(
      { error: "Item not found or update failed" },
      { status: 404 }
    );
  }

  // A text change re-sorts the item, unless a person placed it by hand. Guarded on the
  // new text so a later edit's own run is never undone by this one.
  if (typeof patchData.text === "string" && !updates.categoryId && item.category_locked === false) {
    await supabase
      .from("items")
      .update({ category_id: null })
      .eq("id", itemId)
      .eq("list_id", listId)
      .eq("category_locked", false)
      .eq("text", patchData.text);
    scheduleCategorize(supabase, listId);
  }

  // Don't cancel reminders on completion — the cron handles cleanup for completed items,
  // and the frontend needs the reminder to display the original time in the done section.

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

  const supabase = createServerClient();

  // Soft-delete for undo support
  const { error } = await supabase
    .from("items")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", itemId)
    .eq("list_id", listId);

  if (error) {
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }

  // Deliberately does NOT cancel reminders on the deleted item. Both undo
  // paths that restore from this soft-delete (useItemHandlers.ts single-delete
  // undo and remove-duplicates undo) only ever PATCH deleted_at back to null,
  // never un-cancel anything — so cancelling here made undo lossy (identical
  // bug to the one 9551051 removed from clear-completed). It's safe to leave
  // the reminder alone: if the item was completed first (deleting from the
  // done section), the cron checks item.completed FIRST and silently stamps
  // sent_at whenever the reminder comes due; its deleted_at branch right
  // after is only the fallback for a row deleted without ever being
  // completed, which cancels it instead (app/api/cron/reminders/route.ts).
  // Either way the digest skips items with no live reminders, so nothing
  // ever fires for a row that stays deleted.
  return NextResponse.json({ success: true });
}
