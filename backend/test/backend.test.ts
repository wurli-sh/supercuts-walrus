import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyPoolEvent, assertPoolState, createPoolIndex, loadStateKey, noteCommitment, PaymentConsumptionLedger,
  PrivateWallet, RelayAdmission, RoleStore, selectRail, sha256, SupercutsBackend, validateTranscript,
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

test("pool index rejects duplicate positions and duplicate withdrawal nullifiers", () => {
  const index = createPoolIndex("root", 10n);
  const withdrawal = { kind: "withdraw" as const, checkpoint: 11n, transactionIndex: 0n, eventIndex: 0, root: "root", noteNullifier: "spent", recipient: "seller", amount: 1n };
  applyPoolEvent(index, withdrawal);
  assert.throws(() => applyPoolEvent(index, withdrawal), { code: "CHAIN_ORDER_INVALID" });
  assert.throws(() => applyPoolEvent(index, { ...withdrawal, eventIndex: 1 }), { code: "POOL_REPLAY" });
});

test("backend applies an observed event batch atomically", () => {
  const state = store(); const id = `0x${"11".repeat(32)}`;
  const backend = new SupercutsBackend({ network: "testnet", chainId: "chain", packageId: id, poolId: id, coinType: "0x2::sui::SUI", coinTypeHash: "22".repeat(32), deploymentDomain: "33".repeat(32), verifierVersion: 1, deploymentCheckpoint: 10n, initialRoot: "root-0", tatumGrpcEndpoint: "https://example.com", tatumApiKey: "key", writeGrpcEndpoint: "https://example.com", walrusPublisherUrl: "https://example.com", walrusAggregatorUrl: "https://example.com", x402FacilitatorUrl: "https://example.com" }, state);
  const event = { kind: "deposit" as const, checkpoint: 11n, transactionIndex: 0n, eventIndex: 0, oldRoot: "root-0", newRoot: "root-1", leafIndex: 0n, noteCommitment: "note" };
  assert.throws(() => backend.applyObservedEvents([event], { root: "wrong", nextLeaf: 1n }), { code: "POOL_STATE_MISMATCH" });
  assert.deepEqual({ root: backend.poolIndex.root, nextLeaf: backend.poolIndex.nextLeaf, checkpoint: backend.poolIndex.checkpoint }, { root: "root-0", nextLeaf: 0n, checkpoint: 10n }); state.close();
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
  const unsigned = { operationId: "op", expiresAt: Date.now() + 10000, nonce: "n", buyerAddress: "buyer", packageId: "pkg", poolId: "pool", coinType: "coin", verifierVersion: 1, functionName: "transfer_private" as const, publicStatement: Buffer.from("statement"), proof: Buffer.from("proof") };
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

test("operation transitions cannot finalize a different transaction digest", () => {
  const state = store(); state.beginOperation("op", "payload"); state.reserveNote("note", "op");
  state.putSecretOnce("proof:op", Buffer.from("proof")); state.transitionOperation("op", "proof_persisted");
  state.transitionOperation("op", "broadcast", "tx-one");
  assert.throws(() => state.transitionOperation("op", "finalized", "tx-two"), { code: "OPERATION_DIGEST_CONFLICT" });
  assert.equal(state.getOperation("op")?.status, "broadcast"); state.close();
});

test("wallet rejects mismatched, failed, and output-substituted settlement evidence", async () => {
  const state = store(); const wallet = new PrivateWallet(state);
  const event = { kind: "transfer" as const, checkpoint: 1n, transactionIndex: 0n, eventIndex: 0, oldRoot: "a", newRoot: "b", firstLeafIndex: 0n, paymentCommitment: "payment", changeCommitment: "change", dealNullifier: "deal", inputNullifier: "input" };
  const expected = { packageId: "pkg", poolId: "pool", coinType: "SUI", inputNullifier: "input", dealNullifier: "deal", paymentCommitment: "payment", changeCommitment: "change" };
  wallet.prepare("op", "payload", "note", expected, Buffer.from("proof")); wallet.recordBroadcast("op", "expected-digest");
  await assert.rejects(() => wallet.reconcile("op", async () => ({ digest: "other", finalized: true, successful: true, packageId: "pkg", poolId: "pool", coinType: "SUI", events: [event] })), { code: "SETTLEMENT_DIGEST_MISMATCH" });
  await assert.rejects(() => wallet.reconcile("op", async () => ({ digest: "expected-digest", finalized: true, successful: false, packageId: "pkg", poolId: "pool", coinType: "SUI", events: [event] })), { code: "SETTLEMENT_FAILED" });
  await assert.rejects(() => wallet.reconcile("op", async () => ({ digest: "expected-digest", finalized: true, successful: true, packageId: "pkg", poolId: "pool", coinType: "SUI", events: [{ ...event, paymentCommitment: "attacker" }] })), { code: "SETTLEMENT_EVENT_MISSING" });
  state.close();
});

test("note recovery matches the protocol-v1 Poseidon vector", async () => {
  assert.equal(await noteCommitment({
    deployment: 5579146470202348671073344743336905264378519400145015684303482590688196075500n,
    amount: 60n,
    ownerAx: 16732910615942655187662636335172068576158560777545496854589874138562553379942n,
    ownerAy: 9206582214860650670359335938600052544275026383334449444241381785421225342301n,
    spendSecret: 601n,
    salt: 19916388527475935332365183566691977778883021949796783719917153219678246489175n,
  }), "126da3c3fda49259576307d8e5804e8c1c556fafae2df5e3ad430a9a5ce0ab4c");
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
