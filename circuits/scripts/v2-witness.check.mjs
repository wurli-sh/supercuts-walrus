import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { semanticFixtures } from "./semantic.mjs";

const root = resolve(import.meta.dirname, "..", "build", "v2");
for (const name of ["deposit", "transfer", "withdraw"]) {
  if (!existsSync(resolve(root, `${name}_v2_js/${name}_v2.wasm`))) throw new Error("run pnpm --dir circuits compile:v2 before the v2 witness check");
}
const fixtures = await semanticFixtures(2);

function calculate(name, input) {
  const temporary = mkdtempSync(resolve(tmpdir(), "supercuts-v2-witness-"));
  try {
    const inputPath = resolve(temporary, "input.json"), witnessPath = resolve(temporary, "witness.wtns");
    writeFileSync(inputPath, JSON.stringify(input), { mode: 0o600 });
    execFileSync("node", [resolve(root, `${name}_v2_js/generate_witness.js`), resolve(root, `${name}_v2_js/${name}_v2.wasm`), inputPath, witnessPath], { stdio: ["ignore", "ignore", "ignore"] });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

for (const name of ["deposit", "transfer", "withdraw"]) {
  test(`v2 ${name} semantic witness is accepted`, () => calculate(name, fixtures[name]));
}

test("v2 exact exit and zero-value terminal change are accepted", async () => {
  const exact = await semanticFixtures(2, { exitAmount: 2_000_000n, exactExit: true });
  calculate("withdraw", exact.withdraw);
  const full = await semanticFixtures(2, { exitAmount: 3_000_000n, exactExit: true });
  assert.equal(full.withdraw.changeAmount, "0");
  calculate("withdraw", full.withdraw);
});

test("v2 withdrawal rejects changed payout or proof digest", () => {
  const invalid = structuredClone(fixtures.withdraw);
  invalid.statement[170] ^= 1;
  assert.throws(() => calculate("withdraw", invalid));
});

test("v2 withdrawal rejects broken conservation", () => {
  const invalid = structuredClone(fixtures.withdraw);
  invalid.changeAmount = (BigInt(invalid.changeAmount) + 1n).toString();
  assert.throws(() => calculate("withdraw", invalid));
});

test("v2 withdrawal rejects a nonstandard amount in standard mode", () => {
  const invalid = structuredClone(fixtures.withdraw);
  const statement = Buffer.from(invalid.statement);
  statement.writeBigUInt64BE(2_000_000n, 202);
  const digest = createHash("sha256").update(statement).digest();
  invalid.statement = [...statement];
  invalid.digestHigh = BigInt(`0x${digest.subarray(0, 16).toString("hex")}`).toString();
  invalid.digestLow = BigInt(`0x${digest.subarray(16).toString("hex")}`).toString();
  assert.throws(() => calculate("withdraw", invalid));
});

test("v2 withdrawal rejects a stale root", () => {
  const invalid = structuredClone(fixtures.withdraw);
  invalid.statement[137] ^= 1;
  const digest = createHash("sha256").update(Buffer.from(invalid.statement)).digest();
  invalid.digestHigh = BigInt(`0x${digest.subarray(0, 16).toString("hex")}`).toString();
  invalid.digestLow = BigInt(`0x${digest.subarray(16).toString("hex")}`).toString();
  assert.throws(() => calculate("withdraw", invalid));
});
