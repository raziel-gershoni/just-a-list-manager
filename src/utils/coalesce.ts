/**
 * Wraps an async task so calls made while it runs collapse into one more run after it
 * finishes. A failed run is logged with `failureLog` (e.g. "[List] Refresh failed") and
 * never rejects.
 */
export function coalesce(task: () => Promise<void>, failureLog: string): () => void {
  let running = false;
  let again = false;
  const run = async () => {
    running = true;
    do {
      again = false;
      try {
        await task();
      } catch (err) {
        console.error(`${failureLog}:`, err);
      }
    } while (again);
    running = false;
  };
  return () => {
    if (running) {
      again = true;
      return;
    }
    void run();
  };
}
