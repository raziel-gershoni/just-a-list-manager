import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { readJsonBody } from "@/src/lib/api-validation";
import { dbError } from "@/src/lib/api-errors";

const post = (body: string) => new NextRequest("https://app.test/x", { method: "POST", body });

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("readJsonBody", () => {
  it("returns null for a body that is not JSON and logs only the error type, tagged", async () => {
    expect(await readJsonBody(post('SECRET_TEXT{"a":'), "t/POST")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[t/POST] Could not parse request body:", "SyntaxError");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET");
  });

  it("returns null for an empty body", async () => {
    expect(await readJsonBody(post(""), "t/POST")).toBeNull();
    expect(warn).toHaveBeenCalledWith("[t/POST] Could not parse request body:", "SyntaxError");
  });

  it("returns a JSON body as parsed, without logging", async () => {
    expect(await readJsonBody(post('{"name":"Groceries","n":[1,2]}'), "t/POST")).toEqual({ name: "Groceries", n: [1, 2] });
    expect(await readJsonBody(post("null"), "t/POST")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("dbError", () => {
  it("logs the tag, the operation, the context and the error, and answers 500", async () => {
    const err = { message: "connection reset", code: "08006" };
    const res = dbError("lists/GET", "Owned lists read", err, { userId: "u1" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Owned lists read failed" });
    expect(error).toHaveBeenCalledWith("[lists/GET] Owned lists read failed:", { userId: "u1" }, err);
  });

  it("logs just the error when there is no context", async () => {
    const err = new Error("boom");
    const res = dbError("user/PATCH", "User update", err);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "User update failed" });
    expect(error).toHaveBeenCalledWith("[user/PATCH] User update failed:", err);
    expect(error.mock.calls[0]).toHaveLength(2);
  });
});
