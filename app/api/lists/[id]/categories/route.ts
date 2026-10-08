import { NextRequest, NextResponse, after } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";
import { parseBody } from "@/src/lib/api-validation";
import { categoryNameSchema } from "@/src/schemas/categories";
import { getCategorizer, MAX_CATEGORIES_PER_LIST } from "@/src/services/categorizer";
import { categorizeList } from "@/src/services/categorize-list";

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

  const supabase = createServerClient();
  const { data: existing, error: readError } = await supabase
    .from("list_categories")
    .select("id, position")
    .eq("list_id", listId);
  // A failed read is not an empty list: it would skip the cap and reuse position 0.
  if (readError) return NextResponse.json({ error: "Failed to create category" }, { status: 500 });
  const rows = (existing ?? []) as { id: string; position: number }[];
  if (rows.length >= MAX_CATEGORIES_PER_LIST) {
    return NextResponse.json({ error: "A list can have at most 20 categories" }, { status: 400 });
  }

  const translated = (await getCategorizer().translateName(name)) ?? { en: name, he: name, ru: name };
  const names = { ...translated, [locale]: name };
  const position = rows.reduce((max, r) => Math.max(max, r.position + 1), 0);

  const { data: category, error } = await supabase
    .from("list_categories")
    .insert({ list_id: listId, name_en: names.en, name_he: names.he, name_ru: names.ru, position, created_by: auth.userId })
    .select(COLUMNS)
    .single();
  if (error || !category) return NextResponse.json({ error: "Failed to create category" }, { status: 500 });

  // A new category can change where existing items belong: re-sort the whole list.
  after(() => categorizeList({ supabase }, listId, "rescan"));
  return NextResponse.json({ category }, { status: 201 });
}
