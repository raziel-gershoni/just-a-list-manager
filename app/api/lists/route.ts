import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";

export async function GET(request: NextRequest) {
  const auth = await verifyUserAuth(request, apiRateLimiter, "lists-get");
  if (!auth.success) return auth.response;

  const supabase = createServerClient();

  // Lists where user is owner
  const { data: ownedLists } = await supabase
    .from("lists")
    .select("id, name, owner_id, created_at, updated_at")
    .eq("owner_id", auth.userId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });

  // Lists where user is approved collaborator
  const { data: collabRecords } = await supabase
    .from("collaborators")
    .select("list_id, permission")
    .eq("user_id", auth.userId)
    .eq("status", "approved");

  const collabListIds = (collabRecords || []).map((c) => c.list_id);
  let collabLists: any[] = [];

  if (collabListIds.length > 0) {
    const { data } = await supabase
      .from("lists")
      .select("id, name, owner_id, created_at, updated_at")
      .in("id", collabListIds)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false });
    collabLists = data || [];
  }

  // Merge and deduplicate
  const allLists = [...(ownedLists || []), ...collabLists];
  const uniqueLists = Array.from(
    new Map(allLists.map((l) => [l.id, l])).values()
  );

  // Get item counts for all lists in a single query
  const listIds = uniqueLists.map((l) => l.id);
  const countsMap = new Map<string, { active_count: number; completed_count: number }>();

  if (listIds.length > 0) {
    const { data: counts } = await supabase.rpc("get_list_item_counts", {
      p_list_ids: listIds,
    });
    if (counts) {
      for (const row of counts) {
        countsMap.set(row.list_id, {
          active_count: Number(row.active_count),
          completed_count: Number(row.completed_count),
        });
      }
    }
  }

  // Determine which lists are shared (have approved collaborators)
  const sharedSet = new Set<string>();
  if (listIds.length > 0) {
    const { data: sharedRows } = await supabase
      .from("collaborators")
      .select("list_id")
      .in("list_id", listIds)
      .eq("status", "approved");
    for (const row of sharedRows || []) {
      sharedSet.add(row.list_id);
    }
  }

  const listsWithCounts = uniqueLists.map((list) => {
    const counts = countsMap.get(list.id) || { active_count: 0, completed_count: 0 };
    const role =
      list.owner_id === auth.userId
        ? "owner"
        : (collabRecords || []).find((c) => c.list_id === list.id)
            ?.permission || "view";

    return {
      ...list,
      ...counts,
      role,
      is_shared: role !== "owner" || sharedSet.has(list.id),
    };
  });

  return NextResponse.json(listsWithCounts);
}

export async function POST(request: NextRequest) {
  const auth = await verifyUserAuth(request, apiRateLimiter, "lists-create");
  if (!auth.success) return auth.response;

  const body = await request.json();
  const name = body.name?.trim();

  if (!name || name.length > 100) {
    return NextResponse.json(
      { error: "List name is required (max 100 characters)" },
      { status: 400 }
    );
  }

  const supabase = createServerClient();

  // Enforce max 50 lists per user
  const { count } = await supabase
    .from("lists")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", auth.userId)
    .is("deleted_at", null);

  if ((count || 0) >= 50) {
    return NextResponse.json(
      {
        error:
          "You've reached the 50-list limit. Delete a list to create more.",
      },
      { status: 400 }
    );
  }

  const { data: list, error } = await supabase
    .from("lists")
    .insert({ name, owner_id: auth.userId })
    .select()
    .single();

  if (error) {
    console.error("[Lists] Create error:", error);
    return NextResponse.json(
      { error: "Failed to create list" },
      { status: 500 }
    );
  }

  return NextResponse.json(list, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const auth = await verifyUserAuth(request, apiRateLimiter, "lists-rename");
  if (!auth.success) return auth.response;

  const body = await request.json();
  const { id, restore } = body;

  if (!id) {
    return NextResponse.json(
      { error: "List ID is required" },
      { status: 400 }
    );
  }

  const supabase = createServerClient();

  // Restore (undelete) flow
  if (restore) {
    const { data: list } = await supabase
      .from("lists")
      .select("owner_id")
      .eq("id", id)
      .not("deleted_at", "is", null)
      .single();

    if (!list || list.owner_id !== auth.userId) {
      return NextResponse.json(
        { error: "Not found or not authorized" },
        { status: 403 }
      );
    }

    const { data: restored, error } = await supabase
      .from("lists")
      .update({ deleted_at: null })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: "Restore failed" }, { status: 500 });
    }

    return NextResponse.json(restored);
  }

  // Rename flow
  const { name } = body;

  if (!name?.trim() || name.trim().length > 100) {
    return NextResponse.json(
      { error: "List name required (max 100 chars)" },
      { status: 400 }
    );
  }

  // Only owner can rename
  const { data: list } = await supabase
    .from("lists")
    .select("owner_id")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  if (!list || list.owner_id !== auth.userId) {
    return NextResponse.json(
      { error: "Not found or not authorized" },
      { status: 403 }
    );
  }

  const { data: updated, error } = await supabase
    .from("lists")
    .update({ name: name.trim() })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  return NextResponse.json(updated);
}

export async function DELETE(request: NextRequest) {
  const auth = await verifyUserAuth(request, apiRateLimiter, "lists-delete");
  if (!auth.success) return auth.response;

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json(
      { error: "Missing list ID" },
      { status: 400 }
    );
  }

  const supabase = createServerClient();

  // Only owner can delete
  const { data: list } = await supabase
    .from("lists")
    .select("owner_id")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  if (!list || list.owner_id !== auth.userId) {
    return NextResponse.json(
      { error: "Not found or not authorized" },
      { status: 403 }
    );
  }

  // Soft delete
  const { error } = await supabase
    .from("lists")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
