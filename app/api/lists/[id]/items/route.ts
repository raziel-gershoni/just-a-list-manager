import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";
import { findRecyclableItems, recycleItem } from "@/src/services/item-recycler";

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
    .select("id, text, completed, completed_at, deleted_at, position, created_by, edited_by, created_at, users!created_by(name), editor:users!edited_by(name)")
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

  // Support single item or comma-separated group
  let itemTexts: string[] = [];
  if (body.text) {
    itemTexts = body.text
      .split(",")
      .map((t: string) => t.trim())
      .filter((t: string) => t.length > 0 && t.length <= 500);
  } else if (Array.isArray(body.items)) {
    itemTexts = body.items
      .map((t: string) => t.trim())
      .filter((t: string) => t.length > 0 && t.length <= 500);
  }

  if (itemTexts.length === 0) {
    return NextResponse.json(
      { error: "Item text is required" },
      { status: 400 }
    );
  }

  // Check item count limit (500 per list)
  const { count: currentCount } = await supabase
    .from("items")
    .select("id", { count: "exact", head: true })
    .eq("list_id", listId)
    .is("deleted_at", null);

  const available = 500 - (currentCount || 0);
  const toProcess = itemTexts.slice(0, Math.max(0, available));
  const skipped = itemTexts.length - toProcess.length;

  // Get current max position
  const { data: maxPosResult } = await supabase
    .from("items")
    .select("position")
    .eq("list_id", listId)
    .order("position", { ascending: false })
    .limit(1);

  let nextPosition = (maxPosResult?.[0]?.position || 0) + 1;

  const results: any[] = [];

  for (const text of toProcess) {
    // Check for recyclable items
    const recyclable = await findRecyclableItems(listId, text);
    const exactMatch = recyclable.find(
      (r) => r.text.toLowerCase() === text.toLowerCase()
    );

    if (exactMatch && body.recycleId) {
      // Explicit recycle request from UI autocomplete
      const recycled = await recycleItem(body.recycleId);
      if (recycled) {
        results.push({ ...recycled, recycled: true });
        continue;
      }
    }

    // Create new item
    const { data: item, error } = await supabase
      .from("items")
      .insert({
        list_id: listId,
        text,
        position: nextPosition++,
        created_by: auth.userId,
      })
      .select()
      .single();

    if (item) {
      results.push({ ...item, recycled: false });
    }
  }

  const response: any = { items: results };
  if (skipped > 0) {
    response.warning = `Added ${toProcess.length} items. ${skipped} items skipped — this list has a 500-item limit.`;
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
  const { itemId, ...updates } = body;

  if (!itemId) {
    return NextResponse.json(
      { error: "Missing itemId" },
      { status: 400 }
    );
  }

  const supabase = createServerClient();
  const patchData: Record<string, any> = {};

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

  if (typeof updates.position === "number") {
    patchData.position = updates.position;
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

  return NextResponse.json({ success: true });
}
