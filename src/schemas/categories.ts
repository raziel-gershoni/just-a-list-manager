import { z } from "zod";

export const categoryNameSchema = z.object({
  name: z.string().trim().min(1).max(40),
  locale: z.enum(["en", "he", "ru"]),
});

export const categoryOrderSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1).max(20),
});
