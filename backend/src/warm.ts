/**
 * Free-tier hosts sleep after idle time and cold-start on the next request. Ping a dependency's
 * /health in the background as soon as a deal starts, so it is awake by the time payment needs it.
 * The returned function never throws and never blocks the caller.
 */
export function createWarmer(url: string, options: { minIntervalMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch; now?: () => number } = {}): () => void {
  const target = `${url.replace(/\/+$/, "")}/health`;
  const minIntervalMs = options.minIntervalMs ?? 60_000, timeoutMs = options.timeoutMs ?? 120_000;
  const fetchImpl = options.fetchImpl ?? fetch, now = options.now ?? Date.now;
  let inFlight = false, lastStarted = Number.NEGATIVE_INFINITY;
  return () => {
    if (inFlight || now() - lastStarted < minIntervalMs) return;
    inFlight = true; lastStarted = now();
    let ping: Promise<Response>;
    try { ping = fetchImpl(target, { signal: AbortSignal.timeout(timeoutMs) }); } catch { inFlight = false; return; }
    void ping
      .then((response) => response.body?.cancel())
      .catch(() => { /* best effort: the payment path reports a real outage itself */ })
      .finally(() => { inFlight = false; });
  };
}
