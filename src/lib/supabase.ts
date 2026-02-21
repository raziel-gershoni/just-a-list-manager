import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Server-side client with secret key (bypasses RLS)
export function createServerClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SECRET_KEY!;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Browser client with custom JWT for Realtime subscriptions
export function createBrowserClient(
  accessToken: string,
  onHeartbeat?: (status: string, latency?: number) => void
): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const client = createClient(url, publishableKey, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: {
      heartbeatIntervalMs: 15000,
      worker: true,
      ...(onHeartbeat && { heartbeatCallback: onHeartbeat }),
    },
  });
  client.realtime.setAuth(accessToken);
  return client;
}
