import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Phase3App, initialize } from "../src/phase3.js";
import { ProtocolEngine } from "../src/protocol-engine.js";
import { Groth16Prover } from "../src/prover.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const deployment = JSON.parse(readFileSync(resolve(root, "config/phase1.testnet.json"), "utf8")) as any;

test("live protocol engine reproduces the pinned root and creates a dynamic deposit witness", async () => {
  const engine = await ProtocolEngine.create(deployment);
  assert.equal(engine.tree([]).root.toString(16).padStart(64, "0"), deployment.initialRoot);
  const witness = engine.buildDeposit([], engine.identity(Buffer.alloc(32, 7)), 123n, 456n, 789n);
  assert.equal(witness.opening.amount, 123n); assert.equal(witness.newIndex, 1n);
  assert.equal(witness.input.digestHigh, BigInt(`0x${createHash("sha256").update(witness.statement).digest("hex").slice(0, 32)}`).toString());
  assert.equal(engine.tree([witness.opening.commitment]).root, witness.newRoot);
  const seller = engine.identity(Buffer.alloc(32, 8)), agreement = { dealId: 1n, revision: 2n, transcriptRootLo: 3n, transcriptRootHi: 4n, serviceDigestLo: 5n, serviceDigestHi: 6n, settlementNonceLo: 7n, settlementNonceHi: 8n, paymentAmount: 23n, blinding: 9n, expiry: BigInt(Date.now() + 60_000), buyer: engine.identity(Buffer.alloc(32, 7)), sellerPublicKey: seller.publicKey, recipientSpendTag: engine.spendTag(10n) };
  const values = engine.agreementValues(agreement), signature = engine.sign(seller, 2005n, values.dealCommitment);
  assert.equal(engine.verify(seller.publicKey, 2005n, values.dealCommitment, signature), true);
  assert.equal(engine.verify(seller.publicKey, 2005n, values.dealCommitment + 1n, signature), false);
});

test("live prover doctor verifies every pinned zkey and prepared verifying key", () => {
  const prover = new Groth16Prover({
    artifactRoot: resolve(root, "circuits/build"), snarkjsPath: resolve(root, "circuits/node_modules/.bin/snarkjs"),
    converterPath: resolve(root, "target/debug/supercuts-groth16"), rapidsnarkPath: resolve(root, "circuits/build/tools/rapidsnark-src/build_prover/src/prover"),
    expected: deployment.artifacts,
  });
  const report = prover.doctor(); assert.equal(report.rapidSnark, true); assert.deepEqual(Object.keys(report.artifacts), ["deposit", "transfer", "withdraw"]);
});

test("live initialization provisions separate encrypted signing and transport identities", () => {
  const directory = mkdtempSync(join(tmpdir(), "supercuts-live-profile-")), suiKey = join(directory, "sui.key"), tatumKey = join(directory, "tatum.key"), home = join(directory, "buyer");
  writeFileSync(suiKey, Ed25519Keypair.generate().getSecretKey(), { mode: 0o600 }); writeFileSync(tatumKey, "test-key-not-used", { mode: 0o600 }); chmodSync(directory, 0o700);
  const result = initialize(home, { role: "buyer", "deployment-config": resolve(root, "config/phase1.testnet.json"), "sui-key-file": suiKey, "tatum-key-file": tatumKey, "write-grpc": "https://fullnode.testnet.sui.io:443", "tatum-grpc": "https://example.invalid:443", rapidsnark: resolve(root, "circuits/build/tools/rapidsnark-src/build_prover/src/prover") });
  assert.equal(result.data.mock, false); const app = new Phase3App(home);
  try { assert.equal(app.profile.version, 2); assert.equal(app.store.getSecret("identity:babyjub-seed")?.length, 32); assert.notDeepEqual(app.store.getSecret("identity:x25519-private"), app.store.getSecret("identity:x25519-public")); assert.equal(app.store.getSecret("live:tatum-api-key")?.toString(), "test-key-not-used"); } finally { app.close(); }
});
