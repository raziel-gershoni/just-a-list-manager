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
// itemId is .uuid(): a still-pending item has a temp-... id, and the uuid column would
// reject it with a DB error. A 400 here is dropped by the offline queue; a 500 is retried.
export const updateItemSchema = z.object({
  itemId: z.string().uuid(),
  completed: z.boolean().optional(),
  text: z.string().min(1).max(500).optional(),
  position: z.number().optional(),
  skipped: z.boolean().optional(),
  ordered: z.boolean().optional(),
  recurring: z.boolean().optional(),
  restoreRecurring: z.boolean().optional(),
  deleted_at: z.null().optional(),
  categoryId: z.string().uuid().optional(),
  // When the user tapped (ISO date-time), for completed_at / skipped_at / ordered_at. Optional:
  // entries queued before the client sent it carry none, and the server uses its own time. A
  // value that does not parse is ignored the same way (see tapTime), never a 400, because the
  // queue would drop the user's change on a 4xx.
  at: z.string().optional(),
});

// POST /api/lists/[id]/items/reorder
export const reorderItemsSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(1).max(500),
});

// A bulk action's body: the ids of the items the user's screen showed, so the route never
// touches a row the user did not see (a collaborator's tick a moment ago, or an item whose
// own change is still queued). .uuid(): the client sends only synced ids; an item still on
// a temp- id is not on the server yet.
const shownItemIdsSchema = z.object({
  itemIds: z.array(z.string().uuid()).min(1).max(500),
});

// POST /api/lists/[id]/items/unskip-all (items on a temp- id are restored through their
// own queued skip mutation)
export const unskipAllSchema = shownItemIdsSchema;

// POST /api/lists/[id]/items/clear-completed
export const clearCompletedSchema = shownItemIdsSchema;

// POST /api/lists/[id]/items/unmark-completed
export const unmarkCompletedSchema = shownItemIdsSchema;

// GET /api/lists/[id]/items — query params
export const getItemsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(500).default(200),
});
