import { NextRequest, NextResponse, after } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";
import { parseBody } from "@/src/lib/api-validation";
import { categoryNameSchema } from "@/src/schemas/categories";
import { categorizeList } from "@/src/services/categorize-list";
import { categoryNames } from "@/src/services/category-names";

const COLUMNS = "id, list_id, name_en, name_he, name_ru, position, created_by";

type Params = { params: Promise<{ id: string; categoryId: string }> };

async function authorize(
  request: NextRequest,
  listId: string,
  endpoint: string
): Promise<{ response: NextResponse } | { userId: string }> {
  const auth = await verifyUserAuth(request, apiRateLimiter, endpoint);
  if (!auth.success) return { response: auth.response };
  const perm = await verifyListPermission(auth.userId, listId, "edit");
  if (!perm.allowed) {
    return { response: NextResponse.json({ error: "You don't have permission to edit this list" }, { status: 403 }) };
  }
  return { userId: auth.userId };
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id: listId, categoryId } = await params;
  const authz = await authorize(request, listId, "categories-rename");
  if ("response" in authz) return authz.response;

  const parsed = parseBody(categoryNameSchema, await request.json().catch(() => null));
  if (!parsed.success) return parsed.response;
  const { name, locale } = parsed.data;

  // Read first: an unknown category, or a name that did not change, costs no AI call.
  const supabase = createServerClient();
  const { data: current, error: readError } = await supabase
    .from("list_categories")
    .select(COLUMNS)
    .eq("id", categoryId)
    .eq("list_id", listId)
    .maybeSingle();
  if (readError) return NextResponse.json({ error: "Failed to rename category" }, { status: 500 });
  if (!current) return NextResponse.json({ error: "Category not found" }, { status: 404 });
  if ((current as Record<string, unknown>)[`name_${locale}`] === name) {
    return NextResponse.json({ category: current });
  }

  const names = await categoryNames(name, locale, authz.userId);
  const { data: category, error } = await supabase
    .from("list_categories")
    .update({ name_en: names.en, name_he: names.he, name_ru: names.ru })
    .eq("id", categoryId)
    .eq("list_id", listId)
    .select(COLUMNS)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Failed to rename category" }, { status: 500 });
  if (!category) return NextResponse.json({ error: "Category not found" }, { status: 404 });
  return NextResponse.json({ category });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const { id: listId, categoryId } = await params;
  const authz = await authorize(request, listId, "categories-delete");
  if ("response" in authz) return authz.response;

  const supabase = createServerClient();
  // Hand-placed items must be unlocked too, or they would sit uncategorized forever.
  const { error: releaseError } = await supabase
    .from("items")
    .update({ category_id: null, category_locked: false })
    .eq("category_id", categoryId)
    .eq("list_id", listId);
  if (releaseError) return NextResponse.json({ error: "Failed to delete category" }, { status: 500 });

  const { error } = await supabase
    .from("list_categories")
    .delete()
    .eq("id", categoryId)
    .eq("list_id", listId);
  if (error) return NextResponse.json({ error: "Failed to delete category" }, { status: 500 });

  after(() => categorizeList({ supabase }, listId, "pending"));
  return NextResponse.json({ success: true });
}
