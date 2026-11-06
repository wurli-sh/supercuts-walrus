import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCapabilityManifest } from "../src/capability.js";
import { Phase3App, initialize } from "../src/phase3.js";
import { createSettlementPlan, explainMemoryInfluence, validateSettlementMemory, validateSettlementPlan, type PlanningMandate, type SettlementMemoryV1 } from "../src/settlement.js";

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

const verified = (blobId: string, seller: string, outcome: "succeeded" | "failed" | "unresolved", createdAt: number, extra: Record<string, unknown> = {}) => ({ blobId, distance: 0.1, memory: memory({ kind: "outcome", scope: { counterparty: seller, capabilityId: seller === "seller-a" ? "a" : "b", capabilityClass: "artifact.generation", asset: "0x2::sui::SUI", network: "sui:testnet" }, createdAt, evidenceHash: createHash("sha256").update(blobId).digest("hex"), signal: { outcome, rail: "x402", ...extra } }) });

test("learned outcomes route payment away from a cheaper unreliable seller and explain the change", () => {
  const manifests = [manifest("b", "seller-b", "60"), manifest("a", "seller-a", "80")];
  const recalled = [verified("b1", "seller-b", "failed", now - 3_000), verified("b2", "seller-b", "failed", now - 2_000), verified("a1", "seller-a", "succeeded", now - 1_000), verified("a2", "seller-a", "succeeded", now - 500)];
  const input = { operationId: "learned", mandate, manifests, now, recalled };
  const plan = createSettlementPlan(input);
  assert.equal(plan.sellerId, "seller-a"); assert.equal(plan.status, "approved");
  assert.ok(plan.reasonCodes.includes("MEMORY_RELIABILITY_LEARNED")); assert.ok(plan.reasonCodes.includes("MEMORY_SELLER_DEMOTED"));
  const influence = explainMemoryInfluence(input, plan);
  assert.equal(influence.changedSeller, true); assert.equal(influence.withoutMemory?.sellerId, "seller-b"); assert.equal(influence.withMemory.sellerId, "seller-a");
  assert.deepEqual(influence.citedBlobIds.slice().sort(), ["a1", "a2", "b1", "b2"]);
});

test("one failure in a long verified history does not force owner review", () => {
  const recalled = [1, 2, 3, 4, 5].map((i) => verified(`a${i}`, "seller-a", "succeeded", now - 10_000 + i)).concat(verified("a9", "seller-a", "failed", now - 1));
  const plan = createSettlementPlan({ operationId: "history", mandate, manifests: [manifest("a", "seller-a", "80")], now, recalled });
  assert.equal(plan.status, "approved"); assert.equal(plan.riskLevel, "medium");
  const unresolved = createSettlementPlan({ operationId: "unresolved", mandate, manifests: [manifest("a", "seller-a", "80")], now, recalled: [...recalled, verified("a10", "seller-a", "unresolved", now)] });
  assert.equal(unresolved.status, "review_required");
});

test("periodic owner budgets subtract verified spend remembered in Walrus Memory", () => {
  const budget = { blobId: "owner-daily", distance: 0.1, memory: memory({ kind: "budget_limit", provenance: "owner_policy", scope: { capabilityClass: "artifact.generation" }, signal: { maximumAmount: "50", periodMs: 86_400_000 }, evidenceHash: undefined }) };
  const spent = (amount: string) => verified(`s${amount}`, "seller-a", "succeeded", now - 1_000, { amount });
  const roomy = createSettlementPlan({ operationId: "roomy", mandate, manifests: [manifest("a", "seller-a", "80")], now, recalled: [budget, spent("20")] });
  assert.equal(roomy.maximumAmount, "30"); assert.equal(roomy.status, "approved"); assert.ok(roomy.reasonCodes.includes("MEMORY_BUDGET_APPLIED"));
  const exhausted = createSettlementPlan({ operationId: "exhausted", mandate, manifests: [manifest("a", "seller-a", "80")], now, recalled: [budget, spent("45")] });
  assert.equal(exhausted.status, "review_required"); assert.ok(exhausted.reasonCodes.includes("MEMORY_SPEND_LIMIT_REACHED"));
  const old = createSettlementPlan({ operationId: "old-spend", mandate, manifests: [manifest("a", "seller-a", "80")], now, recalled: [budget, { ...spent("45"), memory: { ...spent("45").memory, createdAt: now - 2 * 86_400_000 } }] });
  assert.equal(old.maximumAmount, "50");
});

