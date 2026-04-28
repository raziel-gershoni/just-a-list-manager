export interface ItemData {
  id: string;
  text: string;
  completed: boolean;
  completed_at: string | null;
  deleted_at: string | null;
  skipped_at: string | null;
  recurring: boolean;
  position: number;
  created_by: string | null;
  creator_name: string | null;
  edited_by: string | null;
  editor_name: string | null;
  my_remind_at?: string | null;
  my_reminder_id?: string | null;
  my_reminder_shared?: boolean;
  my_reminder_recurrence?: string | null;
  _pending?: boolean;
  _justAdded?: boolean;
  _exiting?: boolean;
}

export type CompletedGroup = { label: string; items: ItemData[] };
