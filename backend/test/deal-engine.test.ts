import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { createCapabilityManifest, validateCapabilityPayload, type SignedCapabilityRegistration } from "../src/capability.js";
import { DealEngine, type DealPorts } from "../src/deal-engine.js";
import { DealJournal, type ExecuteDealInput } from "../src/deal.js";
import { createSettlementPlan } from "../src/settlement.js";
import { RoleStore } from "../src/store.js";
import type { AgentMandate } from "../src/mandate.js";
import { SupercutsError } from "../src/errors.js";

test("composite deal resumes after an inventory delay without another payment", async () => {
  const signer = Ed25519Keypair.generate();
  const manifest = createCapabilityManifest({ capabilityId: "artifact-one", sellerId: signer.toSuiAddress(), capability: "artifact.generation", description: "Generate artifact", inputSchema: {}, outputSchema: {}, supportedRails: ["shielded", "x402"], priceBand: { minimum: "10", maximum: "30" }, asset: "0x2::sui::SUI", endpoint: "https://seller.example/resource", expiresAt: Date.now() + 600_000 });
  const registration: SignedCapabilityRegistration = { manifest, manifestBlobId: "blob-manifest", transportPublicKey: "seller-transport", sellerSignature: (await signer.signPersonalMessage(Buffer.from(`${manifest.manifestHash}:seller-transport`))).signature };
  const mandate: AgentMandate = { version: "supercuts.mandate.v2", owner: "test-owner", role: "buyer", allowedCommands: [], allowedCounterparties: [manifest.sellerId], allowedAssets: [manifest.asset], allowedRails: ["shielded", "x402"], allowPublicX402: false, perDealCeiling: "30", totalRunBudget: "30", requiredPrivacy: "any", expiresAt: Date.now() + 600_000 };
  const input: ExecuteDealInput = { operationId: "deal-restart", capabilityId: manifest.capabilityId, input: { task: "private" }, budget: { asset: manifest.asset, maximum: "30" } };
  const home = mkdtempSync(join(tmpdir(), "supercuts-engine-")), path = join(home, "state.sqlite"), key = randomBytes(32);
  const store = new RoleStore(path, key);
  let paid = 0, remembered = 0, inventoryReads = 0, needsFunding = true, queueMode = false;
  const artifact = Buffer.from("private artifact"), artifactSha256 = createHash("sha256").update(artifact).digest("hex");
  const transcriptBytes = Buffer.from("encrypted transcript"), agreementBytes = Buffer.from("encrypted agreement"), deliveryBytes = Buffer.from("encrypted delivery");
  const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  const blobs = new Map<string, Uint8Array>([[registration.manifestBlobId, Buffer.from(JSON.stringify(manifest))], ["transcript-one", transcriptBytes], ["agreement-one", agreementBytes], ["delivery-one", deliveryBytes]]);
  const ports: DealPorts = {
    readBlob: async (id) => blobs.get(id) ?? new Uint8Array(),
    discover: async () => registration,
    plan: async (_input, _registration, paymentOperationId) => createSettlementPlan({ operationId: paymentOperationId, mandate, manifests: [manifest], now: Date.now() }),
    negotiate: async () => ({ transcriptBlobs: [{ blobId: "transcript-one", ciphertextHash: sha(transcriptBytes) }], agreementBlobId: "agreement-one", agreementCiphertextHash: sha(agreementBytes) }),
    pay: async (_input, _plan, _negotiation, paymentOperationId) => {
      if (needsFunding) { needsFunding = false; throw new SupercutsError("INSUFFICIENT_SHIELDED_BALANCE", "test buyer needs a deposit"); }
      paid++;
      store.beginOperation(paymentOperationId, "payment-intent");
      for (const status of ["reserved", "proof_persisted", "broadcast", "finalized", "confirmed"] as const) store.transitionOperation(paymentOperationId, status, status === "broadcast" ? "tx-one" : undefined);
      return { transactionDigest: "tx-one", finalized: true, tatumVerified: true };
    },
    deliver: async () => ({ blobId: "delivery-one", ciphertextHash: sha(deliveryBytes), artifactSha256, contentType: "application/json", metadata: {}, artifactBase64: artifact.toString("base64") }),
    rememberOutcome: async () => { remembered++; return queueMode ? { queued: true as const, payloadHash: "d".repeat(64) } : { payloadHash: "d".repeat(64), blobId: "outcome-one", indexed: false }; },
    inventory: async () => ++inventoryReads > 1,
  };
  try {
    const journal = new DealJournal(store), engine = new DealEngine(journal, ports, mandate);
    const funding = await engine.execute(input);
    assert.equal(funding.state, "funding_required");
    assert.equal(funding.nextAction, "fund_buyer");
    const pending = await engine.resume(input.operationId);
    assert.equal(pending.state, "outcome_pending");
    assert.equal(pending.rail, "shielded");
    assert.equal(journal.evidence(pending.dealId).paymentFinalized, true);
    const complete = await new DealEngine(new DealJournal(store), ports, mandate).resume(input.operationId);
    assert.equal(complete.state, "complete");
    assert.equal(complete.dealId, pending.dealId);
    assert.equal(paid, 1);
    assert.equal(remembered, 1);
    assert.equal(journal.evidence(complete.dealId).inventory, "indexed");
    assert.deepEqual(journal.evidence(complete.dealId).transcriptBlobIds, ["transcript-one"]);
    assert.deepEqual(journal.delivery(complete.dealId).artifact, artifact);
    queueMode = true;
    const queuedInput = { ...input, operationId: "queued-outcome-deal" };
    const readsBeforeQueue = inventoryReads;
    const queued = await engine.execute(queuedInput);
    assert.equal(queued.state, "outcome_pending");
    assert.equal(queued.nextAction, "check_memory");
    assert.equal(queued.evidence.payment, "finalized");
    assert.equal(queued.evidence.delivery, "verified");
    assert.deepEqual(journal.delivery(queued.dealId).artifact, artifact);
    assert.equal(inventoryReads, readsBeforeQueue);
    assert.equal((await engine.execute(queuedInput)).state, "outcome_pending");
    assert.equal(paid, 2);
    assert.equal(remembered, 2);
    journal.setOutcomeUnresolved(queuedInput.operationId);
    assert.equal(journal.get(queuedInput.operationId).nextAction, "reconcile_memory");
    assert.equal((await engine.resume(queuedInput.operationId)).state, "outcome_pending");
    assert.equal(paid, 2);
    blobs.set("agreement-one", Buffer.from("tampered agreement"));
    await assert.rejects(() => engine.execute({ ...input, operationId: "tampered-deal" }), { code: "WALRUS_BLOB_MISMATCH" });
    assert.equal(paid, 2);
  } finally { store.close(); }
});

