import { randomUUID } from "crypto";
import { getRedis } from "@/src/lib/redis";

export type RerunMode = "pending" | "rescan";
export interface ListLock {
  /** A token to release with, or null while another run holds the lock. */
  acquire(listId: string): Promise<string | null>;
  /** Frees the lock only if it still holds this token. */
  release(listId: string, token: string): Promise<void>;
  requestRerun(listId: string, mode: RerunMode): Promise<void>;
  takeRerun(listId: string): Promise<RerunMode | null>;
}

// Covers one round (categorizeList takes the lock per round): an AI call of at most
// 2 x 25 s plus the reads and writes around it.
const LOCK_TTL_SECONDS = 90;
const RERUN_TTL_SECONDS = 120;
const lockKey = (id: string) => `categorize:lock:${id}`;
const rerunKey = (id: string) => `categorize:again:${id}`;

// Delete only our own lock: if ours expired and another run took it, leave theirs.
const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** One categorization run per list at a time. Redis errors fail open, like the voice lock. */
export const redisListLock: ListLock = {
  async acquire(listId) {
    const token = randomUUID();
    try {
      return (await getRedis().set(lockKey(listId), token, { nx: true, ex: LOCK_TTL_SECONDS })) === "OK" ? token : null;
    } catch (error) {
      console.error("[Categorizer] lock error, running anyway:", error);
      return token;
    }
  },
  async release(listId, token) {
    try { await getRedis().eval(RELEASE_SCRIPT, [lockKey(listId)], [token]); } catch { /* expires on its own */ }
  },
  async requestRerun(listId, mode) {
    try {
      // A rescan request upgrades a pending one; a pending request never downgrades a rescan.
      if (mode === "rescan") await getRedis().set(rerunKey(listId), "rescan", { ex: RERUN_TTL_SECONDS });
      else await getRedis().set(rerunKey(listId), "pending", { ex: RERUN_TTL_SECONDS, nx: true });
    } catch (error) {
      console.error("[Categorizer] rerun flag error:", error);
    }
  },
  async takeRerun(listId) {
    try {
      const value = await getRedis().getdel<string>(rerunKey(listId));
      return value === "rescan" || value === "pending" ? value : null;
    } catch {
      return null;
    }
  },
};
