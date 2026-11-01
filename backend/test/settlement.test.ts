import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCapabilityManifest } from "../src/capability.js";
import { Phase3App, initialize } from "../src/phase3.js";
import { createSettlementPlan, validateSettlementMemory, validateSettlementPlan, type PlanningMandate, type SettlementMemoryV1 } from "../src/settlement.js";

const now = 2_000_000_000_000;
const mandate: PlanningMandate = { version: "supercuts.mandate.v1", allowedCounterparties: ["seller-a", "seller-b"], allowedAssets: ["0x2::sui::SUI"], perDealCeiling: "100", requiredPrivacy: "any", expiresAt: now + 1_000_000, allowedRails: ["x402", "shielded"] };
const manifest = (id: string, seller: string, maximum: string, rails: Array<"x402" | "shielded"> = ["x402", "shielded"]) => createCapabilityManifest({ capabilityId: id, sellerId: seller, capability: "artifact.generation", description: "Generate one artifact", inputSchema: {}, outputSchema: {}, supportedRails: rails, priceBand: { minimum: "10", maximum }, asset: "0x2::sui::SUI", endpoint: `https://${seller}.example/artifact`, expiresAt: now + 600_000 });
const memory = (overrides: Omit<Partial<SettlementMemoryV1>, "evidenceHash"> & { evidenceHash?: string | undefined }): SettlementMemoryV1 => {
  const value = { version: "supercuts.settlement-memory.v1", kind: "reliability", provenance: "verified_outcome", scope: {}, createdAt: now - 1, evidenceHash: "ab".repeat(32), signal: { reliability: 0.9 }, ...overrides } as SettlementMemoryV1;
  if (overrides.evidenceHash === undefined && overrides.provenance && overrides.provenance !== "verified_outcome") delete value.evidenceHash; return value;
};

test("settlement planning is deterministic, clamps authority, and ranks safety first", () => {
  const input = { operationId: "pay-1", mandate, manifests: [manifest("b", "seller-b", "60"), manifest("a", "seller-a", "80")], requestedAmount: "999", now };
  const first = createSettlementPlan(input), second = createSettlementPlan(input);
  assert.equal(first.planHash, second.planHash); assert.equal(first.capabilityId, "b"); assert.equal(first.openingAmount, "60");
  assert.ok(first.reasonCodes.includes("REQUESTED_AMOUNT_CLAMPED")); validateSettlementPlan(first);
});

test("trusted scoped memories constrain rail and budget while agent observations stay advisory", () => {
  const selected = manifest("private", "seller-a", "90");
  const plan = createSettlementPlan({ operationId: "pay-private", mandate, manifests: [selected], requestedAmount: "80", now, recalled: [
    { blobId: "owner-privacy", distance: 0.1, memory: memory({ kind: "privacy_rule", provenance: "owner_policy", scope: { capabilityClass: "artifact.generation" }, signal: { requiresShielded: true }, evidenceHash: undefined }) },
    { blobId: "owner-budget", distance: 0.1, memory: memory({ kind: "budget_limit", provenance: "owner_policy", scope: { counterparty: "seller-a" }, signal: { maximumAmount: "40" }, evidenceHash: undefined }) },
    { blobId: "agent-budget", distance: 0.01, memory: memory({ kind: "budget_limit", provenance: "agent_observation", scope: { capabilityId: "private" }, signal: { maximumAmount: "11" }, evidenceHash: undefined }) },
  ] });
  assert.equal(plan.rail, "shielded"); assert.equal(plan.maximumAmount, "40"); assert.equal(plan.openingAmount, "40");
  assert.ok(plan.reasonCodes.includes("MEMORY_UNTRUSTED_ADVISORY"));
});

test("failed verified outcomes and contradictory owner privacy require review", () => {
  const candidate = manifest("review", "seller-a", "50");
  const plan = createSettlementPlan({ operationId: "review", mandate, manifests: [candidate], now, recalled: [
    { blobId: "policy-a", distance: 0.1, memory: memory({ kind: "privacy_rule", provenance: "owner_policy", createdAt: now - 1, signal: { requiresShielded: true }, evidenceHash: undefined }) },
    { blobId: "policy-b", distance: 0.1, memory: memory({ kind: "privacy_rule", provenance: "owner_policy", createdAt: now - 1, signal: { requiresShielded: false }, evidenceHash: undefined }) },
    { blobId: "failure", distance: 0.1, memory: memory({ kind: "outcome", signal: { outcome: "failed" } }) },
  ] });
  assert.equal(plan.status, "review_required"); assert.equal(plan.riskLevel, "review_required"); assert.ok(plan.reasonCodes.includes("OWNER_POLICY_CONFLICT"));
});

