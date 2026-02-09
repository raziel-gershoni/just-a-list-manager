/**
 * Rate Limiting with Upstash Redis
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Webhook: 30 req/min per user
export const webhookRateLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, "1 m"),
  prefix: "ratelimit:webhook",
});

// Voice: 10 req/min per user (stricter — Gemini free tier 15 RPM)
export const voiceRateLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "1 m"),
  prefix: "ratelimit:voice",
});

// General API: 60 req/min per user
export const apiRateLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(60, "1 m"),
  prefix: "ratelimit:api",
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
