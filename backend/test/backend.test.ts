import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyPoolEvent, assertPoolState, createPoolIndex, hydrateTranscript, loadStateKey, PaymentConsumptionLedger,
  RelayAdmission, RoleStore, selectRail, sha256, validateTranscript, verifyBinding,
} from "../src/index.js";

function store(): RoleStore {
  const directory = mkdtempSync(join(tmpdir(), "supercuts-test-"));
  return new RoleStore(join(directory, "state.sqlite"), randomBytes(32));
}

test("state store encrypts secrets and prevents a double reservation", () => {
  const state = store();
  state.beginOperation("one", "hash"); state.reserveNote("note", "one");
  state.putSecret("note:one", Buffer.from("private opening"));
  assert.equal(state.getSecret("note:one")?.toString(), "private opening");
  state.beginOperation("two", "hash");
  assert.throws(() => state.reserveNote("note", "two"), { code: "NOTE_RESERVED" });
  state.close();
});

test("pool index rejects inconsistent transition and detects state mismatch", () => {
  const index = createPoolIndex("root-0", 10n);
  applyPoolEvent(index, { kind: "deposit", checkpoint: 11n, transactionIndex: 0n, eventIndex: 0, oldRoot: "root-0", newRoot: "root-1", leafIndex: 0n, noteCommitment: "note" });
  assertPoolState(index, { root: "root-1", nextLeaf: 1n });
  assert.throws(() => applyPoolEvent(index, { kind: "transfer", checkpoint: 12n, transactionIndex: 0n, eventIndex: 0, oldRoot: "bad", newRoot: "root-3", firstLeafIndex: 1n, paymentCommitment: "p", changeCommitment: "c", dealNullifier: "d", inputNullifier: "i" }), { code: "POOL_TRANSITION_INVALID" });
});

test("transcript verification detects replayed sequence and altered ciphertext", async () => {
  const ciphertext = Buffer.from("ciphertext").toString("base64");
  const message = { id: "m1", sessionId: "s", revision: 1, sequence: 0, parentHash: null, author: "buyer", type: "offer" as const, expiresAt: Date.now() + 10000, ciphertext, ciphertextHash: sha256(Buffer.from(ciphertext, "base64")), signature: "ok" };
  const root = await validateTranscript([message], async () => true);
  assert.ok(root);
  await assert.rejects(() => validateTranscript([{ ...message, ciphertext: Buffer.from("altered").toString("base64") }], async () => true), { code: "CIPHERTEXT_TAMPERED" });
  await assert.rejects(() => validateTranscript([message, { ...message, id: "m2" }], async () => true), { code: "TRANSCRIPT_ORDER_INVALID" });
});

test("relayer admits a proof once and rejects replay", async () => {
  const state = store();
  const admission = new RelayAdmission(state, { packageId: "pkg", poolId: "pool", coinType: "coin", verifierVersion: 1 }, async () => true, async () => true);
  const unsigned = { operationId: "op", expiresAt: Date.now() + 10000, nonce: "n", buyerAddress: "buyer", packageId: "pkg", poolId: "pool", coinType: "coin", functionName: "transfer_private" as const, publicStatement: Buffer.from("statement"), proof: Buffer.from("proof") };
  const request = { ...unsigned, challengeSignature: "signature" };
  await admission.admit(request);
  await assert.rejects(() => admission.admit(request), { code: "RELAY_REPLAY" });
  state.close();
});

test("payment consumption binds one finalized payment to one resource", () => {
  const state = store(); const ledger = new PaymentConsumptionLedger(state);
  const payment = { digest: "digest", network: "sui:testnet", asset: "0x2::sui::SUI", amount: 1n, payTo: "0x1", finalized: true };
  ledger.claim(payment, "request-a"); ledger.recordDelivery("request-a", Buffer.from("resource"));
  assert.equal(ledger.getDelivery("request-a")?.toString(), "resource");
  assert.throws(() => ledger.claim(payment, "request-b"), { code: "PAYMENT_CONSUMED" });
  state.close();
});

test("rail policy blocks public payment when privacy or recall requires it", () => {
  assert.equal(selectRail({ hiddenAmountRequired: false, recalledRulesAvailable: true, contradictory: false }, "x402"), "x402");
  assert.throws(() => selectRail({ hiddenAmountRequired: true, recalledRulesAvailable: true, contradictory: false }, "x402"), { code: "PUBLIC_RAIL_FORBIDDEN" });
  assert.throws(() => selectRail({ hiddenAmountRequired: false, recalledRulesAvailable: false, contradictory: false }, "shielded"), { code: "POLICY_RECALL_REQUIRED" });
});

test("state keys require owner-only permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "supercuts-key-")); const path = join(directory, "key");
  writeFileSync(path, randomBytes(32), { mode: 0o600 }); assert.equal(loadStateKey(path).length, 32);
  chmodSync(path, 0o644); assert.throws(() => loadStateKey(path), { code: "STATE_KEY_PERMISSIONS" });
});
