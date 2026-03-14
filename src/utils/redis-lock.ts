/**
 * Redis-based distributed lock for preventing duplicate voice message processing
 */

import { Redis } from "@upstash/redis";
import { serverEnv } from "@/src/lib/env";

let _redis: Redis | null = null;
function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      url: serverEnv().UPSTASH_REDIS_REST_URL,
      token: serverEnv().UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return _redis;
}

const VOICE_LOCK_KEY_PREFIX = "voice:lock:";
const VOICE_LOCK_TTL_SECONDS = 60;

/**
 * Try to acquire a lock for voice message processing.
 * Uses file_unique_id as key (consistent across Telegram webhook retries).
 */
export async function acquireVoiceLock(
  fileUniqueId: string
): Promise<boolean> {
  const lockKey = `${VOICE_LOCK_KEY_PREFIX}${fileUniqueId}`;

  try {
    const result = await getRedis().set(lockKey, Date.now(), {
      nx: true,
      ex: VOICE_LOCK_TTL_SECONDS,
    });

    if (result === "OK") {
      console.log(`[Voice Lock] Acquired for file ${fileUniqueId}`);
      return true;
    }

    console.log(
      `[Voice Lock] Already processing file ${fileUniqueId} - duplicate detected`
    );
    return false;
  } catch (error) {
    console.error("[Voice Lock] Error acquiring lock:", error);
    // On error, allow execution (better duplicates than no execution)
    return true;
  }
}

/**
 * Release the lock after voice message processing completes
 */
export async function releaseVoiceLock(fileUniqueId: string): Promise<void> {
  const lockKey = `${VOICE_LOCK_KEY_PREFIX}${fileUniqueId}`;

  try {
    await getRedis().del(lockKey);
    console.log(`[Voice Lock] Released for file ${fileUniqueId}`);
  } catch (error) {
    console.error("[Voice Lock] Error releasing lock:", error);
    // Non-fatal — lock will auto-expire via TTL
  }
}
