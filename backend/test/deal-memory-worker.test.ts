import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DealJournal, dealChildId } from "../src/deal.js";
import { Phase3App } from "../src/phase3.js";

test("buyer worker indexes completed outcomes and isolates stale memory claims", () => {
  const home = mkdtempSync(join(tmpdir(), "supercuts-memory-worker-"));
  chmodSync(home, 0o700);
  writeFileSync(join(home, "profile.json"), JSON.stringify({ role: "buyer", mock: false }), { mode: 0o600 });
  writeFileSync(join(home, "state.key"), randomBytes(32), { mode: 0o600 });
  const app = new Phase3App(home), journal = new DealJournal(app.store);
  app.store.putSecret("live:memory-config", Buffer.from(JSON.stringify({ namespace: "worker-test" })));
  const createVerifiedDeal = (operationId: string) => {
    journal.create({ operationId, capabilityId: "seller-service", input: {}, budget: { asset: "0x2::sui::SUI", maximum: "10" } });
    const paymentId = dealChildId(operationId, "payment");
    app.store.beginOperation(paymentId, "payment-intent");
    for (const status of ["reserved", "proof_persisted", "broadcast", "finalized", "confirmed"] as const) app.store.transitionOperation(paymentId, status, status === "broadcast" ? `tx-${operationId}` : undefined);
    journal.saveStep(operationId, "payment", {}, { transactionDigest: `tx-${operationId}`, finalized: true, tatumVerified: true });
    journal.recordBlob(operationId, "delivery", "a".repeat(64), `delivery-${operationId}`);
    app.store.db.prepare("UPDATE deal_operations SET state='outcome_pending' WHERE operation_id=?").run(operationId);
    journal.queueOutcome(operationId, "b".repeat(64));
  };
  try {
    createVerifiedDeal("indexed");
    app.store.db.prepare("INSERT INTO memory_jobs(operation_id,kind,fact_hash,blob_id,status,created_at) VALUES(?,?,?,?,?,?)").run("verified:deal:indexed", "outcome", "c".repeat(64), "blob-indexed", "complete", Date.now() - 1_000);
    app.store.db.prepare("INSERT INTO memory_inventory(blob_id,memory_id,namespace,status,expires_at,deleted,updated_at) VALUES(?,?,?,?,NULL,0,?)").run("blob-indexed", "memory-indexed", "worker-test", "active", new Date().toISOString());
    app.syncDealOutcomeJobs();
    assert.equal(journal.get("indexed").state, "complete");
    assert.equal(journal.get("indexed").evidence.outcomeMemory, "indexed");
    assert.equal(journal.evidence(journal.get("indexed").dealId).outcomeMemoryBlobId, "blob-indexed");
    assert.ok((journal.get("indexed").timingsMs?.memory_index ?? 0) >= 0);
    app.syncDealOutcomeJobs();
    assert.equal(journal.get("indexed").state, "complete");

    createVerifiedDeal("stale");
    createVerifiedDeal("active");
    const insertClaim = app.store.db.prepare("INSERT INTO memory_jobs(operation_id,kind,fact_hash,blob_id,status,created_at,claimed_at) VALUES(?,?,?,NULL,'submitting',?,?)");
    insertClaim.run("verified:deal:stale", "outcome", "c".repeat(64), Date.now() - 301_000, Date.now() - 301_000);
    insertClaim.run("verified:deal:active", "outcome", "c".repeat(64), Date.now(), Date.now());
    app.recoverStaleMemorySubmissions();
    assert.equal(journal.get("stale").evidence.outcomeMemory, "unresolved");
    assert.equal(journal.get("stale").nextAction, "reconcile_memory");
    assert.equal(journal.get("active").evidence.outcomeMemory, "pending");
    assert.equal((app.store.db.prepare("SELECT status FROM memory_jobs WHERE operation_id='verified:deal:active'").get() as { status: string }).status, "submitting");
  } finally { app.close(); }
});
