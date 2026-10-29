import type { ExecutorFactory, QueuedMutation } from "@/src/sync/engine";

// The one request builder per change type: the sync engine runs every change through it,
// online and on replay. Tap time for toggle / skip / order: the payload's `at`, or the
// queue time for an entry saved before `at` existed.
const tapTime = (mutation: QueuedMutation): string =>
  typeof mutation.payload.at === "string" ? mutation.payload.at : new Date(mutation.timestamp).toISOString();

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
          return created?.[0] ?? null;
        };
      case "toggle":
        return async () => {
          const jwt = getJwt();
          const res = await fetch(`/api/lists/${payload.listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId: payload.itemId, completed: payload.completed, at: tapTime(mutation) }),
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
            body: JSON.stringify({ itemId: payload.itemId, skipped: payload.skipped, at: tapTime(mutation) }),
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
            body: JSON.stringify({ itemId: payload.itemId, ordered: payload.ordered, at: tapTime(mutation) }),
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
          const { items: recycled } = await res.json();
          return recycled?.[0] ?? null;
        };
      case "unskip-all":
        return async () => {
          const jwt = getJwt();
          const res = await fetch(`/api/lists/${payload.listId}/items/unskip-all`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemIds: payload.itemIds }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Restore all failed: ${res.status}`);
        };
      case "set-category":
        return async () => {
          const jwt = getJwt();
          const res = await fetch(`/api/lists/${payload.listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId: payload.itemId, categoryId: payload.categoryId }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Set category failed: ${res.status}`);
        };
      case "restore":
        // Undo of an item delete: queued behind the delete, so it always lands after it.
        return async () => {
          const jwt = getJwt();
          const res = await fetch(`/api/lists/${payload.listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId: payload.itemId, deleted_at: null }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Restore failed: ${res.status}`);
        };
      default:
        return null;
    }
  };
};
