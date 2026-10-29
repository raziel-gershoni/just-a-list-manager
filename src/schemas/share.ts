import { z } from "zod";

export const approveCollaboratorSchema = z.object({
  listId: z.string().uuid(),
  collaboratorId: z.string().uuid(),
});

// POST /api/share. permission stays a free string: the route stores "view" as view and
// anything else as edit.
export const createInviteSchema = z.object({
  listId: z.string().min(1),
  permission: z.string().optional(),
});
