import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";

// The reminders feature is gone, so its strings must be gone from all three languages, and
// nothing in the code may still ask for one (next-intl would show the raw key path).
// The Remind/Ready nudge and the grocery repeat feature reuse "remind" and "recurring"
// wording, so the keys they own are pinned here as well.

const LOCALES = ["en", "he", "ru"];

type Json = { [key: string]: string | Json };

const load = (locale: string): Json =>
  JSON.parse(readFileSync(resolve(process.cwd(), `messages/${locale}.json`), "utf8"));

function lookup(obj: Json, path: string): string | Json | undefined {
  let cur: string | Json | undefined = obj;
  for (const part of path.split(".")) {
    if (cur === undefined || typeof cur === "string" || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

const REMOVED_KEYS = [
  "lists.typeReminders",
  "items.addReminderPlaceholder",
  "items.overdue",
  "items.todayGroup",
  "items.tomorrowGroup",
  "items.thisWeekGroup",
  "items.laterGroup",
  "items.todayEvening",
  "items.tomorrowMorning",
  "items.custom",
  "items.tom",
  "settings.reminders",
  "settings.remindersDescription",
  "bot.itemReminder",
  "bot.itemReminderShared",
  "bot.openApp",
  "bot.digestMorning",
  "bot.digestEvening",
  "reminder", // the whole namespace
];

const KEPT_KEYS = [
  "items.reminderSent", // Remind button in a shared list
  "items.readySent",
  "items.signalError",
  "items.signalNoRecipients",
  "items.signal.remind",
  "items.signal.remindHint",
  "items.signal.ready",
  "items.signal.readyHint",
  "bot.listReminder",
  "bot.listReady",
  "bot.openList",
  "bot.remindersRemoved", // answer to a tap on an old reminder message
  "items.recurring.section", // grocery repeat staples
  "items.recurring.toggleOn",
  "items.recurring.toggleOff",
  "items.recurring.restore",
  "items.recurring.returnsInMinutes",
  "items.recurring.returnsInHours",
  "items.recurring.returningSoon",
  "lists.typeRegular",
  "lists.typeGrocery",
  "settings.listSettings",
];

describe("reminder locale keys", () => {
  for (const locale of LOCALES) {
    it(`messages/${locale}.json no longer has any reminders string`, () => {
      const messages = load(locale);
      const stillThere = REMOVED_KEYS.filter((k) => lookup(messages, k) !== undefined);
      expect(stillThere, `still in ${locale}.json: ${stillThere.join(", ")}`).toEqual([]);
    });

    it(`messages/${locale}.json keeps the nudge, repeat and bot-notice strings`, () => {
      const messages = load(locale);
      const gone = KEPT_KEYS.filter((k) => typeof lookup(messages, k) !== "string");
      expect(gone, `missing from ${locale}.json: ${gone.join(", ")}`).toEqual([]);
    });
  }
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("translation keys used by the code", () => {
  // Every key the code names has to exist in en.json (locale-parity then guarantees he and
  // ru). Two shapes are read: a fully qualified string such as t("items.reminderSent"),
  // getMsg(lang, "bot.x") or sendSignal("remind", "items.reminderSent"), and a key relative to
  // the file's single useTranslations("ns") namespace. The removed top-level "reminder"
  // namespace is listed too, so a stale reference to it is still recognised as a key.
  it("every key named in app, components and src exists in en.json", () => {
    const en = load("en");
    const namespaces = [...new Set([...Object.keys(en), ...REMOVED_KEYS.map((k) => k.split(".")[0])])];
    const qualified = new RegExp(`["'](?:${namespaces.join("|")})\\.[A-Za-z0-9_.]+["']`, "g");
    const missing: string[] = [];

    for (const dir of ["app", "components", "src"]) {
      for (const file of sourceFiles(resolve(process.cwd(), dir))) {
        const source = readFileSync(file, "utf8");
        const where = file.replace(process.cwd() + "/", "");
        const check = (key: string) => {
          if (lookup(en, key) === undefined) missing.push(`${where}: ${key}`);
        };

        for (const m of source.matchAll(qualified)) check(m[0].slice(1, -1));

        const scoped = [...source.matchAll(/useTranslations\(\s*["']([\w.]+)["']\s*\)/g)].map((m) => m[1]);
        if (scoped.length === 1) {
          for (const m of source.matchAll(/(?<![\w.$])t\(\s*["']([\w.]+)["']/g)) check(`${scoped[0]}.${m[1]}`);
        }
      }
    }

    expect(missing, `keys with no entry in messages/en.json:\n${missing.join("\n")}`).toEqual([]);
  });
});
