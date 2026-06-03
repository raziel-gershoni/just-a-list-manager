import { normalizeForCompare } from "@/src/utils/text-normalize";

export function computeDuplicateTexts(
  items: { text: string; deleted_at: string | null }[]
): Set<string> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.deleted_at) continue;
    const key = normalizeForCompare(item.text);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const result = new Set<string>();
  for (const [key, n] of counts) {
    if (n > 1) result.add(key);
  }
  return result;
}

// Bidi marks + Latin curly quotes — characters that normalizeForCompare strips or folds.
// A text containing any of these is "noisy" and is a worse dedup-survivor candidate
// than a text without them.
const NOISY_CHARS_RE = /[‎‏‪-‮⁦-⁩“”‘’]/;

export function sortForDedup<T extends { text: string; position: number }>(
  items: T[]
): T[] {
  return [...items].sort((a, b) => {
    const aNoisy = NOISY_CHARS_RE.test(a.text) ? 1 : 0;
    const bNoisy = NOISY_CHARS_RE.test(b.text) ? 1 : 0;
    if (aNoisy !== bNoisy) return aNoisy - bNoisy;
    return b.position - a.position;
  });
}
