import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface RoleHomeLease {
  acquired: boolean;
  ownerPid?: number;
  release(): void;
}

function active(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Best-effort process lease. SQLite still owns data integrity; this prevents
 * multiple long-running role workers from operating one role home at once. */
export function acquireRoleHomeLease(home: string): RoleHomeLease {
  const path = join(home, ".mcp.lock"), token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, `${JSON.stringify({ pid: process.pid, token, startedAt: Date.now() })}\n`); closeSync(fd);
      let released = false;
      return { acquired: true, release: () => {
        if (released) return; released = true;
        try { const value = JSON.parse(readFileSync(path, "utf8")) as { token?: string }; if (value.token === token) unlinkSync(path); } catch { /* already removed */ }
      } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let ownerPid: number | undefined;
      try { ownerPid = Number((JSON.parse(readFileSync(path, "utf8")) as { pid?: number }).pid); } catch { /* stale malformed lock */ }
      if (ownerPid !== undefined && active(ownerPid)) return { acquired: false, ownerPid, release: () => {} };
      try { unlinkSync(path); } catch { /* another process won the cleanup race */ }
    }
  }
  return { acquired: false, release: () => {} };
}