test("strict memories reject malformed scores and unproven verified outcomes", () => {
  assert.throws(() => validateSettlementMemory({ ...memory({}), signal: { reliability: Number.NaN } }), { code: "SETTLEMENT_MEMORY_INVALID" });
  assert.throws(() => validateSettlementMemory({ ...memory({}), evidenceHash: undefined }), { code: "SETTLEMENT_MEMORY_EVIDENCE_REQUIRED" });
});

test("mandate-gated execution resolves and consumes the identical stored plan", async () => {
  const home = mkdtempSync(join(tmpdir(), "supercuts-plan-")); initialize(home, { role: "buyer", mock: true });
  const mandatePath = join(home, "mandate.json"), owner = JSON.parse(readFileSync(mandatePath, "utf8")); owner.requireSettlementPlan = true; owner.allowedCapabilityIds = ["cap-live"]; owner.allowedCapabilityClasses = ["artifact.generation"]; owner.allowedRails = ["x402"];
  writeFileSync(mandatePath, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 }); chmodSync(mandatePath, 0o600);
  const app = new Phase3App(home), capability = createCapabilityManifest({ capabilityId: "cap-live", sellerId: "seller-a", capability: "artifact.generation", description: "artifact", inputSchema: {}, outputSchema: {}, supportedRails: ["x402"], priceBand: { minimum: "10", maximum: "40" }, asset: "0x2::sui::SUI", endpoint: "https://seller.example/artifact", expiresAt: Date.now() + 600_000 });
  const execute = async (command: string, args: Record<string, string | boolean>) => { const token = app.approve(app.preview(command, args).challengeId); return (await app.execute(command, { ...args, "approval-token": token.token })).data; };
  try {
    const plan = await execute("settlement.plan", { "operation-id": "pay-live", manifest: JSON.stringify(capability), "requested-amount": "30" });
    assert.equal(plan.status, "approved");
    const receipt = await execute("pay.x402", { "operation-id": "pay-live", amount: "25", counterparty: "seller-a", "resource-url": capability.endpoint, "request-id": "request-1", "plan-hash": String(plan.planHash) });
    assert.equal(receipt.amount, "25");
    const wrong = { "operation-id": "pay-other", amount: "25", counterparty: "seller-a", "resource-url": capability.endpoint, "request-id": "request-2", "plan-hash": String(plan.planHash) };
    const token = app.approve(app.preview("pay.x402", wrong).challengeId); assert.throws(() => app.execute("pay.x402", { ...wrong, "approval-token": token.token }), { code: "SETTLEMENT_PLAN_BINDING_MISMATCH" });
  } finally { app.close(); }
});

test("owner review creates a new approved hash without widening original bounds", async () => {
  const home = mkdtempSync(join(tmpdir(), "supercuts-review-")); initialize(home, { role: "buyer", mock: true }); const app = new Phase3App(home);
  const capability = createCapabilityManifest({ capabilityId: "review-cap", sellerId: "seller-a", capability: "artifact.generation", description: "artifact", inputSchema: {}, outputSchema: {}, supportedRails: ["x402", "shielded"], priceBand: { minimum: "10", maximum: "40" }, asset: "0x2::sui::SUI", endpoint: "https://seller.example/artifact", expiresAt: Date.now() + 600_000 });
  const execute = async (command: string, args: Record<string, string | boolean>) => { const token = app.approve(app.preview(command, args).challengeId); return (await app.execute(command, { ...args, "approval-token": token.token })).data; };
  const timestamp = Date.now();
  try {
    for (const [index, requiresShielded] of [true, false].entries()) await execute("memory.policy", { "operation-id": `policy-${index}`, memory: JSON.stringify({ kind: "privacy_rule", scope: { capabilityId: capability.capabilityId }, createdAt: timestamp, signal: { requiresShielded } }) });
    const review = await execute("settlement.plan", { "operation-id": "review-original", manifest: JSON.stringify(capability), "requested-amount": "30" }); assert.equal(review.status, "review_required");
    const approved = await execute("settlement.approve-review", { "operation-id": "review-payment", "plan-hash": String(review.planHash) });
    assert.equal(approved.status, "approved"); assert.notEqual(approved.planHash, review.planHash); assert.equal(approved.maximumAmount, review.maximumAmount); assert.equal(approved.openingAmount, review.openingAmount); assert.equal(approved.approvedFromPlanHash, review.planHash);
    const paid = await execute("pay.shielded", { "operation-id": "review-payment", amount: "30", counterparty: "seller-a", "request-id": "review-request", "plan-hash": String(approved.planHash) }); assert.equal(paid.status, "finalized");
  } finally { app.close(); }
});
