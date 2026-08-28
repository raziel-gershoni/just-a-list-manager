import { z } from "zod";
import { LIST_ICON_NAMES, LIST_COLORS } from "@/src/lib/list-icons";

export const listTypeEnum = z.enum(["regular", "reminders", "grocery"]);
export const listIconEnum = z.enum(LIST_ICON_NAMES as [string, ...string[]]);
export const listColorEnum = z.enum(LIST_COLORS as unknown as [string, ...string[]]);

export const createListSchema = z.object({
  name: z.string().min(1).max(100),
  type: listTypeEnum.optional(),
  icon: listIconEnum.nullable().optional(),
  color: listColorEnum.nullable().optional(),
});

export const updateListSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100).optional(),
  restore: z.boolean().optional(),
  type: listTypeEnum.optional(),
  icon: listIconEnum.nullable().optional(),
  color: listColorEnum.nullable().optional(),
});

// POST /api/lists/reorder
// .uuid() rather than the items schema's .min(1): list creation on the home
// screen is server-first, so there are no optimistic `temp-` ids to accept.
export const reorderListsSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1).max(500),
});

// POST /api/lists/archive
export const archiveListSchema = z.object({
  listId: z.string().uuid(),
  archived: z.boolean(),
});
