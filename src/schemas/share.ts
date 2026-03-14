import { z } from "zod";

export const approveCollaboratorSchema = z.object({
  listId: z.string().uuid(),
  collaboratorId: z.string().uuid(),
});