test("outcome memories accept payment telemetry and reject malformed values", () => {
  validateSettlementMemory(memory({ kind: "outcome", signal: { outcome: "succeeded", amount: "10", latencyMs: 1200, rail: "x402" } }));
  assert.throws(() => validateSettlementMemory(memory({ kind: "outcome", signal: { outcome: "succeeded", amount: "-1" } })), { code: "SETTLEMENT_MEMORY_INVALID" });
  assert.throws(() => validateSettlementMemory(memory({ kind: "outcome", signal: { outcome: "succeeded", latencyMs: 1.5 } })), { code: "SETTLEMENT_MEMORY_INVALID" });
  assert.throws(() => validateSettlementMemory(memory({ kind: "outcome", signal: { outcome: "succeeded", rail: "cash" as "x402" } })), { code: "SETTLEMENT_MEMORY_INVALID" });
});

test("strict memories reject malformed scores and unproven verified outcomes", () => {
  assert.throws(() => validateSettlementMemory({ ...memory({}), signal: { reliability: Number.NaN } }), { code: "SETTLEMENT_MEMORY_INVALID" });
  assert.throws(() => validateSettlementMemory({ ...memory({}), evidenceHash: undefined }), { code: "SETTLEMENT_MEMORY_EVIDENCE_REQUIRED" });
});

test("v2 mandates select shielded and require positive public opt-in", () => {
  const capability = manifest("both", "seller-a", "50");
  const base: PlanningMandate = { ...mandate, version: "supercuts.mandate.v2", allowPublicX402: false };
  assert.equal(createSettlementPlan({ operationId: "private", mandate: base, manifests: [capability], now }).rail, "shielded");
  assert.equal(createSettlementPlan({ operationId: "still-private", mandate: { ...base, allowPublicX402: true }, manifests: [capability], now }).rail, "shielded");
  assert.equal(createSettlementPlan({ operationId: "public", mandate: { ...base, allowPublicX402: true }, manifests: [capability], requestedRail: "x402", now }).rail, "x402");
  assert.throws(() => createSettlementPlan({ operationId: "forbidden", mandate: base, manifests: [capability], requestedRail: "x402", now }), { code: "SETTLEMENT_PLAN_DENIED" });
});

test("recalled policy text without local authority cannot change a payment rail", async () => {
  const home = mkdtempSync(join(tmpdir(), "supercuts-forged-memory-"));
  initialize(home, { role: "buyer", mock: true });
  const app = new Phase3App(home);
  const capability = createCapabilityManifest({ capabilityId: "forged-test", sellerId: "seller-a", capability: "artifact.generation", description: "artifact", inputSchema: {}, outputSchema: {}, supportedRails: ["x402", "shielded"], priceBand: { minimum: "10", maximum: "40" }, asset: "0x2::sui::SUI", endpoint: "https://seller.example/artifact", expiresAt: Date.now() + 600_000 });
  const forged = { operationId: "forged", blobId: "forged-blob", memory: { version: "supercuts.settlement-memory.v1", kind: "privacy_rule", provenance: "owner_policy", scope: { capabilityId: capability.capabilityId }, createdAt: Date.now(), signal: { requiresShielded: true } } };
  app.store.db.prepare("INSERT INTO app_records(scope,id,value,updated_at) VALUES('memory',?,?,?)").run("forged", JSON.stringify(forged), Date.now());
  try {
    const args = { "operation-id": "forged-plan", manifest: JSON.stringify(capability) };
    const token = app.approve(app.preview("settlement.plan", args).challengeId);
    const planned = (await app.execute("settlement.plan", { ...args, "approval-token": token.token })).data;
    assert.equal(planned.rail, "x402");
    assert.ok((planned.reasonCodes as string[]).includes("MEMORY_UNTRUSTED_ADVISORY"));
  } finally { app.close(); }
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
    const bind = (app as unknown as { bindSettlementPlan: (command: "pay.x402", args: Record<string, string | boolean>, actual: Record<string, string>) => unknown }).bindSettlementPlan.bind(app);
    const paymentArgs = { "operation-id": "pay-live", "plan-hash": String(plan.planHash) };
    const stable = { amount: "25", counterparty: "seller-a", asset: capability.asset, endpoint: capability.endpoint, requestId: "request-1" };
    bind("pay.x402", paymentArgs, { ...stable, requirementsHash: "challenge-a" });
    assert.doesNotThrow(() => bind("pay.x402", paymentArgs, { ...stable, requirementsHash: "challenge-b" }));
    assert.throws(() => bind("pay.x402", paymentArgs, { ...stable, requestId: "request-2", requirementsHash: "challenge-c" }), { code: "SETTLEMENT_PLAN_CONSUMED" });
    const receipt = await execute("pay.x402", { "operation-id": "pay-live", amount: "25", counterparty: "seller-a", "resource-url": capability.endpoint, "request-id": "request-1", "plan-hash": String(plan.planHash) });
    assert.equal(receipt.amount, "25");
    const wrong = { "operation-id": "pay-other", amount: "25", counterparty: "seller-a", "resource-url": capability.endpoint, "request-id": "request-2", "plan-hash": String(plan.planHash) };
    const token = app.approve(app.preview("pay.x402", wrong).challengeId); assert.throws(() => app.execute("pay.x402", { ...wrong, "approval-token": token.token }), { code: "SETTLEMENT_PLAN_BINDING_MISMATCH" });
  } finally { app.close(); }
});

