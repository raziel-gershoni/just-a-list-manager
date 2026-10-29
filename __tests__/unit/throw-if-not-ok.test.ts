import { describe, it, expect } from "vitest";
import { throwIfNotOk } from "@/src/utils/http";

const res = (status: number) => ({ ok: status >= 200 && status < 300, status }) as Response;

// useMutationQueue reads the status with this pattern: 4xx drops the change, 5xx retries it.
const QUEUE_STATUS = /:\s*(\d{3})$/;

describe("throwIfNotOk", () => {
  it("lets a 2xx response through", () => {
    expect(() => throwIfNotOk(res(200), "Save")).not.toThrow();
    expect(() => throwIfNotOk(res(204), "Save")).not.toThrow();
  });

  it("throws '<verb> failed: <status>' for any other status", () => {
    expect(() => throwIfNotOk(res(500), "Clear completed")).toThrow(new Error("Clear completed failed: 500"));
    expect(() => throwIfNotOk(res(404), "Restore")).toThrow(new Error("Restore failed: 404"));
  });

  it("ends with the status the offline queue parses", () => {
    for (const status of [400, 403, 404, 500, 503]) {
      const message = (() => {
        try {
          throwIfNotOk(res(status), "Restore");
          return "";
        } catch (err) {
          return (err as Error).message;
        }
      })();
      expect(message.match(QUEUE_STATUS)?.[1]).toBe(String(status));
    }
  });
});
