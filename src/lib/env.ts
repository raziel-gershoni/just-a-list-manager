/**
 * Environment Variable Validation
 *
 * Uses lazy validation (validate on first access, not at import time)
 * to avoid breaking `next build` static generation where env vars
 * may not be available.
 */

import { z } from "zod";

const serverEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  UPSTASH_REDIS_REST_URL: z.string().url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_BOT_USERNAME: z.string().min(1),
});

const clientEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
});

type ServerEnv = z.infer<typeof serverEnvSchema>;
type ClientEnv = z.infer<typeof clientEnvSchema>;

let _serverEnv: ServerEnv | null = null;
let _clientEnv: ClientEnv | null = null;

export function serverEnv(): ServerEnv {
  if (!_serverEnv) {
    _serverEnv = serverEnvSchema.parse(process.env);
  }
  return _serverEnv;
}

/** Reset cached env (for testing only) */
export function _resetServerEnv(): void {
  _serverEnv = null;
}

export function clientEnv(): ClientEnv {
  if (!_clientEnv) {
    _clientEnv = clientEnvSchema.parse({
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    });
  }
  return _clientEnv;
}
