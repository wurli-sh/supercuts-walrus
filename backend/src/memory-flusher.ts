/**
 * Single-flight driver for the buyer's Walrus Memory outbox inside a long-lived agent connection.
 * Agent hosts such as `codex exec` stop the MCP server right after answering; a write killed
 * mid-flight becomes an ambiguous claim that is never retried, so `drain` lets shutdown finish it.
 */
export function createMemoryFlusher(flush: () => Promise<void>, report: (error: unknown) => void): { kick: () => void; drain: (timeoutMs: number) => Promise<void> } {
  let running: Promise<void> | undefined;
  const kick = (): void => {
    if (running) return;
    let started: Promise<void>;
    try { started = flush(); } catch (error) { report(error); return; }
    running = started.catch(report).finally(() => { running = undefined; });
  };
  const drain = async (timeoutMs: number): Promise<void> => {
    if (!running) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([running, new Promise<void>((done) => { timer = setTimeout(done, timeoutMs); })]);
    clearTimeout(timer);
  };
  return { kick, drain };
}
