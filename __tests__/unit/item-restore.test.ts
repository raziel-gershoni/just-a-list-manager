import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { restoreItemsOnServer } from "@/src/utils/item-restore";

let fetchMock: ReturnType<typeof vi.fn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Each item id picks how the server answers its restore.
  fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const { itemId } = JSON.parse(init.body);
    if (itemId === "refused") return { ok: false, status: 500 };
    if (itemId === "gone") return { ok: false, status: 404 };
    if (itemId === "offline") throw new TypeError("Failed to fetch");
    return { ok: true, status: 200 };
  });
  vi.stubGlobal("fetch", fetchMock);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("restoreItemsOnServer", () => {
  it("sends one PATCH per item, with its body and the session token", async () => {
    await restoreItemsOnServer("L", "jwt", [
      { itemId: "a", deleted_at: null },
      { itemId: "b", completed: true },
    ]);

    const headers = { Authorization: "Bearer jwt", "Content-Type": "application/json" };
    expect(fetchMock.mock.calls).toEqual([
      ["/api/lists/L/items", { method: "PATCH", headers, body: JSON.stringify({ itemId: "a", deleted_at: null }) }],
      ["/api/lists/L/items", { method: "PATCH", headers, body: JSON.stringify({ itemId: "b", completed: true }) }],
    ]);
  });

  it("returns exactly the ids whose restore was refused or not sent, and logs each one", async () => {
    const failed = await restoreItemsOnServer("L", "jwt", [
      { itemId: "a", deleted_at: null },
      { itemId: "refused", deleted_at: null },
      { itemId: "gone", deleted_at: null },
      { itemId: "offline", deleted_at: null },
      { itemId: "b", deleted_at: null },
    ]);

    expect(failed).toEqual(["refused", "gone", "offline"]);
    expect(errorSpy).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledWith(
      "[ItemRestore] Undo restore failed:",
      { listId: "L", itemId: "refused" },
      expect.objectContaining({ message: "Restore failed: 500" })
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[ItemRestore] Undo restore failed:",
      { listId: "L", itemId: "gone" },
      expect.objectContaining({ message: "Restore failed: 404" })
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[ItemRestore] Undo restore failed:",
      { listId: "L", itemId: "offline" },
      expect.any(TypeError)
    );
  });

  it("returns no ids and logs nothing when every restore lands", async () => {
    const failed = await restoreItemsOnServer("L", "jwt", [{ itemId: "a", deleted_at: null }]);

    expect(failed).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
