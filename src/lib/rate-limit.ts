/**
 * Rate Limiting with Upstash Redis
 */

import { Ratelimit } from "@upstash/ratelimit";
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

function createLimiter(
  window: Parameters<typeof Ratelimit.slidingWindow>[0],
  interval: Parameters<typeof Ratelimit.slidingWindow>[1],
  prefix: string
): Ratelimit {
  return new Ratelimit({
    redis: getRedis(),
    limiter: Ratelimit.slidingWindow(window, interval),
    prefix,
  });
}

let _webhookRateLimiter: Ratelimit | null = null;
let _voiceRateLimiter: Ratelimit | null = null;
let _apiRateLimiter: Ratelimit | null = null;
let _authIpRateLimiter: Ratelimit | null = null;
let _authUserRateLimiter: Ratelimit | null = null;

// Webhook: 30 req/min per user
export const webhookRateLimiter = new Proxy({} as Ratelimit, {
  get(_, prop) {
    if (!_webhookRateLimiter) _webhookRateLimiter = createLimiter(30, "1 m", "ratelimit:webhook");
    return Reflect.get(_webhookRateLimiter, prop);
  },
});

// Voice: 10 req/min per user (stricter — Gemini free tier 15 RPM)
export const voiceRateLimiter = new Proxy({} as Ratelimit, {
  get(_, prop) {
    if (!_voiceRateLimiter) _voiceRateLimiter = createLimiter(10, "1 m", "ratelimit:voice");
    return Reflect.get(_voiceRateLimiter, prop);
  },
});

// General API: 60 req/min per user
export const apiRateLimiter = new Proxy({} as Ratelimit, {
  get(_, prop) {
    if (!_apiRateLimiter) _apiRateLimiter = createLimiter(60, "1 m", "ratelimit:api");
    return Reflect.get(_apiRateLimiter, prop);
  },
});

// Auth token endpoint — Tier 1: 20 req/min per IP (before validation)
export const authIpRateLimiter = new Proxy({} as Ratelimit, {
  get(_, prop) {
    if (!_authIpRateLimiter) _authIpRateLimiter = createLimiter(20, "1 m", "ratelimit:auth-ip");
    return Reflect.get(_authIpRateLimiter, prop);
  },
});

// Auth token endpoint — Tier 2: 10 req/min per verified user
export const authUserRateLimiter = new Proxy({} as Ratelimit, {
  get(_, prop) {
    if (!_authUserRateLimiter) _authUserRateLimiter = createLimiter(10, "1 m", "ratelimit:auth-user");
    return Reflect.get(_authUserRateLimiter, prop);
  },
});

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  reset: number;
}

/**
 * Check rate limit. By default fails open (allows request if Redis is down).
 * Set failClosed=true for expensive operations (e.g. Gemini voice processing).
 */
export async function checkRateLimit(
  limiter: Ratelimit,
  identifier: string | number,
  failClosed: boolean = false
): Promise<RateLimitResult> {
  try {
    const result = await limiter.limit(String(identifier));
    return {
      success: result.success,
      remaining: result.remaining,
      reset: result.reset,
    };
  } catch (error) {
    console.error("[RateLimit] Error checking rate limit:", error);
    if (failClosed) {
      return { success: false, remaining: 0, reset: 0 };
    }
    // Fail open — allow request if Redis is down (general API)
    return { success: true, remaining: 0, reset: 0 };
  }
}

export function getRateLimitHeaders(
  result: RateLimitResult
): Record<string, string> {
  return {
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(result.reset),
  };
}
