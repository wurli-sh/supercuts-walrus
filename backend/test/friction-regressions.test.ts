import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analysisAgreementDraft, RemoteBuyer } from "../src/remote-buyer.js";
import { timestampExpirationUnsupported } from "../src/live-runtime.js";
import { acquireRoleHomeLease } from "../src/role-lock.js";
import { errorOutput } from "../src/phase3.js";
import { SupercutsError } from "../src/errors.js";
import { initialize, Phase3App } from "../src/phase3.js";
import { loadMandate } from "../src/mandate.js";
import { calculateFundingPlan } from "../src/funding.js";

test("analysis agreements bind the shielded rail and exact session", () => {
  let next = 0;
  const draft = analysisAgreementDraft({
    sessionId: "analysis-session", transcriptHash: "1".repeat(64), serviceHash: "2".repeat(64),
    paymentAmount: "2000000", buyerPublicKey: ["3", "4"], counterparty: `0x${"ab".repeat(32)}`,
    capabilityId: "competitor-analysis", manifestHash: "5".repeat(64), now: 1_000,
    scalar: () => String(++next),
  });
  assert.equal(draft.sessionId, "analysis-session");
  assert.equal(draft.rail, "shielded");
  assert.equal(draft.expiry, String(1_000 + 30 * 60_000));
  assert.equal(draft.paymentAmount, "2000000");
});

test("timestamp expiration compatibility recognizes thrown and simulated RPC failures", () => {
  assert.equal(timestampExpirationUnsupported(new Error("Feature is not supported: Timestamp-based transaction expiration is not yet supported")), true);
  assert.equal(timestampExpirationUnsupported({ status: { error: "timestamp transaction expiration not supported" } }), true);
  assert.equal(timestampExpirationUnsupported(new Error("insufficient gas")), false);
});

test("one MCP writer owns a role home and a released lease can be reacquired", () => {
  const home = mkdtempSync(join(tmpdir(), "supercuts-role-lock-"));
  const first = acquireRoleHomeLease(home), second = acquireRoleHomeLease(home);
  assert.equal(first.acquired, true); assert.equal(second.acquired, false); assert.equal(second.ownerPid, process.pid);
  first.release();
  const third = acquireRoleHomeLease(home); assert.equal(third.acquired, true); third.release();
});

test("structured errors tell callers whether exact-ID retry is safe", () => {
  const result = errorOutput(new SupercutsError("BROADCAST_UNRESOLVED", "ambiguous")) as { error: { retryable: boolean; retryWithSameOperationId: boolean } };
  assert.equal(result.error.retryable, true); assert.equal(result.error.retryWithSameOperationId, true);
  const mismatch = errorOutput(new SupercutsError("SESSION_MISMATCH", "wrong run")) as { error: { recovery: string } };
  assert.match(mismatch.error.recovery, /status\.session\.runId/);
  const cold = errorOutput(new SupercutsError("X402_FACILITATOR_UNAVAILABLE", "cold")) as { error: { retryable: boolean; retryWithSameOperationId: boolean; recovery: string } };
  assert.equal(cold.error.retryable, true); assert.equal(cold.error.retryWithSameOperationId, true); assert.match(cold.error.recovery, /same operation ID/);
});

test("research workflow derives stable child identities from one root operation", async () => {
  const home = mkdtempSync(join(tmpdir(), "supercuts-research-flow-")); initialize(home, { role: "buyer", mock: true });
  const app = new Phase3App(home), remote = new RemoteBuyer(app, loadMandate(home), "http://127.0.0.1:9999");
  const seen: string[] = [];
  remote.rankBriefs = async () => ({ winner: { capabilityId: "brief" }, analysisCapabilityId: "analysis" });
  remote.purchaseBrief = async (input) => { seen.push(input.operationId, input.requestId); return { artifactSha256: "a".repeat(64) }; };
  remote.agreement = async (input) => { seen.push(input.operationId, input.sessionId); return { artifactSha256: "b".repeat(64) }; };
  remote.settleAnalysis = async (input) => { seen.push(input.operationId, input.sessionId); return { transactionDigest: "tx" }; };
  remote.delivery = async (input) => { seen.push(input.operationId, input.sessionId); return { status: "delivered" }; };
  try {
    const first = await remote.research({ operationId: "root", runId: "run", topic: "Sui", budget: "10" });
    const firstIds = [...seen]; seen.length = 0;
    const second = await remote.research({ operationId: "root", runId: "run", topic: "Sui", budget: "10" });
    assert.equal(first.state, "complete"); assert.equal(second.state, "complete"); assert.deepEqual(seen, []);
    assert.ok(firstIds.every((id) => id.startsWith("research:")));
  } finally { app.close(); }
});

test("guided funding reserves public spend, gas, and positive shielded change", () => {
  const plan = calculateFundingPlan({ address: `0x${"11".repeat(32)}`, publicBalance: 1_000_000n, shieldedBalance: 0n, publicPayment: 1_000_000n, shieldedPayment: 2_000_000n, gasReserve: 100_000_000n, changeReserve: 1_000_000n });
  assert.equal(plan.poolDepositMist, "3000000");
  assert.equal(plan.requiredPublicMist, "104000000");
  assert.equal(plan.publicShortfallMist, "103000000");
  assert.equal(plan.faucetRequired, true); assert.equal(plan.depositRequired, true);
});

test("research resume repeats only a pending delivery", async () => {
  const home = mkdtempSync(join(tmpdir(), "supercuts-research-resume-")); initialize(home, { role: "buyer", mock: true });
  const app = new Phase3App(home), remote = new RemoteBuyer(app, loadMandate(home), "http://127.0.0.1:9999");
  const calls = { rank: 0, brief: 0, agreement: 0, settle: 0, delivery: 0 };
  remote.rankBriefs = async () => { calls.rank++; return { winner: { capabilityId: "brief" }, analysisCapabilityId: "analysis" }; };
  remote.purchaseBrief = async () => { calls.brief++; return { artifactSha256: "a".repeat(64) }; };
  remote.agreement = async () => { calls.agreement++; return { artifactSha256: "b".repeat(64) }; };
  remote.settleAnalysis = async () => { calls.settle++; return { transactionDigest: "tx" }; };
  remote.delivery = async () => ({ status: ++calls.delivery === 1 ? "payment-pending" : "delivered" });
  try {
    await assert.rejects(() => remote.research({ operationId: "resume-root", runId: "run", topic: "Sui", budget: "10" }), { code: "DELIVERY_PENDING" });
    const result = await remote.research({ operationId: "resume-root", runId: "run", topic: "Sui", budget: "10" });
    assert.equal(result.state, "complete");
    assert.deepEqual(calls, { rank: 1, brief: 1, agreement: 1, settle: 1, delivery: 2 });
  } finally { app.close(); }
});
