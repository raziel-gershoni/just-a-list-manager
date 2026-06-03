const QUOTE_FOLD: Record<string, string> = {
  "”": '"', // " right double curly
  "“": '"', // " left double curly
  "״": '"', // ״ Hebrew gershayim
  "’": "'", // ' right single curly
  "‘": "'", // ' left single curly
  "׳": "'", // ׳ Hebrew geresh
};

const QUOTE_FOLD_RE = new RegExp(
  `[${Object.keys(QUOTE_FOLD).join("")}]`,
  "g"
);

const BIDI_MARKS = /[‎‏‪-‮⁦-⁩]/g;

const WHITESPACE_RUN = /\s+/g;

export function normalizeForCompare(s: string): string {
  return s
    .normalize("NFC")
    .replace(BIDI_MARKS, "")
    .replace(QUOTE_FOLD_RE, (c) => QUOTE_FOLD[c])
    .replace(WHITESPACE_RUN, " ")
    .trim()
    .toLocaleLowerCase();
}
