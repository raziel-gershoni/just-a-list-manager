import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { describeBodyParseError } from "@/src/lib/api-validation";

// A malformed body makes request.json() reject with a SyntaxError that quotes part of the body.
const parseFailure = (body: string) =>
  new NextRequest("https://app.test/x", { method: "POST", body }).json().then(
    () => { throw new Error("expected the body not to parse"); },
    (err: unknown) => err
  );

describe("describeBodyParseError", () => {
  it("names the error type without the body fragment the raw message carries", async () => {
    const err = await parseFailure('SECRET_CODE{"code_verifier":"abc"}');
    expect(String((err as Error).message)).toContain("SECRET_COD");
    expect(describeBodyParseError(err)).toBe("SyntaxError");
  });

  it("describes an empty body and a non-Error rejection", async () => {
    expect(describeBodyParseError(await parseFailure(""))).toBe("SyntaxError");
    expect(describeBodyParseError("boom")).toBe("string");
  });
});
