#!/usr/bin/env node
import { Phase3App } from "./phase3.js";

const home = process.argv[2];
if (!home) {
  process.stderr.write("usage: supercuts-memory-worker <role-home>\n");
  process.exitCode = 2;
} else {
  let stopped = false;
  process.on("SIGINT", () => { stopped = true; });
  process.on("SIGTERM", () => { stopped = true; });
  const app = new Phase3App(home);
  try {
    if (app.profile.mock) throw new Error("memory worker requires a live role home");
    // A process may have died after the relayer accepted a write. Such a job
    // needs operator reconciliation; the worker must never submit it again.
    app.store.db.prepare("UPDATE memory_jobs SET status='unresolved' WHERE status='submitting'").run();
    while (!stopped) {
      try {
        await app.execute("memory.status", {});
        await app.execute("memory.inventory", {});
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "MEMORY_WORKER_ERROR";
        process.stderr.write(`${code}\n`);
      }
      if (!stopped) await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); process.off("SIGINT", done); process.off("SIGTERM", done); resolve(); };
        const timer = setTimeout(done, 30_000);
        process.once("SIGINT", done);
        process.once("SIGTERM", done);
      });
    }
  } finally { app.close(); }
}
