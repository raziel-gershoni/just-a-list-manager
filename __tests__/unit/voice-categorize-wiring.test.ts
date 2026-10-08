import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(resolve(process.cwd(), "src/services/voice-handler.ts"), "utf8");

describe("voice adds are categorized", () => {
  it("runs categorizeList for every list it added to, after the receipts are sent", () => {
    const receipts = src.indexOf("for (const receipt of receipts.values())");
    const handlerEnd = src.indexOf("} catch (error) {", receipts);
    expect(receipts).toBeGreaterThan(-1);
    const tail = src.slice(receipts, handlerEnd);
    expect(tail).toMatch(/for \(const listId of receipts\.keys\(\)\)/);
    expect(tail).toMatch(/await categorizeList\(\{ supabase \}, listId, "pending"\)/);
  });
});
