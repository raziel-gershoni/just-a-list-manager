import { describe, it, expect, vi, afterEach } from "vitest";
import { askConfirm } from "@/src/types/telegram";

afterEach(() => vi.unstubAllGlobals());

describe("askConfirm", () => {
  it("uses Telegram's native confirm and acts only on yes", () => {
    let answer: ((confirmed: boolean) => void) | undefined;
    const showConfirm = vi.fn((_: string, cb: (confirmed: boolean) => void) => { answer = cb; });
    const confirm = vi.fn();
    vi.stubGlobal("window", { Telegram: { WebApp: { showConfirm } }, confirm });
    const onConfirm = vi.fn();

    askConfirm("Delete?", onConfirm);
    expect(showConfirm).toHaveBeenCalledWith("Delete?", expect.any(Function));
    expect(confirm).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    answer!(false);
    expect(onConfirm).not.toHaveBeenCalled();
    answer!(true);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("falls back to window.confirm outside Telegram", () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal("window", { confirm });
    const onConfirm = vi.fn();

    askConfirm("Delete?", onConfirm);
    expect(onConfirm).not.toHaveBeenCalled();
    askConfirm("Delete?", onConfirm);
    expect(confirm).toHaveBeenCalledWith("Delete?");
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
