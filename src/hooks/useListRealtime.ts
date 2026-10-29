"use client";

import { useCallback } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ItemData, ListCategory } from "@/src/types";
import type { RealtimeChange } from "@/src/types";
import { useRealtimeList } from "@/src/hooks/useRealtimeList";
import { lookupUserName } from "@/src/utils/list-helpers";
import { applyCategoryChange } from "@/src/utils/category-state";
import { getSyncEngine } from "@/src/sync/engine";
import { overlayPending } from "@/src/sync/overlay";

interface UseListRealtimeParams {
  supabaseClient: SupabaseClient | null;
  supabaseClientRef: React.RefObject<SupabaseClient | null>;
  listId: string;
  setItems: React.Dispatch<React.SetStateAction<ItemData[]>>;
  setListName: React.Dispatch<React.SetStateAction<string>>;
  setCategories: React.Dispatch<React.SetStateAction<ListCategory[]>>;
  isDraggingRef: React.RefObject<boolean>;
  onListDeleted: () => void;
  /** The list's channel was closed for good: reconnect so a new one starts. */
  onChannelClosed?: () => void;
}

export function useListRealtime({
  supabaseClient,
  supabaseClientRef,
  listId,
  setItems,
  setListName,
  setCategories,
  isDraggingRef,
  onListDeleted,
  onChannelClosed,
}: UseListRealtimeParams) {
  const onChange = useCallback(
    (change: RealtimeChange) => {
      // Supabase Realtime payloads are untyped Records
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const newRec = change.new as Record<string, any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const oldRec = change.old as Record<string, any>;
      if (change.table === "items") {
        if (change.eventType === "INSERT") {
          setItems((prev) => {
            if (prev.find((i) => i.id === newRec.id)) return prev;
            const serverItem = {
              ...newRec,
              creator_name: lookupUserName(prev, newRec.created_by),
              editor_name: lookupUserName(prev, newRec.edited_by),
              _pending: false,
            } as ItemData;
            // Replace pending optimistic item if it matches this server item
            const pendingIndex = prev.findIndex(
              (i) => i._pending && i.text === newRec.text
            );
            if (pendingIndex !== -1) {
              const updated = [...prev];
              updated[pendingIndex] = serverItem;
              return updated;
            }
            return [...prev, serverItem];
          });
        } else if (change.eventType === "UPDATE") {
          const engine = getSyncEngine(listId);
          setItems((prev) =>
            prev.map((i) => {
              if (i.id !== newRec.id) return i;
              const updates = newRec;
              let merged;
              // During drag, skip position-only updates to avoid fighting local reorder
              if (isDraggingRef.current) {
                const rest = Object.fromEntries(
                  Object.entries(updates).filter(([k]) => k !== "position")
                );
                merged = { ...i, ...rest };
              } else {
                merged = { ...i, ...updates };
              }
              if (updates.edited_by && updates.edited_by !== i.edited_by) {
                merged.editor_name = lookupUserName(prev, updates.edited_by as string);
              }
              // A change of the user's the server hasn't confirmed keeps its fields: the echo of
              // an older change, or a collaborator's write to the same field, must not undo it.
              return overlayPending(merged, i, engine.pendingFields(i.id));
            })
          );
        } else if (change.eventType === "DELETE") {
          setItems((prev) => prev.filter((i) => i.id !== oldRec.id));
        }
      } else if (change.table === "list_categories") {
        setCategories((prev) => applyCategoryChange(prev, change));
      } else if (change.table === "lists") {
        if (change.eventType === "UPDATE") {
          if (newRec.deleted_at) {
            onListDeleted();
          } else if (newRec.name) {
            setListName(newRec.name as string);
          }
        }
      }
    },
    [setItems, setListName, setCategories, isDraggingRef, onListDeleted, listId]
  );

  return useRealtimeList(supabaseClient, supabaseClientRef, listId, onChange, onChannelClosed);
}
