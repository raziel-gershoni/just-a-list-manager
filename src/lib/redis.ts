import { Redis } from "@upstash/redis";
import { serverEnv } from "@/src/lib/env";

let _redis: Redis | null = null;
/** Shared Upstash client for new code (rate-limit.ts and redis-lock.ts keep their own). */
export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      url: serverEnv().UPSTASH_REDIS_REST_URL,
      token: serverEnv().UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return _redis;
}
