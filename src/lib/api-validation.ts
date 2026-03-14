import { NextResponse } from "next/server";
import { ZodSchema, ZodError } from "zod";

export function parseBody<T>(schema: ZodSchema<T>, body: unknown):
  { success: true; data: T } | { success: false; response: NextResponse } {
  try {
    const data = schema.parse(body);
    return { success: true, data };
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        success: false,
        response: NextResponse.json(
          { error: "Validation error", details: error.issues.map((e) => ({ path: e.path.join("."), message: e.message })) },
          { status: 400 }
        ),
      };
    }
    return {
      success: false,
      response: NextResponse.json({ error: "Invalid request body" }, { status: 400 }),
    };
  }
}

export function parseQuery<T>(schema: ZodSchema<T>, params: Record<string, string | undefined>):
  { success: true; data: T } | { success: false; response: NextResponse } {
  try {
    const data = schema.parse(params);
    return { success: true, data };
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        success: false,
        response: NextResponse.json(
          { error: "Validation error", details: error.issues.map((e) => ({ path: e.path.join("."), message: e.message })) },
          { status: 400 }
        ),
      };
    }
    return {
      success: false,
      response: NextResponse.json({ error: "Invalid query parameters" }, { status: 400 }),
    };
  }
}
