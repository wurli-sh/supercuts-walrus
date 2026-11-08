import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fail } from "./errors.js";

/**
 * Decide, before anything is published to Walrus, whether the output file can be written.
 * An existing registration for the same capability is a renewal; anything else is refused.
 */
export function checkRegistrationOutput(path: string, capabilityId: string): { renewing: boolean } {
  if (!existsSync(path)) return { renewing: false };
  let existing: string | undefined;
  try { existing = (JSON.parse(readFileSync(path, "utf8")) as { manifest?: { capabilityId?: unknown } }).manifest?.capabilityId as string | undefined; } catch { /* reported below */ }
  if (existing === capabilityId) return { renewing: true };
  return fail("REGISTRATION_EXISTS", existing
    ? `${path} already holds the registration for ${existing}; choose another output file for ${capabilityId}`
    : `${path} exists and is not a capability registration; choose another output file`);
}

/** Writes owner-only. A renewal swaps the file in atomically and keeps the old one as `<file>.previous`. */
export function writeRegistration(path: string, registration: unknown, renewing: boolean): void {
  const content = `${JSON.stringify(registration, null, 2)}\n`;
  if (!renewing) { writeFileSync(path, content, { mode: 0o600, flag: "wx" }); return; }
  const next = `${path}.next`;
  writeFileSync(next, content, { mode: 0o600 }); chmodSync(next, 0o600);
  renameSync(path, `${path}.previous`);
  renameSync(next, path);
}
