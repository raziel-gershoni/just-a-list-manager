import { describe, it, expect, vi, afterEach } from "vitest";
import { createCategory, renameCategory, deleteCategory, reorderCategories, runCategoryAction } from "@/src/utils/category-api";

afterEach(() => vi.unstubAllGlobals());
const ok = (body: unknown = {}) => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });

describe("category api", () => {
  it("creates with name and locale", async () => {
    const f = ok({ category: { id: "c" } });
    vi.stubGlobal("fetch", f);
    expect(await createCategory("L", "jwt", "Pets", "en")).toEqual({ id: "c" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/lists/L/categories");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer jwt");
    expect(JSON.parse(init.body)).toEqual({ name: "Pets", locale: "en" });
  });

  it("renames, deletes and reorders at their endpoints", async () => {
    const f = ok({ category: { id: "c" } });
    vi.stubGlobal("fetch", f);
    await renameCategory("L", "jwt", "c", "Pet", "he");
    await deleteCategory("L", "jwt", "c");
    await reorderCategories("L", "jwt", ["b", "a"]);
    expect(f.mock.calls.map(([u, i]) => [u, i.method])).toEqual([
      ["/api/lists/L/categories/c", "PATCH"],
      ["/api/lists/L/categories/c", "DELETE"],
      ["/api/lists/L/categories/order", "PUT"],
    ]);
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ name: "Pet", locale: "he" });
    expect(JSON.parse(f.mock.calls[2][1].body)).toEqual({ orderedIds: ["b", "a"] });
  });

  it("throws on a failed response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) }));
    await expect(deleteCategory("L", "jwt", "c")).rejects.toThrow(/400/);
  });
});

describe("runCategoryAction", () => {
  it("fails without calling the server when the session is not ready", async () => {
    const action = vi.fn();
    const onFail = vi.fn();
    await runCategoryAction(null, action, onFail);
    expect(action).not.toHaveBeenCalled();
    expect(onFail).toHaveBeenCalledOnce();
  });

  it("fails when the request fails", async () => {
    const onFail = vi.fn();
    await runCategoryAction("jwt", vi.fn().mockRejectedValue(new Error("400")), onFail);
    expect(onFail).toHaveBeenCalledOnce();
  });

  it("passes the session to the request and does not fail on success", async () => {
    const action = vi.fn().mockResolvedValue(undefined);
    const onFail = vi.fn();
    await runCategoryAction("jwt", action, onFail);
    expect(action).toHaveBeenCalledWith("jwt");
    expect(onFail).not.toHaveBeenCalled();
  });
});
