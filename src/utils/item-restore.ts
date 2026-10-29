import { throwIfNotOk } from "@/src/utils/http";

/** One item PATCH body an Undo sends, e.g. { itemId, deleted_at: null } or { itemId, completed: true }. */
export type RestoreBody = { itemId: string } & Record<string, unknown>;

/**
 * Sends an Undo's item PATCHes in parallel and checks each response. Every failure is
 * logged with its list and item id. Never rejects: resolves with the ids that failed.
 */
export async function restoreItemsOnServer(
  listId: string,
  jwt: string | null,
  bodies: RestoreBody[]
): Promise<string[]> {
  const results = await Promise.allSettled(
    bodies.map((body) =>
      fetch(`/api/lists/${listId}/items`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }).then((res) => throwIfNotOk(res, "Restore"))
    )
  );

  const failed: string[] = [];
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      const { itemId } = bodies[i];
      console.error("[ItemRestore] Undo restore failed:", { listId, itemId }, result.reason);
      failed.push(itemId);
    }
  });
  return failed;
}
