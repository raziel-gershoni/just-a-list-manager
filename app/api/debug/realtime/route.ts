import { NextResponse } from "next/server";
import { createServerClient } from "@/src/lib/supabase";

export async function GET() {
  const supabase = createServerClient();
  const results: Record<string, unknown> = {};

  // 1. Check table accessibility and row counts
  const tables = ["items", "lists", "collaborators"];
  for (const table of tables) {
    try {
      const { count, error } = await supabase
        .from(table)
        .select("*", { count: "exact", head: true });
      results[`table_${table}`] = {
        accessible: !error,
        rowCount: count,
        error: error?.message,
      };
      console.log(`[Debug Realtime] Table "${table}": accessible=${!error}, rows=${count}`);
    } catch (e: any) {
      results[`table_${table}`] = { accessible: false, error: e.message };
      console.log(`[Debug Realtime] Table "${table}": ERROR ${e.message}`);
    }
  }

  // 2. Test a write + read cycle to verify the service role key works
  try {
    const testId = `debug-test-${Date.now()}`;
    // Try to read a non-existent item — just tests that the query works
    const { data, error } = await supabase
      .from("items")
      .select("id")
      .eq("id", testId)
      .maybeSingle();
    results.db_query_test = {
      success: !error,
      error: error?.message,
    };
    console.log(`[Debug Realtime] DB query test: success=${!error}`);
  } catch (e: any) {
    results.db_query_test = { success: false, error: e.message };
  }

  // 3. Check Supabase environment variables
  results.env = {
    supabase_url: process.env.NEXT_PUBLIC_SUPABASE_URL ? "SET" : "MISSING",
    supabase_url_value: process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/https?:\/\//, "").split(".")[0] + ".supabase.co",
    anon_key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? "SET" : "MISSING",
    service_role_key: process.env.SUPABASE_SERVICE_ROLE_KEY ? "SET" : "MISSING",
  };

  // 4. Try to check publication config via SQL (requires a DB function)
  // This will fail if the function doesn't exist, which is useful info
  try {
    const { data: pubData, error: pubError } = await supabase.rpc(
      "debug_check_realtime_config"
    );
    results.realtime_config_rpc = { data: pubData, error: pubError?.message };
    console.log("[Debug Realtime] RPC debug_check_realtime_config:", JSON.stringify(pubData));
  } catch (e: any) {
    results.realtime_config_rpc = {
      error: e.message,
      hint: "Create a DB function 'debug_check_realtime_config' to check publication & replica identity. See migration SQL below.",
      migration_sql: `
CREATE OR REPLACE FUNCTION debug_check_realtime_config()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'publication_tables', (
      SELECT jsonb_agg(jsonb_build_object('schemaname', schemaname, 'tablename', tablename))
      FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
    ),
    'replica_identity', (
      SELECT jsonb_agg(jsonb_build_object('table', relname, 'replica_identity', relreplident))
      FROM pg_class WHERE relname IN ('items', 'lists', 'collaborators')
    )
  ) INTO result;
  RETURN result;
END;
$$;
      `.trim(),
    };
    console.log("[Debug Realtime] RPC not available — function needs to be created");
  }

  // 5. Quick sample of recent items
  try {
    const { data: recent, error: recentErr } = await supabase
      .from("items")
      .select("id, list_id, text, completed, created_at")
      .order("created_at", { ascending: false })
      .limit(3);
    results.recent_items = {
      count: recent?.length ?? 0,
      items: recent?.map((i) => ({
        id: i.id.substring(0, 8) + "...",
        list_id: i.list_id.substring(0, 8) + "...",
        text: i.text?.substring(0, 30),
        completed: i.completed,
      })),
      error: recentErr?.message,
    };
  } catch (e: any) {
    results.recent_items = { error: e.message };
  }

  console.log("[Debug Realtime] === Full diagnostic results ===");
  console.log(JSON.stringify(results, null, 2));

  return NextResponse.json(results);
}
