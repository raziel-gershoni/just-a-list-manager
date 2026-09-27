/**
 * Resolve a client-supplied recycleId against the rows the server itself found
 * for this list. Returns undefined when the id is not among them, so an
 * arbitrary uuid can never reach recycleItem — which writes by id.
 */
export function pickRecyclable<T extends { id: string }>(
  recyclable: T[],
  recycleId: string | undefined
): T | undefined {
  if (!recycleId) return undefined;
  return recyclable.find((r) => r.id === recycleId);
}
