import { z } from "zod";

export const listTypeEnum = z.enum(["regular", "reminders", "grocery"]);

export const createListSchema = z.object({
  name: z.string().min(1).max(100),
  type: listTypeEnum.optional(),
});

export const updateListSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100).optional(),
  restore: z.boolean().optional(),
  type: listTypeEnum.optional(),
});
