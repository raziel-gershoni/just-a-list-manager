# Supabase JS upgrade (2.95.3 → 2.119+)

**Status:** parked (2026-11-10), owner's choice. There is no reachable security gain. It needs a
dedicated two-device test of realtime in prod. Found during the dependency evaluation
(`docs/superpowers/specs/2026-11-10-dependency-upgrades-design.md`).

## Why a plain bump is dangerous

A plain `npm install @supabase/supabase-js@2.119.0` goes green after a one-line type fix, but it
silently stops live sync:

- **2.112.1 and later:** the client always installs an `accessToken` callback. That callback wins
  over the app's manual `realtime.setAuth(jwt)`, so every automatic rejoin and heartbeat sends the
  **publishable key** instead of the app JWT. RLS then hides every `postgres_changes` event. This
  hits exactly the phone-unlock rejoin path. No unit test sees it. Bisect: 2.112.0 is good, 2.112.1
  is bad.
- **2.100 and later:** `removeAllChannels()` on the old client delivers `CLOSED` to its channels.
  `TelegramProvider.syncRealtime` replaces the client ref only after closing the old one, so
  `useRealtimeList` reads that `CLOSED` as a server close and starts an extra reconnect.
- **2.110.1 and later:** the heartbeat callback never reports `'disconnected'`, so the branch in
  `stableHeartbeatCallback` that handles it is dead.
- **2.105 and later:** `removeChannel` returns `"ok" | "timed out" | "error" | (string & {})`, which
  breaks the `RemoveResult` type in `src/lib/realtime-cleanup.ts` (tsc and build fail).
- **Node 22 or newer** is required. Node 24 is pinned since 2026-11-10.

## How to do it

1. **Safe on 2.95.3, can land alone:** `createBrowserClient(getAccessToken, onHeartbeat)` in
   `src/lib/supabase.ts`.
   - It passes `accessToken: async () => getAccessToken()` to `createClient`.
   - It drops the global `Authorization` header and the `auth` options.
   - `TelegramProvider` passes `() => realtimeTokenRef.current ?? token`.
   - The mock in `telegram-provider-bootstrap.test.ts` changes to match.

   This is the supported way to use a third-party JWT. Offline fake-socket probes kept the app JWT
   on join, refresh and rejoin on both versions.
2. **The bump itself:**
   - Fix the `RemoveResult` type: `Awaited<ReturnType<SupabaseClient["removeChannel"]>>`.
   - In `syncRealtime`, point `supabaseClientRef` and `realtimeTokenRef` at the new client before
     calling `disconnect()` / `removeAllChannels` on the old one.
   - Remove the dead `'disconnected'` heartbeat branch and its test
     (`telegram-provider-bootstrap.test.ts`, about line 492). Keep the unmount test.

## Prod test session (two devices)

- **Steady state:** live sync works, keeps working after 2+ minutes idle, and works again after a
  3+ minute lock followed by an immediate unlock and tap.
- **Interruptions:** background Telegram on iOS and Android, airplane mode for 30 s, and leaving a
  list for Home for 30 s or more before opening another list.
- **Token refresh:** the next day, the refreshed token still receives live events.
- **Logs:** the remote console shows no "Channel closed by the server" and no InvalidJWT. Watch the
  Supabase Realtime logs for the first hour.
