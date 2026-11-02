import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyPoolEvent, createPoolIndex } from "../src/indexer.js";
import { ProtocolEngine } from "../src/protocol-engine.js";
import { buildWithdrawV2 } from "../src/sui.js";
import { RoleStore } from "../src/store.js";
import { V2ExitQueue } from "../src/v2-exits.js";
import { V2ExitRelayer } from "../src/v2-exit-relayer.js";
import { V2PrefundQueue } from "../src/v2-prefund.js";

const id = `0x${"11".repeat(32)}`;
const deployment = { deploymentDomain: "22".repeat(32), poolId: id, coinTypeHash: "33".repeat(32), verifierVersion: 2, initialRoot: "00".repeat(32) };
async function v2Engine(): Promise<ProtocolEngine> {
  const provisional = await ProtocolEngine.create(deployment);
  return ProtocolEngine.create({ ...deployment, initialRoot: provisional.tree([]).root.toString(16).padStart(64, "0") });
}

test("v2 standard exit conserves value and binds private change", async () => {
  const engine = await v2Engine();
  const identity = engine.identity();
  const note = engine.buildDeposit([], identity, 10_000_000n).opening;
  const exit = engine.buildWithdrawV2([note.commitment], note, id, 1_000_000n);
  assert.equal(exit.statement.length, 291);
  assert.equal(exit.statement[4], 2);
  assert.equal(exit.statement[210], 0);
  assert.equal(exit.changeOpening.amount, 9_000_000n);
  assert.equal(exit.newIndex, 2n);
  assert.equal(exit.amount + exit.changeOpening.amount, note.amount);
  assert.notEqual(exit.newRoot, engine.tree([note.commitment]).root);
  assert.throws(() => engine.buildWithdrawV2([note.commitment], note, id, 2_000_000n), { code: "AMOUNT_INVALID" });
  assert.throws(() => engine.buildWithdrawV2([note.commitment], note, id, 11_000_000n, true), { code: "AMOUNT_INVALID" });
  assert.throws(() => engine.buildDeposit([], identity, 7_000_000n), { code: "AMOUNT_INVALID" });
});

test("v2 exact exit is marked and replayed nullifiers are rejected", async () => {
  const engine = await v2Engine();
  const identity = engine.identity();
  const note = engine.buildDeposit([], identity, 10_000_000n).opening;
  const exit = engine.buildWithdrawV2([note.commitment], note, id, 3_000_000n, true);
  assert.equal(exit.statement[210], 1);
  assert.equal(exit.changeOpening.amount, 7_000_000n);
  const index = createPoolIndex("old", 0n);
  applyPoolEvent(index, { kind: "deposit", checkpoint: 1n, transactionIndex: 0n, eventIndex: 0, oldRoot: "old", newRoot: "funded", leafIndex: 0n, noteCommitment: "note" });
  const event = { kind: "withdraw_v2" as const, checkpoint: 2n, transactionIndex: 0n, eventIndex: 0, oldRoot: "funded", newRoot: "exited", leafIndex: 1n, noteNullifier: "spent", changeCommitment: "change", recipient: id, amount: 3_000_000n, exactExit: true };
  applyPoolEvent(index, event);
  assert.equal(index.nextLeaf, 2n);
  assert.throws(() => applyPoolEvent(index, { ...event, checkpoint: 3n, oldRoot: "exited", leafIndex: 2n }), { code: "POOL_REPLAY" });
  assert.throws(() => buildWithdrawV2({ packageId: id, poolId: id, coinType: "0x2::sui::SUI", root: new Uint8Array(32), noteNullifier: new Uint8Array(32), recipient: id, amount: 3_000_000n, exactExit: false, changeCommitment: new Uint8Array(32), newRoot: new Uint8Array(32), newIndex: 2n, proof: new Uint8Array([1]) }), { code: "POOL_ARGUMENT_INVALID" });
});

