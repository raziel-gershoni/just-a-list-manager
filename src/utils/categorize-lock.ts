import { getRedis } from "@/src/lib/redis";

export type RerunMode = "pending" | "rescan";
export interface ListLock {
  acquire(listId: string): Promise<boolean>;
  release(listId: string): Promise<void>;
  requestRerun(listId: string, mode: RerunMode): Promise<void>;
  takeRerun(listId: string): Promise<RerunMode | null>;
}

const LOCK_TTL_SECONDS = 90;
const RERUN_TTL_SECONDS = 120;
const lockKey = (id: string) => `categorize:lock:${id}`;
const rerunKey = (id: string) => `categorize:again:${id}`;

/** One categorization run per list at a time. Redis errors fail open, like the voice lock. */
export const redisListLock: ListLock = {
  async acquire(listId) {
    try {
      return (await getRedis().set(lockKey(listId), Date.now(), { nx: true, ex: LOCK_TTL_SECONDS })) === "OK";
    } catch (error) {
      console.error("[Categorizer] lock error, running anyway:", error);
      return true;
    }
  },
  async release(listId) {
    try { await getRedis().del(lockKey(listId)); } catch { /* expires on its own */ }
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
