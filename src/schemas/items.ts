import { z } from "zod";

// POST /api/lists/[id]/items — idempotent path
export const createItemIdempotentSchema = z.object({
  text: z.string().min(1).max(500),
  idempotencyKey: z.string().min(1),
  position: z.number().optional(),
});

// POST /api/lists/[id]/items — non-idempotent paths
export const createItemSchema = z.object({
  text: z.string().min(1).max(500).optional(),
  items: z.array(z.object({ text: z.string().min(1).max(500) })).optional(),
  recycleId: z.string().uuid().optional(),
});

// PATCH /api/lists/[id]/items
export const updateItemSchema = z.object({
  itemId: z.string().min(1),
  completed: z.boolean().optional(),
  text: z.string().min(1).max(500).optional(),
  position: z.number().optional(),
  skipped: z.boolean().optional(),
  recurring: z.boolean().optional(),
  restoreRecurring: z.boolean().optional(),
  deleted_at: z.null().optional(),
});

// POST /api/lists/[id]/items/reorder
export const reorderItemsSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(1).max(500),
});

// GET /api/lists/[id]/items — query params
export const getItemsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(500).default(200),
});
