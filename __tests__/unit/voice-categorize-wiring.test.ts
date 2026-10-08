import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Source inspection: handleVoiceMessage needs Telegram, Gemini and Supabase, so it can't
// run in node. These pin the two facts that matter.
const src = readFileSync(resolve(process.cwd(), "src/services/voice-handler.ts"), "utf8");
const handler = src.slice(src.indexOf("export async function handleVoiceMessage("), src.indexOf("async function processAddItem("));

describe("voice adds are categorized", () => {
  it("records every list it added to once the receipts are sent", () => {
    const receipts = handler.indexOf("for (const receipt of receipts.values())");
    const tryEnd = handler.indexOf("} catch (error) {", receipts);
    expect(receipts).toBeGreaterThan(-1);
    expect(handler.slice(receipts, tryEnd)).toMatch(/listsToSort\.push\(\.\.\.receipts\.keys\(\)\)/);
  });

  it("sorts them only after the voice lock is released", () => {
    const release = handler.indexOf("await releaseVoiceLock(voice.file_unique_id);");
    const sort = handler.indexOf("await categorizeList(");
    expect(release).toBeGreaterThan(-1);
    expect(sort).toBeGreaterThan(release);
    expect(handler.slice(release, sort)).toMatch(/for \(const listId of listsToSort\)/);
    expect(handler.slice(sort, sort + 80)).toMatch(/categorizeList\(\{ supabase: createServerClient\(\) \}, listId, "pending"\)/);
  });
});