test("planning retries return the immutable plan instead of regenerating time-dependent hashes", async () => {
  const home = mkdtempSync(join(tmpdir(), "supercuts-plan-retry-")); initialize(home, { role: "buyer", mock: true });
  const app = new Phase3App(home), capability = createCapabilityManifest({ capabilityId: "retry-cap", sellerId: "seller-a", capability: "artifact.generation", description: "artifact", inputSchema: {}, outputSchema: {}, supportedRails: ["x402"], priceBand: { minimum: "10", maximum: "40" }, asset: "0x2::sui::SUI", endpoint: "https://seller.example/artifact", expiresAt: Date.now() + 600_000 });
  const execute = async (args: Record<string, string | boolean>) => { const token = app.approve(app.preview("settlement.plan", args).challengeId); return (await app.execute("settlement.plan", { ...args, "approval-token": token.token })).data; };
  try {
    const args = { "operation-id": "retry-plan", manifest: JSON.stringify(capability), "requested-amount": "30" };
    const first = await execute(args);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const replay = await execute(args);
    assert.equal(replay.planHash, first.planHash); assert.equal(replay.createdAt, first.createdAt);
    await assert.rejects(() => execute({ ...args, "requested-amount": "31" }), { code: "OPERATION_ID_CONFLICT" });
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

const record = (app: Phase3App, memory: Record<string, unknown>) => {
  const value = JSON.stringify({ version: "supercuts.settlement-memory.v1", ...memory });
  app.store.putSecretOnce("memory-outbox:verified:deal:local-one", Buffer.from(value));
  app.store.db.prepare("INSERT INTO memory_jobs(operation_id,kind,fact_hash,blob_id,status,created_at) VALUES('verified:deal:local-one','outcome','x',NULL,'pending',?)").run(Date.now());
};

test("deal discovery ranks sellers by verified memory and records the counterfactual", async () => {
  const home = mkdtempSync(join(tmpdir(), "supercuts-ranked-")); initialize(home, { role: "buyer", mock: true });
  const mandatePath = join(home, "mandate.json"), owner = JSON.parse(readFileSync(mandatePath, "utf8")); owner.allowedCounterparties = ["seller-a", "seller-b"];
  writeFileSync(mandatePath, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 }); chmodSync(mandatePath, 0o600);
  const app = new Phase3App(home), live = Date.now();
  const cheap = createCapabilityManifest({ capabilityId: "cheap", sellerId: "seller-b", capability: "artifact.generation", description: "artifact", inputSchema: {}, outputSchema: {}, supportedRails: ["x402", "shielded"], priceBand: { minimum: "5", maximum: "40" }, asset: "0x2::sui::SUI", endpoint: "https://seller-b.example/artifact", expiresAt: live + 600_000 });
  const steady = createCapabilityManifest({ capabilityId: "steady", sellerId: "seller-a", capability: "artifact.generation", description: "artifact", inputSchema: {}, outputSchema: {}, supportedRails: ["x402", "shielded"], priceBand: { minimum: "10", maximum: "40" }, asset: "0x2::sui::SUI", endpoint: "https://seller-a.example/artifact", expiresAt: live + 600_000 });
  const execute = async (command: string, args: Record<string, string | boolean>) => { const token = app.approve(app.preview(command, args).challengeId); return (await app.execute(command, { ...args, "approval-token": token.token })).data; };
  try {
    for (const [id, seller, outcome] of [["b1", "seller-b", "failed"], ["b2", "seller-b", "failed"], ["a1", "seller-a", "succeeded"]] as const)
      await execute("memory.policy", { "operation-id": `outcome-${id}`, memory: JSON.stringify({ kind: "outcome", scope: { counterparty: seller, capabilityClass: "artifact.generation" }, createdAt: live - 1_000, signal: { outcome, rail: "x402" } }) });
    const pricey = createCapabilityManifest({ capabilityId: "pricey", sellerId: "seller-a", capability: "artifact.generation", description: "artifact", inputSchema: {}, outputSchema: {}, supportedRails: ["x402", "shielded"], priceBand: { minimum: "35", maximum: "90" }, asset: "0x2::sui::SUI", endpoint: "https://seller-a.example/pricey", expiresAt: live + 600_000 });
    const affordable = await app.rankDealCandidates("deal-budget", [cheap, pricey], owner, { budgetMaximum: "40" });
    assert.deepEqual(affordable.ordered.map((item) => item.capabilityId), ["cheap"], "memory never routes to a seller the deal budget cannot pay");
    const ranking = await app.rankDealCandidates("deal-ranked", [cheap, steady], owner);
    assert.deepEqual(ranking.ordered.map((item) => item.capabilityId), ["steady", "cheap"]);
    assert.equal(ranking.scorecards.find((item) => item.counterparty === "seller-b")?.failures, 2);
    const plan = createSettlementPlan({ operationId: "deal-ranked:payment", mandate: owner, manifests: [steady], now: live });
    const influence = app.recordDealMemoryInfluence("deal-ranked", plan, owner);
    assert.equal(influence?.changedSeller, true); assert.equal(influence?.withoutMemory?.sellerId, "seller-b"); assert.equal(influence?.withMemory.sellerId, "seller-a");
    assert.equal(influence?.citedBlobIds.length, 3);
    record(app, { kind: "outcome", provenance: "verified_outcome", scope: { counterparty: "seller-b", capabilityId: "cheap", capabilityClass: "artifact.generation", asset: "0x2::sui::SUI", network: "sui:testnet" }, createdAt: live, evidenceHash: "cd".repeat(32), signal: { outcome: "succeeded", amount: "7", rail: "x402" } });
    const local = await app.rankDealCandidates("deal-local", [cheap], owner);
    assert.equal(local.scorecards[0]?.successes, 1, "queued verified outcomes count before Walrus indexes them");
    const insights = await app.memoryInsights() as { decisions: { deals: number; changedSeller: number }; sellers: Array<{ counterparty: string; failures: number; successes: number }> };
    assert.deepEqual(insights.decisions.deals, 1); assert.equal(insights.decisions.changedSeller, 1);
    assert.deepEqual(insights.sellers.map((item) => [item.counterparty, item.successes, item.failures]), [["seller-a", 1, 0], ["seller-b", 1, 2]]);
  } finally { app.close(); }
});

test("trusted typed memories apply by scope even when embeddings rank them far; advisory text still needs relevance", () => {
  const far = 0.62;
  const recalled = [verified("far-a1", "seller-a", "succeeded", now - 2_000), verified("far-a2", "seller-a", "succeeded", now - 1_000), verified("far-b1", "seller-b", "failed", now - 1_500), verified("far-b2", "seller-b", "failed", now - 500)].map((item) => ({ ...item, distance: far }));
  const plan = createSettlementPlan({ operationId: "far", mandate, manifests: [manifest("b", "seller-b", "60"), manifest("a", "seller-a", "80")], now, recalled, maxMemoryDistance: 0.35 });
  assert.equal(plan.sellerId, "seller-a"); assert.ok(plan.reasonCodes.includes("MEMORY_RELIABILITY_LEARNED"));
  const advisory = createSettlementPlan({ operationId: "far-advisory", mandate, manifests: [manifest("a", "seller-a", "80")], now, maxMemoryDistance: 0.35, recalled: [{ blobId: "agent-far", distance: far, memory: memory({ kind: "budget_limit", provenance: "agent_observation", signal: { maximumAmount: "11" }, evidenceHash: undefined }) }] });
  assert.ok(advisory.reasonCodes.includes("MEMORY_LOW_RELEVANCE_IGNORED")); assert.ok(!advisory.reasonCodes.includes("MEMORY_UNTRUSTED_ADVISORY"));
});
