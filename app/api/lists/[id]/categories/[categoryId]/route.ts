import { NextRequest, NextResponse, after } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";
import { parseBody } from "@/src/lib/api-validation";
import { categoryNameSchema } from "@/src/schemas/categories";
import { getCategorizer } from "@/src/services/categorizer";
import { categorizeList } from "@/src/services/categorize-list";

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

  const translated = (await getCategorizer().translateName(name)) ?? { en: name, he: name, ru: name };
  const names = { ...translated, [locale]: name };

  const { data: category } = await createServerClient()
    .from("list_categories")
    .update({ name_en: names.en, name_he: names.he, name_ru: names.ru })
    .eq("id", categoryId)
    .eq("list_id", listId)
    .select("id, list_id, name_en, name_he, name_ru, position, created_by")
    .maybeSingle();
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
