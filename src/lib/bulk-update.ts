// PostgREST puts every value of an `.in("id", ids)` filter in the request URL, even on a
// PATCH, and the shown-ids bulk routes accept up to 500 uuids (about 19.7 KB of URL), which
// can pass a gateway's request-line limit. So the ids go out in sequential batches.
export const BULK_BATCH_SIZE = 100;

type BatchResult<Row, Err> = { data: Row[] | null; error: Err | null };

/**
 * Runs `runBatch` over `ids` in sequential batches of BULK_BATCH_SIZE and joins the rows it
 * returns. Stops at the first batch that errors and returns that error, so the caller
 * answers as it would for a single failed update. Batches already written stay written; the
 * routes' updates are idempotent (they match only rows still in the state being changed), so
 * the queue's retry of the whole request finishes the rest.
 */
export async function updateInBatches<Row, Err>(
  ids: string[],
  runBatch: (batch: string[]) => PromiseLike<BatchResult<Row, Err>>
): Promise<{ data: Row[]; error: null } | { data: null; error: Err }> {
  const rows: Row[] = [];
  for (let i = 0; i < ids.length; i += BULK_BATCH_SIZE) {
    const { data, error } = await runBatch(ids.slice(i, i + BULK_BATCH_SIZE));
    if (error) return { data: null, error };
    rows.push(...(data ?? []));
  }
  return { data: rows, error: null };
}
