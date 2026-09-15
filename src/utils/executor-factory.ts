import type { ExecutorFactory } from "@/src/hooks/useMutationQueue";
import type { QueuedMutation } from "@/src/utils/mutation-queue";

export const createExecutorFactory = (): ExecutorFactory => {
  return (mutation: QueuedMutation, getJwt: () => string) => {
    const { type, payload } = mutation;
    switch (type) {
      case "create":
        return async () => {
          const jwt = getJwt();
          const res = await fetch(`/api/lists/${payload.listId}/items`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              text: payload.text,
              idempotencyKey: payload.idempotencyKey,
              position: payload.position,
            }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Create failed: ${res.status}`);
          const { items: created } = await res.json();
          return created?.[0]?.id as string | undefined;
        };
      case "toggle":
        return async () => {
          const jwt = getJwt();
          // A recurring completion must replay through complete-recurring, not a
          // plain PATCH — otherwise the replay marks the item done and no next
          // occurrence is ever created, silently ending the series. The inline
          // closure in useItemHandlers.ts branches the same way; these two must
          // not diverge.
          if (payload.recurrence && payload.remindAt) {
            const res = await fetch(
              `/api/lists/${payload.listId}/items/${payload.itemId}/complete-recurring`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${jwt}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  remindAt: payload.remindAt,
                  recurrence: payload.recurrence,
                  isShared: payload.isShared ?? false,
                }),
                keepalive: true,
              }
            );
            if (!res.ok) throw new Error(`Recurring complete failed: ${res.status}`);
            // No optimistic insert on replay — the successor arrives via Realtime
            // or the next refetch.
            return;
          }
          const res = await fetch(`/api/lists/${payload.listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId: payload.itemId, completed: payload.completed }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Toggle failed: ${res.status}`);
        };
      case "delete":
        return async () => {
          const jwt = getJwt();
          const res = await fetch(
            `/api/lists/${payload.listId}/items?itemId=${payload.itemId}`,
            {
              method: "DELETE",
              headers: { Authorization: `Bearer ${jwt}` },
              keepalive: true,
            }
          );
          if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
        };
      case "edit":
        return async () => {
          const jwt = getJwt();
          const res = await fetch(`/api/lists/${payload.listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId: payload.itemId, text: payload.text }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Edit failed: ${res.status}`);
        };
      case "reorder":
        return async () => {
          const jwt = getJwt();
          const res = await fetch(`/api/lists/${payload.listId}/items/reorder`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ orderedIds: payload.orderedIds }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Reorder failed: ${res.status}`);
        };
      case "skip":
        return async () => {
          const jwt = getJwt();
          const res = await fetch(`/api/lists/${payload.listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId: payload.itemId, skipped: payload.skipped }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Skip failed: ${res.status}`);
        };
      case "order":
        return async () => {
          const jwt = getJwt();
          const res = await fetch(`/api/lists/${payload.listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId: payload.itemId, ordered: payload.ordered }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Order failed: ${res.status}`);
        };
      case "set-recurring":
        return async () => {
          const jwt = getJwt();
          const res = await fetch(`/api/lists/${payload.listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId: payload.itemId, recurring: payload.recurring }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Set recurring failed: ${res.status}`);
        };
      case "restore-recurring":
        return async () => {
          const jwt = getJwt();
          const res = await fetch(`/api/lists/${payload.listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId: payload.itemId, restoreRecurring: true }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Restore recurring failed: ${res.status}`);
        };
      case "recycle":
        return async () => {
          const jwt = getJwt();
          const res = await fetch(`/api/lists/${payload.listId}/items`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ text: payload.text, recycleId: payload.recycleId }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Recycle failed: ${res.status}`);
        };
      default:
        return null;
    }
  };
};
