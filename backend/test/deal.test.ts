import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DealJournal, dealChildId, validateDealInput, type ExecuteDealInput } from "../src/deal.js";
import { RoleStore } from "../src/store.js";

const input: ExecuteDealInput = { operationId: "buyer-job-1", capabilityClass: "artifact.generation", input: { topic: "private" }, budget: { asset: "0x2::sui::SUI", maximum: "50000000" } };

test("deal journal preserves identity and input across restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "supercuts-deal-"));
  const path = join(directory, "state.sqlite"), key = randomBytes(32);
  const firstStore = new RoleStore(path, key);
  const first = new DealJournal(firstStore).create(input);
  assert.equal(first.state, "created");
  assert.equal(new DealJournal(firstStore).create({ ...input, input: { topic: "private" } }).dealId, first.dealId);
  assert.throws(() => new DealJournal(firstStore).create({ ...input, budget: { ...input.budget, maximum: "50000001" } }), { code: "DEAL_OPERATION_CONFLICT" });
  firstStore.close();

  const reopened = new RoleStore(path, key), journal = new DealJournal(reopened);
  assert.equal(journal.get(input.operationId).dealId, first.dealId);
  assert.equal(dealChildId(input.operationId, "payment"), dealChildId(input.operationId, "payment"));
  assert.notEqual(dealChildId(input.operationId, "payment"), dealChildId(input.operationId, "plan"));
  assert.equal(journal.advance(input.operationId, "created", "discovered").state, "discovered");
  assert.equal(journal.advance(input.operationId, "created", "discovered").state, "discovered");
  assert.throws(() => journal.advance(input.operationId, "created", "failed"), { code: "DEAL_STATE_CONFLICT" });
  reopened.close();
});

test("deal input rejects unknown fields, multiple selectors, and noncanonical amounts", () => {
  assert.throws(() => validateDealInput({ ...input, capabilityId: "other" }), { code: "DEAL_INPUT_INVALID" });
  assert.throws(() => validateDealInput({ ...input, budget: { ...input.budget, maximum: "01" } }), { code: "DEAL_INPUT_INVALID" });
  assert.throws(() => validateDealInput({ ...input, allowPublicX402: true }), { code: "DEAL_INPUT_INVALID" });
});

test("deal payment view requires matching live digest and Tatum-confirmed receipt", () => {
  const directory = mkdtempSync(join(tmpdir(), "supercuts-live-deal-view-"));
  const store = new RoleStore(join(directory, "state.sqlite"), randomBytes(32));
  const journal = new DealJournal(store);
  try {
    journal.create(input);
    store.db.exec("CREATE TABLE live_signed_transactions(operation_id TEXT PRIMARY KEY,status TEXT NOT NULL,digest TEXT NOT NULL)");
    store.db.prepare("INSERT INTO live_signed_transactions(operation_id,status,digest) VALUES(?, 'finalized', 'chain-digest')").run(dealChildId(input.operationId, "payment"));
    journal.saveStep(input.operationId, "payment", { planHash: "plan" }, { transactionDigest: "wrong-digest", finalized: true, tatumVerified: true });
    assert.equal(journal.get(input.operationId).evidence.payment, "pending");
    store.db.prepare("UPDATE live_signed_transactions SET digest='wrong-digest' WHERE operation_id=?").run(dealChildId(input.operationId, "payment"));
    assert.equal(journal.get(input.operationId).evidence.payment, "finalized");
  } finally { store.close(); }
});
