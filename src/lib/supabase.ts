import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Server-side client with service-role key (bypasses RLS)
export function createServerClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Browser client with custom JWT for Realtime subscriptions
export function createBrowserClient(accessToken: string): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const client = createClient(url, anonKey, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  client.realtime.setAuth(accessToken);
  return client;
}
