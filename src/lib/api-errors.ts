import { NextResponse } from "next/server";

/** Logs a failed database call with its context and returns the route's 500. `what` names the operation, e.g. "Owned lists read". */
export function dbError(tag: string, what: string, error: unknown, ctx?: Record<string, unknown>): NextResponse {
  if (ctx) console.error(`[${tag}] ${what} failed:`, ctx, error);
  else console.error(`[${tag}] ${what} failed:`, error);
  return NextResponse.json({ error: `${what} failed` }, { status: 500 });
}
