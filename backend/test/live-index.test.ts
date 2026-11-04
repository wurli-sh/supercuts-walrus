import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LivePoolIndex } from "../src/live-index.js";
import { ProtocolEngine } from "../src/protocol-engine.js";
import { RoleStore } from "../src/store.js";

test("live pool index rejects a repeated transaction before replacing cached state", async () => {
  const poolId = `0x${"11".repeat(32)}`, packageId = `0x${"22".repeat(32)}`;
  const deployment = { deploymentDomain: "33".repeat(32), poolId, coinTypeHash: "44".repeat(32), verifierVersion: 2, initialRoot: "00".repeat(32) };
  const provisional = await ProtocolEngine.create(deployment);
  const engine = await ProtocolEngine.create({ ...deployment, initialRoot: provisional.tree([]).root.toString(16).padStart(64, "0") });
  const witness = engine.buildDeposit([], engine.identity(), 10_000_000n);
  const hex = (value: bigint) => value.toString(16).padStart(64, "0");
  const transaction = { Transaction: { digest: "duplicate-digest", checkpoint: "1", status: { success: true }, effects: { changedObjects: [{ objectId: poolId }] }, events: [{ packageId, module: "pool_v2", eventType: "pool_v2::DepositEvent", json: { old_root: hex(engine.tree([]).root), new_root: hex(witness.newRoot), leaf_index: "0", note_commitment: hex(witness.opening.commitment) } }] } };
  const client = { listTransactions: async () => ({ transactions: [transaction, transaction], hasNextPage: false, endCursor: null }), getObject: async () => ({ object: { json: { root: hex(witness.newRoot), next_leaf: "1" } } }) };
  const store = new RoleStore(join(mkdtempSync(join(tmpdir(), "supercuts-live-index-")), "state.sqlite"), randomBytes(32));
  try {
    const index = new LivePoolIndex(store, client as never, engine, packageId, poolId, 0n, "pool_v2");
    await assert.rejects(index.sync(), { code: "POOL_HISTORY_INVALID" });
    assert.equal(index.cached(), undefined);
  } finally { store.close(); }
});
