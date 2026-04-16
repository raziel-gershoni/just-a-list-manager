import { z } from "zod";

export const updateUserSchema = z.object({
  language: z.enum(["en", "he", "ru"]).optional(),
  timezone: z.string().min(1).optional(),
}).refine((d) => d.language !== undefined || d.timezone !== undefined, "At least one field required");
