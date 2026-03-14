export interface ItemData {
  id: string;
  text: string;
  completed: boolean;
  completed_at: string | null;
  deleted_at: string | null;
  skipped_at: string | null;
  position: number;
  created_by: string | null;
  creator_name: string | null;
  edited_by: string | null;
  editor_name: string | null;
  _pending?: boolean;
}

export type CompletedGroup = { label: string; items: ItemData[] };
