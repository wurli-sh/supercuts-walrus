import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { semanticFixtures } from "./semantic.mjs";

const root = resolve(import.meta.dirname, "..");
const fixtures = await semanticFixtures();
const bn254ScalarModulus = BigInt("0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47");

function calculate(name, input) {
  const temporary = mkdtempSync(resolve(tmpdir(), "supercuts-circuit-"));
  const inputPath = resolve(temporary, "input.json");
  const witnessPath = resolve(temporary, "witness.wtns");
  writeFileSync(inputPath, JSON.stringify(input));
  execFileSync("node", [resolve(root, `build/${name}_js/generate_witness.js`),
    resolve(root, `build/${name}_js/${name}.wasm`), inputPath, witnessPath],
  { stdio: ["ignore", "ignore", "ignore"] });
}

for (const name of ["deposit", "transfer", "withdraw"]) {
  test(`${name} semantic witness is accepted`, () => calculate(name, fixtures[name]));
}

test("changed statement digest is rejected", () => {
  const invalid = structuredClone(fixtures.deposit);
  invalid.digestLow = (BigInt(invalid.digestLow) + 1n).toString();
  assert.throws(() => calculate("deposit", invalid));
});

test("noncanonical BN254 field encodings are rejected", () => {
  const invalid = structuredClone(fixtures.deposit);
  const statement = Buffer.from(invalid.statement);
  const noteOffset = 114;
  const note = BigInt(`0x${statement.subarray(noteOffset, noteOffset + 32).toString("hex")}`);
  Buffer.from((note + bn254ScalarModulus).toString(16).padStart(64, "0"), "hex")
    .copy(statement, noteOffset);
  invalid.statement = [...statement];
  const digest = createHash("sha256").update(statement).digest();
  invalid.digestHigh = BigInt(`0x${digest.subarray(0, 16).toString("hex")}`).toString();
  invalid.digestLow = BigInt(`0x${digest.subarray(16).toString("hex")}`).toString();
  assert.throws(() => calculate("deposit", invalid));
});

test("invalid transfer conservation is rejected", () => {
  const invalid = structuredClone(fixtures.transfer);
  invalid.changeAmount = (BigInt(invalid.changeAmount) + 1n).toString();
  assert.throws(() => calculate("transfer", invalid));
});

test("forged seller authorization is rejected", () => {
  const invalid = structuredClone(fixtures.transfer);
  invalid.sellerS = (BigInt(invalid.sellerS) + 1n).toString();
  assert.throws(() => calculate("transfer", invalid));
});

test("forged Merkle append is rejected", () => {
  const invalid = structuredClone(fixtures.transfer);
  invalid.changeAppendPath[0] = (BigInt(invalid.changeAppendPath[0]) + 1n).toString();
  assert.throws(() => calculate("transfer", invalid));
});

test("wrong withdrawal secret is rejected", () => {
  const invalid = structuredClone(fixtures.withdraw);
  invalid.spendSecret = (BigInt(invalid.spendSecret) + 1n).toString();
  assert.throws(() => calculate("withdraw", invalid));
});

