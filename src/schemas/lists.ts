import { z } from "zod";

export const createListSchema = z.object({
  name: z.string().min(1).max(100),
});

export const updateListSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100).optional(),
  restore: z.boolean().optional(),
  reminders_enabled: z.boolean().optional(),
});
