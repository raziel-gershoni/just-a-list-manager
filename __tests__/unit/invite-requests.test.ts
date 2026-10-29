import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { requestToJoin, cancelJoinRequest } from "@/src/utils/invite-requests";

// The invite page's two requests. A server failure or a dropped connection must never be shown
// as "Invite not valid", and Cancel must only count as done when the server confirms it.
const TOKEN = "invite-token-SECRET-123";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("requestToJoin", () => {
  it("posts to the invite route with the init data header", async () => {
    fetchMock.mockResolvedValue(json(200, { listId: "L1", listName: "Groceries", collaboratorId: "c1", status: "pending" }));

    await requestToJoin(TOKEN, "init-data");

    expect(fetchMock).toHaveBeenCalledWith(`/api/share/${TOKEN}`, {
      method: "POST",
      headers: { "x-telegram-init-data": "init-data", "Content-Type": "application/json" },
    });
  });

  it("a new request is pending", async () => {
    fetchMock.mockResolvedValue(json(200, { listId: "L1", listName: "Groceries", collaboratorId: "c1", status: "pending" }));

    await expect(requestToJoin(TOKEN, "init-data")).resolves.toEqual({
      kind: "pending", listId: "L1", listName: "Groceries", collaboratorId: "c1",
    });
  });

  it("an earlier pending request is pending too", async () => {
    fetchMock.mockResolvedValue(json(400, { status: "already_pending", listId: "L1", listName: "Groceries", collaboratorId: "c1" }));

    await expect(requestToJoin(TOKEN, "init-data")).resolves.toEqual({
      kind: "pending", listId: "L1", listName: "Groceries", collaboratorId: "c1",
    });
  });

  it("a member is sent to the list", async () => {
    fetchMock.mockResolvedValue(json(400, { status: "already_approved", listId: "L1" }));

    await expect(requestToJoin(TOKEN, "init-data")).resolves.toEqual({ kind: "member", listId: "L1" });
  });

  it.each([
    [404, "Invite not found"],
    [410, "This list has been deleted."],
  ])("a dead link (%s) is invalid, with the server's reason", async (status, error) => {
    fetchMock.mockResolvedValue(json(status, { error }));

    await expect(requestToJoin(TOKEN, "init-data")).resolves.toEqual({ kind: "invalid", message: error });
  });

  it.each([500, 503, 429])("a %s answer is 'try again', not invalid, and is logged", async (status) => {
    fetchMock.mockResolvedValue(json(status, { error: "Invite read failed" }));

    await expect(requestToJoin(TOKEN, "init-data")).resolves.toEqual({ kind: "retry" });
    expect(console.error).toHaveBeenCalledWith("[Invite] Join request failed, status:", status);
  });

  it("a 500 with an HTML body is 'try again' too", async () => {
    fetchMock.mockResolvedValue(new Response("<html>Internal Server Error</html>", { status: 500 }));

    await expect(requestToJoin(TOKEN, "init-data")).resolves.toEqual({ kind: "retry" });
  });

  it("a dropped connection is 'try again' and logs the error", async () => {
    const offline = new TypeError("Failed to fetch");
    fetchMock.mockRejectedValue(offline);

    await expect(requestToJoin(TOKEN, "init-data")).resolves.toEqual({ kind: "retry" });
    expect(console.warn).toHaveBeenCalledWith("[Invite] Join request did not reach the server:", offline);
  });

  it("never logs the invite token", async () => {
    fetchMock.mockResolvedValue(json(500, {}));
    await requestToJoin(TOKEN, "init-data");
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await requestToJoin(TOKEN, "init-data");

    const printed = [...vi.mocked(console.error).mock.calls, ...vi.mocked(console.warn).mock.calls]
      .flat()
      .map(String)
      .join("\n");
    expect(printed).not.toContain(TOKEN);
  });
});

describe("cancelJoinRequest", () => {
  const headers = { Authorization: "Bearer jwt" };

  it("sends the DELETE and is true when the server confirms", async () => {
    fetchMock.mockResolvedValue(json(200, { success: true }));

    await expect(cancelJoinRequest(TOKEN, "c1", headers)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(`/api/share/${TOKEN}?collaboratorId=c1`, { method: "DELETE", headers });
  });

  it("is false and logs the status when the server refuses", async () => {
    fetchMock.mockResolvedValue(json(500, { error: "Join request cancel failed" }));

    await expect(cancelJoinRequest(TOKEN, "c1", headers)).resolves.toBe(false);
    expect(console.error).toHaveBeenCalledWith("[Invite] Cancel join request failed, collaboratorId:", "c1", "status:", 500);
  });

  it("is false and logs the error when the connection drops", async () => {
    const offline = new TypeError("Failed to fetch");
    fetchMock.mockRejectedValue(offline);

    await expect(cancelJoinRequest(TOKEN, "c1", headers)).resolves.toBe(false);
    expect(console.warn).toHaveBeenCalledWith("[Invite] Failed to cancel join request, collaboratorId:", "c1", offline);
  });
});
