/** Throws "<verb> failed: <status>" for a non-2xx response, the format the sync engine (src/sync/engine.ts) parses. `verb` must not contain the words "fetch" or "network" (the engine's offline heuristic matches them). */
export function throwIfNotOk(res: Response, verb: string): void {
  if (!res.ok) throw new Error(`${verb} failed: ${res.status}`);
}
