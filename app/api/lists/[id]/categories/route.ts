import { NextRequest, NextResponse, after } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";
import { parseBody } from "@/src/lib/api-validation";
import { categoryNameSchema } from "@/src/schemas/categories";
import { MAX_CATEGORIES_PER_LIST } from "@/src/services/categorizer";
import { categorizeList } from "@/src/services/categorize-list";
import { categoryNames } from "@/src/services/category-names";

const COLUMNS = "id, list_id, name_en, name_he, name_ru, position, created_by";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: listId } = await params;
  const auth = await verifyUserAuth(request, apiRateLimiter, "categories-get");
  if (!auth.success) return auth.response;
  const perm = await verifyListPermission(auth.userId, listId, "view");
  if (!perm.allowed) return NextResponse.json({ error: "Access denied" }, { status: 403 });

  const { data, error } = await createServerClient()
    .from("list_categories")
    .select(COLUMNS)
    .eq("list_id", listId)
    .order("position", { ascending: true });
  if (error) return NextResponse.json({ error: "Failed to load categories" }, { status: 500 });
  return NextResponse.json({ categories: data ?? [] });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: listId } = await params;
  const auth = await verifyUserAuth(request, apiRateLimiter, "categories-create");
  if (!auth.success) return auth.response;
  const perm = await verifyListPermission(auth.userId, listId, "edit");
  if (!perm.allowed) {
    return NextResponse.json({ error: "You don't have permission to edit this list" }, { status: 403 });
  }

  const parsed = parseBody(categoryNameSchema, await request.json().catch(() => null));
  if (!parsed.success) return parsed.response;
  const { name, locale } = parsed.data;

  const names = await categoryNames(name, locale, auth.userId);

  // The cap check and the position are taken under the list row lock, so concurrent adds
  // cannot pass the cap together or tie.
  const supabase = createServerClient();
  const { data: rows, error } = await supabase.rpc("insert_list_category", {
    p_list_id: listId,
    p_name_en: names.en,
    p_name_he: names.he,
    p_name_ru: names.ru,
    p_created_by: auth.userId,
    p_placement: "last",
    p_after_id: null,
    p_max: MAX_CATEGORIES_PER_LIST,
  });
  if (error) return NextResponse.json({ error: "Failed to create category" }, { status: 500 });
  const category = Array.isArray(rows) ? rows[0] : rows;
  if (!category) {
    return NextResponse.json({ error: "A list can have at most 20 categories" }, { status: 400 });
  }

  // A new category can change where existing items belong: re-sort the whole list. The
  // owed re-scan is remembered, so one the AI budget refuses now runs on a later sweep.
  const { error: owedError } = await supabase
    .from("lists")
    .update({ categories_rescan_at: new Date().toISOString() })
    .eq("id", listId);
  if (owedError) console.error("[categories/POST] could not record the owed re-scan", { listId, error: owedError });
  after(() => categorizeList({ supabase }, listId, "rescan"));
  return NextResponse.json({ category }, { status: 201 });
}
