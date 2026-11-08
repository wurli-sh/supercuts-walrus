import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = resolve(fileURLToPath(import.meta.url), "../../src/cli.ts");
const tsx = resolve(fileURLToPath(import.meta.url), "../../node_modules/.bin/tsx");

test("--help after a subcommand prints help instead of running it against the default home", () => {
  const home = mkdtempSync(join(tmpdir(), "supercuts-help-"));
  for (const flag of ["--help", "-h"]) {
    const out = JSON.parse(execFileSync(tsx, [cli, "policy", "add", flag], { env: { ...process.env, HOME: home }, encoding: "utf8" })) as { ok: boolean; schemaVersion: string; command?: string; commands: string[] };
    assert.equal(out.ok, true);
    assert.equal(out.schemaVersion, "supercuts.help.v1");
    assert.equal(out.command, "policy add");
    assert.ok(out.commands.length > 5);
  }
});
