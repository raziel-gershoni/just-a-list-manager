import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";
import { findRecyclableItems, recycleItem } from "@/src/services/item-recycler";
import { createItemIdempotentSchema, createItemSchema, updateItemSchema } from "@/src/schemas/items";
import { parseBody } from "@/src/lib/api-validation";

// Upper bound for position values. Requires BIGINT column (migration 010).
const MAX_SAFE_POSITION = Number.MAX_SAFE_INTEGER;

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

  let query = supabase
    .from("items")
    .select("id, text, completed, completed_at, deleted_at, skipped_at, position, created_by, edited_by, created_at, users!created_by(name), editor:users!edited_by(name)")
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

    const text = parsed.data.text.trim();
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
      .map((t: string) => t.trim())
      .filter((t: string) => t.length > 0 && t.length <= 500);
  } else if (Array.isArray(parsedCreate.data.items)) {
    itemTexts = parsedCreate.data.items
      .map((item) => item.text.trim())
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
      (r) => r.text.toLowerCase() === text.toLowerCase()
    );

    if (exactMatch && parsedCreate.data.recycleId) {
      // Explicit recycle request from UI autocomplete
      const recycled = await recycleItem(parsedCreate.data.recycleId, auth.userId);
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
  const patchData: Record<string, unknown> = {};

  if (typeof updates.completed === "boolean") {
    patchData.completed = updates.completed;
    patchData.completed_at = updates.completed
      ? new Date().toISOString()
      : null;
  }

  if (typeof updates.text === "string" && updates.text.trim().length > 0 && updates.text.trim().length <= 500) {
    patchData.text = updates.text.trim();
    patchData.edited_by = auth.userId;
  }

  if (typeof updates.position === "number" && Number.isFinite(updates.position) && updates.position > 0 && updates.position <= MAX_SAFE_POSITION) {
    patchData.position = updates.position;
  }

  if (typeof updates.skipped === "boolean") {
    patchData.skipped_at = updates.skipped ? new Date().toISOString() : null;
  }

  // Allow restoring soft-deleted items (undo support)
  if (updates.deleted_at === null) {
    patchData.deleted_at = null;
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

  // Cancel active reminders when item is completed
  if (patchData.completed === true) {
    await supabase
      .from("item_reminders")
      .update({ cancelled_at: new Date().toISOString() })
      .eq("item_id", itemId)
      .is("cancelled_at", null);
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

  // Cancel all reminders for the deleted item (sent and unsent)
  await supabase
    .from("item_reminders")
    .update({ cancelled_at: new Date().toISOString() })
    .eq("item_id", itemId)
    .is("cancelled_at", null);

  return NextResponse.json({ success: true });
}
