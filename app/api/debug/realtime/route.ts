import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@/src/lib/supabase";

export async function GET(request: NextRequest) {
  const results: Record<string, unknown> = {};

  // Extract user JWT from Authorization header (if provided)
  const authHeader = request.headers.get("Authorization");
  const userJwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  // Decode JWT claims (without verification) to see what's in it
  if (userJwt) {
    try {
      const parts = userJwt.split(".");
      if (parts.length === 3) {
        const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
        results.jwt_claims = {
          sub: claims.sub,
          role: claims.role,
          aud: claims.aud,
          iss: claims.iss,
          exp: claims.exp,
          exp_human: new Date(claims.exp * 1000).toISOString(),
          expired: Date.now() / 1000 > claims.exp,
        };
      }
    } catch (e: any) {
      results.jwt_decode_error = e.message;
    }
  } else {
    results.jwt_claims = "No Authorization header — pass Bearer token to test RLS with user JWT";
  }

  // --- Test with service role (bypasses RLS) ---
  const serviceClient = createServerClient();

  // Table counts (service role, bypasses RLS)
  const tables = ["items", "lists", "collaborators"];
  for (const table of tables) {
    try {
      const { count, error } = await serviceClient
        .from(table)
        .select("*", { count: "exact", head: true });
      results[`service_${table}`] = { count, error: error?.message };
    } catch (e: any) {
      results[`service_${table}`] = { error: e.message };
    }
  }

  // --- Test with user JWT (subject to RLS) ---
  if (userJwt) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${userJwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Test RLS: query each table with the user's JWT
    for (const table of tables) {
      try {
        const { count, error } = await userClient
          .from(table)
          .select("*", { count: "exact", head: true });
        results[`rls_${table}`] = { count, error: error?.message };
      } catch (e: any) {
        results[`rls_${table}`] = { error: e.message };
      }
    }

    // Test auth.uid() with user JWT
    try {
      const { data, error } = await userClient.rpc("get_user_id_from_jwt");
      results.rls_auth_uid = { result: data, error: error?.message };
    } catch (e: any) {
      results.rls_auth_uid = { error: e.message };
    }

    // Test get_accessible_list_ids() with user JWT
    try {
      const { data, error } = await userClient.rpc("get_accessible_list_ids");
      results.rls_accessible_lists = { result: data, error: error?.message };
    } catch (e: any) {
      results.rls_accessible_lists = { error: e.message };
    }
  }

  // Check publication config (service role)
  try {
    const { data, error } = await serviceClient.rpc("debug_check_realtime_config");
    results.realtime_config = { data, error: error?.message };
  } catch {
    results.realtime_config = "RPC not found — run the SQL from migration notes";
  }

  // Env check
  results.env = {
    supabase_url: process.env.NEXT_PUBLIC_SUPABASE_URL ? "SET" : "MISSING",
    anon_key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? "SET" : "MISSING",
    service_role_key: process.env.SUPABASE_SERVICE_ROLE_KEY ? "SET" : "MISSING",
    jwt_secret: process.env.SUPABASE_JWT_SECRET ? "SET" : "MISSING",
  };

  console.log("[Debug Realtime] Results:", JSON.stringify(results, null, 2));
  return NextResponse.json(results);
}
