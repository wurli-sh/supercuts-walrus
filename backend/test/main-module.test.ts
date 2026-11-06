import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { isMainModule } from "../src/main-module.js";

test("bin entry detection follows package-manager symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "supercuts-main-")),
    real = join(root, "real.js"),
    link = join(root, "bin-link");
  writeFileSync(real, "");
  symlinkSync(real, link);
  assert.equal(
    isMainModule(pathToFileURL(real).href, link),
    true,
    "a pnpm .bin symlink still starts the service",
  );
  assert.equal(isMainModule(pathToFileURL(real).href, real), true);
  assert.equal(
    isMainModule(pathToFileURL(real).href, join(root, "other.js")),
    false,
  );
  assert.equal(isMainModule(pathToFileURL(real).href, undefined), false);
});