test("v2 exit queue uses a fresh payout address, journals retries, and enforces approval", () => {
  const store = new RoleStore(join(mkdtempSync(join(tmpdir(), "supercuts-v2-exits-")), "state.sqlite"), randomBytes(32));
  try {
    const queue = new V2ExitQueue(store), now = Date.now();
    const request = { operationId: "exit-1", commitment: "ab".repeat(32), amount: 1_000_000n, exactExit: false, windowStart: now + 1000, windowEnd: now + 5000 };
    assert.throws(() => queue.queue(request, false, now), { code: "OWNER_APPROVAL_REQUIRED" });
    const first = queue.queue(request, true, now);
    assert.match(first.payoutAddress, /^0x[0-9a-f]{64}$/);
    assert.ok(first.executeAt >= request.windowStart && first.executeAt < request.windowEnd);
    assert.equal(queue.queue(request, true, now).payoutAddress, first.payoutAddress);
    assert.equal(queue.due(first.executeAt).length, 1);
    assert.ok(store.getSecret("v2-exit-payout:exit-1"));
    assert.throws(() => queue.queue({ ...request, operationId: "exit-2" }, true, now));
    const digest = "A".repeat(44);
    assert.throws(() => queue.assertDue("exit-1", now), { code: "EXIT_WINDOW_CLOSED" });
    assert.equal(queue.assertDue("exit-1", first.executeAt).payoutAddress, first.payoutAddress);
    queue.recordSubmission("exit-1", digest);
    assert.equal(queue.due(first.executeAt).length, 0);
    assert.throws(() => queue.recordFinalized("exit-1", "B".repeat(44)), { code: "OPERATION_ID_CONFLICT" });
    queue.recordFinalized("exit-1", digest);
    assert.equal(queue.get("exit-1")?.status, "finalized");
  } finally { store.close(); }
});

test("v2 relayer requires its own pinned signer and rejects changed retries", async () => {
  const store = new RoleStore(join(mkdtempSync(join(tmpdir(), "supercuts-v2-relay-")), "state.sqlite"), randomBytes(32));
  try {
    const signer = Ed25519Keypair.generate();
    store.putSecret("live:relayer-sui-private-key", Buffer.from(signer.getSecretKey()));
    store.putSecret("live:tatum-api-key", Buffer.from("test-key"));
    const pin = { packageId: id, poolId: id, coinType: "0x2::sui::SUI", relayerAddress: signer.toSuiAddress(), writeGrpcEndpoint: "https://example.com", tatumGrpcEndpoint: "https://example.com" };
    assert.throws(() => new V2ExitRelayer(store, { ...pin, relayerAddress: id }), { code: "RELAYER_SIGNER_MISMATCH" });
    const relayer = new V2ExitRelayer(store, pin);
    store.db.prepare("INSERT INTO v2_relay_journal(operation_id,request_hash,note_nullifier,transaction_bytes,signature,digest,status,updated_at) VALUES(?,?,?,?,?,?,'signed',?)")
      .run("exit-1", "old-hash", "aa".repeat(32), Buffer.from([1]), "signature", "digest", Date.now());
    await assert.rejects(() => relayer.submit({ operationId: "exit-1", root: new Uint8Array(32), noteNullifier: new Uint8Array(32), recipient: id, amount: 1_000_000n, exactExit: false, changeCommitment: new Uint8Array(32), newRoot: new Uint8Array(32), newIndex: 1n, proof: new Uint8Array([1]) }), { code: "OPERATION_ID_CONFLICT" });
  } finally { store.close(); }
});

test("v2 prefunding runs a standard deposit callback when due and records its result", async () => {
  const store = new RoleStore(join(mkdtempSync(join(tmpdir(), "supercuts-v2-prefund-")), "state.sqlite"), randomBytes(32));
  try {
    const queue = new V2PrefundQueue(store), now = Date.now();
    assert.throws(() => queue.queue("prefund-1", 10_000_000n, now + 1000, false, now), { code: "OWNER_APPROVAL_REQUIRED" });
    assert.throws(() => queue.queue("prefund-1", 7_000_000n, now + 1000, true, now), { code: "PREFUND_PLAN_INVALID" });
    queue.queue("prefund-1", 10_000_000n, now + 1000, true, now);
    assert.deepEqual(await queue.runDue(now, async () => { throw Error("too early"); }), []);
    const result = await queue.runDue(now + 1000, async (amount, operationId) => {
      assert.equal(amount, 10_000_000n); assert.equal(operationId, "prefund-1");
      return { transactionDigest: "testnet-digest", finalized: true };
    });
    assert.equal(result[0]?.status, "finalized");
    assert.equal(queue.get("prefund-1")?.transactionDigest, "testnet-digest");
    assert.deepEqual(await queue.runDue(now + 2000, async () => { throw Error("replayed"); }), []);
  } finally { store.close(); }
});
