"use client";

import { useCallback } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ItemData } from "@/src/types";
import type { RealtimeChange } from "@/src/types";
import { useRealtimeList } from "@/src/hooks/useRealtimeList";
import { lookupUserName } from "@/src/utils/list-helpers";

interface UseListRealtimeParams {
  supabaseClient: SupabaseClient | null;
  supabaseClientRef: React.RefObject<SupabaseClient | null>;
  listId: string;
  setItems: React.Dispatch<React.SetStateAction<ItemData[]>>;
  setListName: React.Dispatch<React.SetStateAction<string>>;
  isDraggingRef: React.RefObject<boolean>;
  onListDeleted: () => void;
}

export function useListRealtime({
  supabaseClient,
  supabaseClientRef,
  listId,
  setItems,
  setListName,
  isDraggingRef,
  onListDeleted,
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
              return merged;
            })
          );
        } else if (change.eventType === "DELETE") {
          setItems((prev) => prev.filter((i) => i.id !== oldRec.id));
        }
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
    [setItems, setListName, isDraggingRef, onListDeleted]
  );

  return useRealtimeList(supabaseClient, supabaseClientRef, listId, onChange);
}
