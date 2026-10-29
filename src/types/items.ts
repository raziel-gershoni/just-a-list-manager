export interface ItemData {
  id: string;
  text: string;
  completed: boolean;
  completed_at: string | null;
  deleted_at: string | null;
  skipped_at: string | null;
  ordered_at: string | null;
  category_id?: string | null;
  category_locked?: boolean;
  recurring: boolean;
  position: number;
  created_by: string | null;
  creator_name: string | null;
  edited_by: string | null;
  editor_name: string | null;
  _pending?: boolean;
  _justAdded?: boolean;
  _exiting?: boolean;
  /** On a saved row that a realtime INSERT put in place of a temp row: that temp id. */
  _tempId?: string;
}

export type CompletedGroup = { label: string; items: ItemData[] };

export type CategoryGroup = { key: string; categoryId: string | null; label: string; items: ItemData[] };
