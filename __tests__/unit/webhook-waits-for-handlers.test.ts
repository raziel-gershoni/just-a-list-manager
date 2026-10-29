import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Runs the real webhook POST handler. after() is captured instead of run by Next, and the bot
// module is faked, so the test can see whether the background step waits for the command
// handlers that processUpdate started.
const h = vi.hoisted(() => ({
  afterTasks: [] as (() => Promise<void>)[],
  processUpdate: null as unknown as ReturnType<typeof vi.fn>,
  handlersDone: null as Promise<void> | null,
}));

vi.mock("next/server", async (importOriginal) => {
  const real = await importOriginal<typeof import("next/server")>();
  return { ...real, after: (task: () => Promise<void>) => void h.afterTasks.push(task) };
});
vi.mock("@/src/lib/env", () => ({
  serverEnv: () => ({ TELEGRAM_WEBHOOK_SECRET: "hook-secret" }),
}));
vi.mock("@/src/services/bot", () => ({
  default: { processUpdate: (...args: unknown[]) => h.processUpdate(...args) },
  waitForBotHandlers: () => h.handlersDone ?? Promise.resolve(),
}));

import { POST } from "@/app/api/webhook/route";

const startUpdate = {
  update_id: 1,
  message: { message_id: 5, date: 0, chat: { id: 42, type: "private" }, from: { id: 7, is_bot: false, first_name: "A" }, text: "/start" },
};
const req = () =>
  new NextRequest("https://app.test/api/webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "hook-secret", "Content-Type": "application/json" },
    body: JSON.stringify(startUpdate),
  });

beforeEach(() => {
  h.afterTasks = [];
  h.processUpdate = vi.fn();
  h.handlersDone = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/webhook: command updates", () => {
  it("keeps the background step alive until the bot's command handlers finish", async () => {
    let release!: () => void;
    h.handlersDone = new Promise<void>((r) => (release = r));

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(h.afterTasks).toHaveLength(1);

    let finished = false;
    const background = h.afterTasks[0]().then(() => {
      finished = true;
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(h.processUpdate).toHaveBeenCalledWith(startUpdate);
    expect(finished).toBe(false);

    release();
    await background;
    expect(finished).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
  });
});
