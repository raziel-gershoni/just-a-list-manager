import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Hard-coded rather than imported from src/lib/i18n.ts: that module pulls in
// next-intl/server, which does not load in the node test environment.
// Keep in sync with `supportedLocales` there.
const LOCALES = ["en", "he", "ru"];

type Json = { [key: string]: string | Json };

function leafKeys(obj: Json, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "object" && value !== null
      ? leafKeys(value as Json, path)
      : [path];
  });
}

function load(locale: string): Json {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), `messages/${locale}.json`), "utf8")
  );
}

describe("locale key parity", () => {
  // Guards the silent-break bug: adding a key to en.json only ships a raw
  // key path ("lists.reorderFailed") to Hebrew and Russian users.
  const base = leafKeys(load("en")).sort();

  for (const locale of LOCALES.filter((l) => l !== "en")) {
    it(`messages/${locale}.json has exactly the same keys as en.json`, () => {
      const keys = leafKeys(load(locale)).sort();

      const missing = base.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !base.includes(k));

      expect(missing, `missing from ${locale}.json: ${missing.join(", ")}`).toEqual([]);
      expect(extra, `not in en.json: ${extra.join(", ")}`).toEqual([]);
    });
  }
});
