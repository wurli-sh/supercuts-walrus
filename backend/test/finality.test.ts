import assert from "node:assert/strict";
import test from "node:test";
import { assertSuiFinality, assertTatumFinality } from "../src/finality.js";

const digest = "journaled-digest";
const sui = { Transaction: { digest, checkpoint: "42", status: { success: true } } };
const tatum = { transaction: { digest, checkpoint: { sequenceNumber: 42n }, effects: { status: { success: true } } } };

test("finality requires the same successful journaled digest and checkpoint on both readers", () => {
  assert.equal(assertSuiFinality(sui, digest), "42");
  assert.doesNotThrow(() => assertTatumFinality(tatum, digest, "42"));
  for (const changed of [
    { Transaction: { ...sui.Transaction, digest: "other" } },
    { Transaction: { ...sui.Transaction, effects: { transactionDigest: "other" } } },
    { Transaction: { ...sui.Transaction, checkpoint: null } },
    { FailedTransaction: { ...sui.Transaction, status: { success: false } } },
  ]) assert.throws(() => assertSuiFinality(changed, digest), { code: "TRANSACTION_FINALITY_FAILED" });
  for (const changed of [
    { transaction: { ...tatum.transaction, digest: "other" } },
    { transaction: { ...tatum.transaction, checkpoint: { sequenceNumber: 43n } } },
    { transaction: { ...tatum.transaction, effects: { status: { success: false } } } },
    {},
  ]) assert.throws(() => assertTatumFinality(changed, digest, "42"), { code: "TATUM_TRANSACTION_MISMATCH" });
});
