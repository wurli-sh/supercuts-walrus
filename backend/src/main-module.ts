import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when this module is the process entry point. Package managers (pnpm in particular) launch bins
 * through symlinks, so compare resolved real paths rather than raw `argv[1]` strings.
 */
export function isMainModule(
  importMetaUrl: string,
  entry: string | undefined = process.argv[1],
): boolean {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
