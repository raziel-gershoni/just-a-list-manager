import { z } from "zod";

export const updateUserSchema = z.object({
  language: z.enum(["en", "he", "ru"]),
});
