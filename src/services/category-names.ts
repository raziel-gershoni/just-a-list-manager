/**
 * The three names of a category a person typed. Translation is an AI call, so it runs
 * only within the user's and the app-wide budgets (both fail-closed); otherwise, or when
 * it fails, the typed name is used for every language. The typed name always stays in
 * the user's language.
 */

import { getCategorizer, type CategoryNames } from "@/src/services/categorizer";
import { categorizeGlobalRateLimiter, categoryTranslateRateLimiter, checkRateLimit } from "@/src/lib/rate-limit";

export async function categoryNames(name: string, locale: keyof CategoryNames, userId: string): Promise<CategoryNames> {
  const allowed =
    (await checkRateLimit(categoryTranslateRateLimiter, userId, true)).success &&
    (await checkRateLimit(categorizeGlobalRateLimiter, "global", true)).success;
  const translated = (allowed ? await getCategorizer().translateName(name) : null) ?? { en: name, he: name, ru: name };
  return { ...translated, [locale]: name };
}