test("composite deal rejects public rail before seller or payment I/O", async () => {
  const home = mkdtempSync(join(tmpdir(), "supercuts-engine-deny-"));
  const store = new RoleStore(join(home, "state.sqlite"), randomBytes(32));
  const mandate: AgentMandate = { version: "supercuts.mandate.v2", owner: "owner", role: "buyer", allowedCommands: [], allowedCounterparties: [], allowedAssets: ["0x2::sui::SUI"], allowedRails: ["shielded", "x402"], allowPublicX402: false, perDealCeiling: "30", totalRunBudget: "30", requiredPrivacy: "any", expiresAt: Date.now() + 60_000 };
  let called = false;
  const ports = { discover: async () => { called = true; throw new Error("seller called"); } } as unknown as DealPorts;
  try {
    const engine = new DealEngine(new DealJournal(store), ports, mandate);
    await assert.rejects(() => engine.execute({ operationId: "public-denied", capabilityClass: "artifact.generation", input: {}, budget: { asset: "0x2::sui::SUI", maximum: "20" }, requestedRail: "x402" }), { code: "DEAL_PUBLIC_RAIL_FORBIDDEN" });
    assert.equal(called, false);
  } finally { store.close(); }
});

test("signed capability schemas validate task input and seller metadata", () => {
  const manifest = createCapabilityManifest({ capabilityId: "schema-test", sellerId: "seller", capability: "artifact.generation", description: "artifact", inputSchema: { type: "object", required: ["task"], properties: { task: { type: "string" } }, additionalProperties: false }, outputSchema: { type: "object", required: ["quality"], properties: { quality: { type: "number", minimum: 0, maximum: 1 } }, additionalProperties: false }, supportedRails: ["shielded"], priceBand: { minimum: "1", maximum: "2" }, asset: "0x2::sui::SUI", endpoint: "https://seller.example/resource", expiresAt: Date.now() + 60_000 });
  validateCapabilityPayload(manifest, "input", { task: "work" });
  validateCapabilityPayload(manifest, "output", { quality: 0.8 });
  assert.throws(() => validateCapabilityPayload(manifest, "input", { other: "work" }), { code: "CAPABILITY_PAYLOAD_INVALID" });
  assert.throws(() => validateCapabilityPayload(manifest, "output", { quality: 2 }), { code: "CAPABILITY_PAYLOAD_INVALID" });
});
