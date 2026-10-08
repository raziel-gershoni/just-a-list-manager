export type RealtimeTable = "items" | "lists" | "collaborators" | "list_categories";
export type RealtimeEventType = "INSERT" | "UPDATE" | "DELETE";

export interface RealtimeChange {
  table: RealtimeTable;
  eventType: RealtimeEventType;
  new: Record<string, unknown>;
  old: Record<string, unknown>;
}
