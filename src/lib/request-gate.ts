/**
 * Ensures only the newest read can update state: starting a new request aborts
 * the previous one, and responses from superseded requests are ignored.
 */
export function createRequestGate() {
  let seq = 0;
  let controller: AbortController | null = null;
  return {
    begin() {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      const id = ++seq;
      return { id, signal: current.signal, isLatest: () => id === seq && !current.signal.aborted };
    },
    cancel() {
      controller?.abort();
      controller = null;
      seq++;
    },
  };
}

export function isAbortError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: string; message?: string; code?: string };
  return e.name === "AbortError" || e.code === "20" || /abort/i.test(e.message ?? "");
}
