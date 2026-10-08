/** A list's category limit, shared by the server (cap checks) and the Categories sheet. */
export const MAX_CATEGORIES_PER_LIST = 20;

export interface ListCategory {
  id: string;
  list_id: string;
  name_en: string;
  name_he: string;
  name_ru: string;
  position: number;
  created_by: string | null;
}

type Names = Pick<ListCategory, "name_en" | "name_he" | "name_ru">;

/** The category name in the viewer's language, else any non-empty name. */
export function categoryLabel(category: Names, locale: string): string {
  const preferred =
    locale === "he" ? category.name_he : locale === "ru" ? category.name_ru : category.name_en;
  for (const name of [preferred, category.name_en, category.name_he, category.name_ru]) {
    const trimmed = name?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}
