export type MutationPayload =
  | { type: "create"; listId: string; text: string; position: number; idempotencyKey: string; tempId: string }
  | { type: "toggle"; listId: string; itemId: string; completed: boolean }
  | { type: "delete"; listId: string; itemId: string }
  | { type: "edit"; listId: string; itemId: string; text: string }
  | { type: "reorder"; listId: string; orderedIds: string[] }
  | { type: "skip"; listId: string; itemId: string; skipped: boolean }
  | { type: "recycle"; listId: string; recycleId: string; text: string };
