import { z } from "zod";

export const createReminderSchema = z.object({
  remind_at: z.string().refine((s) => !isNaN(Date.parse(s)), "Invalid datetime"),
  is_shared: z.boolean(),
  recurrence: z.enum(["daily", "weekly", "monthly"]).optional(),
});
