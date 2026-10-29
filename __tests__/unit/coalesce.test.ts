import { describe, it, expect, vi, afterEach } from "vitest";
import { coalesce } from "@/src/utils/coalesce";

afterEach(() => vi.restoreAllMocks());

describe("coalesce", () => {
  it("collapses calls made during a run into one more run", async () => {
    let release!: () => void;
    const task = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const run = coalesce(task, "[T] failed");

    run();
    run();
    run();
    expect(task).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(2));
    release();
  });

  it("logs a failed run with its prefix, never rejects, and runs again on the next call", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("refresh failed: 500");
    const task = vi.fn().mockRejectedValueOnce(boom).mockResolvedValue(undefined);
    const run = coalesce(task, "[T] failed");

    expect(() => run()).not.toThrow();
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith("[T] failed:", boom));

    // `running` was cleared, so this call is not swallowed.
    run();
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(2));
  });

  it("a call made during a failing run still gets its run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let rejectFirst!: (e: Error) => void;
    const task = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((_, reject) => (rejectFirst = reject)))
      .mockResolvedValue(undefined);
    const run = coalesce(task, "[T] failed");

    run();
    run();
    rejectFirst(new Error("x"));
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(2));
  });
});
