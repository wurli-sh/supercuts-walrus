// Loaded before any module that imports node:sqlite, which older Node versions reject at link time.
const MINIMUM = [22, 13] as const;

export function nodeVersionSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  return major > MINIMUM[0] || major === MINIMUM[0] && minor >= MINIMUM[1];
}

/** Exits with a stable error instead of an opaque ERR_UNKNOWN_BUILTIN_MODULE on an old Node. */
export function assertSupportedNode(stream: "stdout" | "stderr" = "stdout"): void {
  if (nodeVersionSupported(process.versions.node)) return;
  const error = { code: "NODE_VERSION_UNSUPPORTED", message: `Supercuts requires Node ${MINIMUM.join(".")} or newer; this is Node ${process.versions.node}`, recovery: "switch to a newer Node (for example nvm use 24) and run the command again", retryable: false, retryWithSameOperationId: false };
  process[stream].write(`${JSON.stringify({ schemaVersion: "supercuts.v1", ok: false, error })}\n`);
  process.exit(1);
}
