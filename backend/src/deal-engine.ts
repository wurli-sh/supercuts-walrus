import { createHash } from "node:crypto";
import { validateCapabilityPayload, verifySignedCapability, type SignedCapabilityRegistration } from "./capability.js";
import { DealJournal, dealChildId, type DealView, type ExecuteDealInput } from "./deal.js";
import { fail, SupercutsError } from "./errors.js";
import type { AgentMandate } from "./mandate.js";
import { canonicalJson, validateSettlementPlan, type SettlementPlanV1 } from "./settlement.js";

export interface DealNegotiation {
  transcriptBlobs: Array<{ blobId: string; ciphertextHash: string }>;
  agreementBlobId: string;
  agreementCiphertextHash: string;
}
export interface DealPayment {
  transactionDigest: string;
  finalized: true;
  tatumVerified: true;
  proveMs?: number;
}
export interface DealArtifact {
  blobId: string;
  ciphertextHash: string;
  artifactSha256: string;
  contentType: string;
  metadata: Record<string, unknown>;
  artifactBase64: string;
}
export interface DealOutcome {
  payloadHash: string;
  blobId: string;
  indexed: boolean;
}
export interface DealOutcomeQueued { queued: true; payloadHash: string; }

/** A port owns transport, signing, and finality checks. It must be safe to call
 * again with the same child IDs after a process crash. */
export interface DealPorts {
  readBlob(blobId: string): Promise<Uint8Array>;
  discover(input: ExecuteDealInput): Promise<SignedCapabilityRegistration>;
  plan(input: ExecuteDealInput, registration: SignedCapabilityRegistration, paymentOperationId: string): Promise<SettlementPlanV1>;
  negotiate(input: ExecuteDealInput, registration: SignedCapabilityRegistration, plan: SettlementPlanV1, agreementOperationId: string): Promise<DealNegotiation>;
  pay(input: ExecuteDealInput, plan: SettlementPlanV1, negotiation: DealNegotiation, paymentOperationId: string): Promise<DealPayment | { pending: true }>;
  deliver(input: ExecuteDealInput, plan: SettlementPlanV1, negotiation: DealNegotiation, payment: DealPayment, deliveryOperationId: string): Promise<DealArtifact | { pending: true }>;
  rememberOutcome(input: ExecuteDealInput, plan: SettlementPlanV1, payment: DealPayment, artifact: DealArtifact, outcomeOperationId: string): Promise<DealOutcome | DealOutcomeQueued | { unresolved: true }>;
  inventory(blobId: string): Promise<boolean>;
}

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

export class DealEngine {
  constructor(private readonly journal: DealJournal, private readonly ports: DealPorts, private readonly mandate: AgentMandate) {
    if (mandate.version !== "supercuts.mandate.v2" || mandate.role !== "buyer") fail("DEAL_MANDATE_VERSION", "deal execution requires an owner-issued buyer mandate v2");
  }

  async execute(input: ExecuteDealInput): Promise<DealView> {
    this.journal.create(input);
    return this.resume(input.operationId);
  }

  async resume(operationId: string): Promise<DealView> {
    const input = this.journal.input(operationId);
    let view = this.journal.get(operationId);
    if (view.state === "complete" || view.state === "failed" || view.state === "unresolved") return view;
    if (view.state === "outcome_pending") return this.finishOutcome(operationId, input);
    if (Date.now() > this.mandate.expiresAt) fail("MANDATE_EXPIRED", "owner mandate has expired");
    if (!this.mandate.allowedAssets.includes(input.budget.asset) || BigInt(input.budget.maximum) > BigInt(this.mandate.perDealCeiling)) fail("DEAL_BUDGET_DENIED", "deal budget exceeds the owner mandate");
    if (input.requestedRail === "x402" && (this.mandate.allowPublicX402 !== true || !this.mandate.allowedRails?.includes("x402") || this.mandate.requiredPrivacy === "shielded" || input.privacyHint === "shielded")) fail("DEAL_PUBLIC_RAIL_FORBIDDEN", "owner mandate did not authorize public x402");
    if (view.state === "awaiting_approval" || view.state === "review_required") return view;

    let registration = this.journal.step<SignedCapabilityRegistration>(operationId, "discovery");
    if (!registration) {
      const started = Date.now();
      registration = await this.ports.discover(input);
      await verifySignedCapability(registration);
      const manifestBytes = await this.ports.readBlob(registration.manifestBlobId);
      let publishedManifest: unknown;
      try { publishedManifest = JSON.parse(Buffer.from(manifestBytes).toString()); } catch (error) { return fail("CAPABILITY_BLOB_INVALID", "Walrus capability blob is not JSON", error); }
      if (canonicalJson(publishedManifest) !== canonicalJson(registration.manifest)) fail("CAPABILITY_BLOB_MISMATCH", "Walrus manifest differs from the seller's signed capability");
      this.journal.saveStep(operationId, "discovery", input, registration);
      this.journal.recordTiming(operationId, "discovery", Date.now() - started);
    } else await verifySignedCapability(registration);
    if (input.capabilityId && registration.manifest.capabilityId !== input.capabilityId || input.capabilityClass && registration.manifest.capability !== input.capabilityClass || registration.manifest.asset !== input.budget.asset) fail("DEAL_CAPABILITY_MISMATCH", "seller capability differs from the task selector or asset");
    validateCapabilityPayload(registration.manifest, "input", input.input);
    if (!this.mandate.allowedCounterparties.includes(registration.manifest.sellerId) || this.mandate.allowedCapabilityIds && !this.mandate.allowedCapabilityIds.includes(registration.manifest.capabilityId) || this.mandate.allowedCapabilityClasses && !this.mandate.allowedCapabilityClasses.includes(registration.manifest.capability)) fail("DEAL_SELLER_FORBIDDEN", "signed seller capability is outside the owner mandate");
    if (view.state === "created") view = this.journal.advance(operationId, "created", "discovered");

    const paymentOperationId = dealChildId(operationId, "payment");
    let plan = this.journal.step<SettlementPlanV1>(operationId, "planning");
    if (!plan) {
      const started = Date.now();
      plan = await this.ports.plan(input, registration, paymentOperationId);
      validateSettlementPlan(plan);
      if (plan.operationId !== paymentOperationId || plan.manifestHash !== registration.manifest.manifestHash || plan.asset !== input.budget.asset || BigInt(plan.maximumAmount) > BigInt(input.budget.maximum)) fail("DEAL_PLAN_MISMATCH", "settlement plan exceeds the deal's capability or budget");
      this.journal.saveStep(operationId, "planning", { input, manifestHash: registration.manifest.manifestHash }, plan);
      this.journal.recordTiming(operationId, "planning", Date.now() - started);
    } else validateSettlementPlan(plan);
    if (plan.operationId !== paymentOperationId || plan.manifestHash !== registration.manifest.manifestHash || plan.asset !== input.budget.asset || BigInt(plan.maximumAmount) > BigInt(input.budget.maximum)) fail("DEAL_PLAN_MISMATCH", "saved plan exceeds the deal's capability or budget");
    if (input.requestedRail && plan.rail !== input.requestedRail || input.privacyHint === "shielded" && plan.rail !== "shielded") fail("DEAL_PRIVACY_UNAVAILABLE", "planned rail differs from the requested privacy");
    if (!input.requestedRail && registration.manifest.supportedRails.includes("shielded") && plan.rail !== "shielded") fail("DEAL_PRIVACY_UNAVAILABLE", "shielded is the default rail when the seller supports it");
    if (plan.rail === "x402" && (this.mandate.allowPublicX402 !== true || !this.mandate.allowedRails?.includes("x402") || this.mandate.requiredPrivacy === "shielded")) fail("DEAL_PUBLIC_RAIL_FORBIDDEN", "owner mandate did not authorize public x402");
    if (view.state === "discovered") view = this.journal.advance(operationId, "discovered", "planned", { rail: plan.rail, planHash: plan.planHash });
    if (plan.status === "review_required") return this.journal.advance(operationId, "planned", "review_required");
    if (Date.now() >= plan.expiresAt && ["planned", "negotiating", "agreed", "evidence_ready", "funding_required"].includes(view.state)) return fail("DEAL_PLAN_EXPIRED", "saved settlement plan expired before payment");

    let negotiation = this.journal.step<DealNegotiation>(operationId, "negotiation");
    if (view.state === "planned") view = this.journal.advance(operationId, "planned", "negotiating");
    if (!negotiation) {
      const started = Date.now();
      negotiation = await this.ports.negotiate(input, registration, plan, dealChildId(operationId, "agreement"));
      if (!negotiation.agreementBlobId || !/^[0-9a-f]{64}$/.test(negotiation.agreementCiphertextHash) || !Array.isArray(negotiation.transcriptBlobs) || !negotiation.transcriptBlobs.length) fail("DEAL_AGREEMENT_INVALID", "seller agreement or Walrus transcript evidence is incomplete");
      this.journal.saveStep(operationId, "negotiation", { planHash: plan.planHash }, negotiation);
      this.journal.recordTiming(operationId, "negotiation", Date.now() - started);
    }
    const agreementReadStarted = Date.now();
    for (const item of [...negotiation.transcriptBlobs, { blobId: negotiation.agreementBlobId, ciphertextHash: negotiation.agreementCiphertextHash }]) {
      if (!item.blobId || !/^[0-9a-f]{64}$/.test(item.ciphertextHash) || createHash("sha256").update(await this.ports.readBlob(item.blobId)).digest("hex") !== item.ciphertextHash) fail("WALRUS_BLOB_MISMATCH", "encrypted negotiation or agreement differs from Walrus readback");
    }
    this.journal.recordTiming(operationId, "agreement_readback", Date.now() - agreementReadStarted);
    if (view.state === "negotiating") view = this.journal.advance(operationId, "negotiating", "agreed");
    this.journal.recordBlob(operationId, "agreement", negotiation.agreementCiphertextHash, negotiation.agreementBlobId);
    if (view.state === "agreed") view = this.journal.advance(operationId, "agreed", "evidence_ready");

    let payment = this.journal.step<DealPayment>(operationId, "payment");
    if (view.state === "evidence_ready" || view.state === "funding_required") view = this.journal.advance(operationId, view.state, "payment_pending");
    if (!payment) {
      let candidate;
      const started = Date.now();
      try { candidate = await this.ports.pay(input, plan, negotiation, paymentOperationId); }
      catch (error) {
        if (error instanceof SupercutsError && error.code === "INSUFFICIENT_SHIELDED_BALANCE") return this.journal.advance(operationId, "payment_pending", "funding_required");
        throw error;
      }
      if ("pending" in candidate) return this.journal.get(operationId);
      if (candidate.finalized !== true || candidate.tatumVerified !== true || !candidate.transactionDigest) fail("DEAL_PAYMENT_UNVERIFIED", "payment lacks final Sui and Tatum evidence");
      payment = candidate;
      this.journal.saveStep(operationId, "payment", { planHash: plan.planHash, agreementBlobId: negotiation.agreementBlobId }, payment);
      this.journal.recordTiming(operationId, "payment", Date.now() - started);
      if (typeof payment.proveMs === "number") this.journal.recordTiming(operationId, "proof", payment.proveMs);
    }
    if (view.state === "payment_pending") view = this.journal.advance(operationId, "payment_pending", "paid");

    let artifact = this.journal.step<DealArtifact>(operationId, "delivery");
    if (view.state === "paid") view = this.journal.advance(operationId, "paid", "delivery_pending");
    if (!artifact) {
      const started = Date.now();
      const candidate = await this.ports.deliver(input, plan, negotiation, payment, dealChildId(operationId, "delivery"));
      if ("pending" in candidate) return this.journal.get(operationId);
      if (!candidate.blobId || !/^[0-9a-f]{64}$/.test(candidate.ciphertextHash) || !/^[0-9a-f]{64}$/.test(candidate.artifactSha256)) fail("DEAL_DELIVERY_UNVERIFIED", "seller delivery evidence is incomplete");
      if (typeof candidate.artifactBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(candidate.artifactBase64)) fail("DEAL_DELIVERY_UNVERIFIED", "seller artifact encoding is invalid");
      const artifactBytes = Buffer.from(candidate.artifactBase64, "base64");
      if (!artifactBytes.length || artifactBytes.length > 512 * 1024 || createHash("sha256").update(artifactBytes).digest("hex") !== candidate.artifactSha256) fail("DEAL_DELIVERY_UNVERIFIED", "seller artifact hash or size is invalid");
      validateCapabilityPayload(registration.manifest, "output", candidate.metadata);
      artifact = candidate;
      this.journal.saveStep(operationId, "delivery", { paymentDigest: payment.transactionDigest }, artifact);
      this.journal.recordTiming(operationId, "delivery", Date.now() - started);
    }
    if (createHash("sha256").update(Buffer.from(artifact.artifactBase64, "base64")).digest("hex") !== artifact.artifactSha256) fail("DEAL_DELIVERY_UNVERIFIED", "saved artifact hash differs from delivery evidence");
    const deliveryReadStarted = Date.now();
    if (createHash("sha256").update(await this.ports.readBlob(artifact.blobId)).digest("hex") !== artifact.ciphertextHash) fail("WALRUS_BLOB_MISMATCH", "encrypted delivery differs from Walrus readback");
    this.journal.recordTiming(operationId, "delivery_readback", Date.now() - deliveryReadStarted);
    this.journal.recordBlob(operationId, "delivery", artifact.ciphertextHash, artifact.blobId);
    if (view.state === "delivery_pending") view = this.journal.advance(operationId, "delivery_pending", "delivered");
    if (view.state === "delivered") view = this.journal.advance(operationId, "delivered", "outcome_pending");

    return this.finishOutcome(operationId, input);
  }

  private async finishOutcome(operationId: string, input: ExecuteDealInput): Promise<DealView> {
    const view = this.journal.get(operationId);
    if (view.evidence.outcomeMemory === "indexed") return view.state === "outcome_pending" ? this.journal.advance(operationId, "outcome_pending", "complete") : view;
    if (view.evidence.outcomeMemory === "unresolved") return view;
    const existing = this.journal.outcomeStatus(operationId);
    if (existing?.blobId) {
      const indexed = await this.ports.inventory(existing.blobId);
      this.journal.recordOutcome(operationId, existing.payloadHash, existing.blobId, indexed);
      return this.journal.advance(operationId, "outcome_pending", "complete");
    }
    if (existing) return this.journal.advance(operationId, "outcome_pending", "complete");
    const plan = this.journal.step<SettlementPlanV1>(operationId, "planning") ?? fail("DEAL_PLAN_MISSING", "saved deal plan is missing");
    const payment = this.journal.step<DealPayment>(operationId, "payment") ?? fail("DEAL_PAYMENT_UNVERIFIED", "saved deal payment is missing");
    const artifact = this.journal.step<DealArtifact>(operationId, "delivery") ?? fail("DEAL_DELIVERY_UNVERIFIED", "saved deal delivery is missing");
    let outcome = this.journal.step<DealOutcome>(operationId, "outcome");
    if (!outcome) {
      const started = Date.now();
      const candidate = await this.ports.rememberOutcome(input, plan, payment, artifact, dealChildId(operationId, "outcome"));
      this.journal.recordTiming(operationId, "outcome_queue", Date.now() - started);
      if ("unresolved" in candidate) { this.journal.setOutcomeUnresolved(operationId); return this.journal.advance(operationId, "outcome_pending", "complete"); }
      if ("queued" in candidate) { this.journal.queueOutcome(operationId, candidate.payloadHash); return this.journal.advance(operationId, "outcome_pending", "complete"); }
      if (!candidate.blobId || !/^[0-9a-f]{64}$/.test(candidate.payloadHash)) fail("DEAL_MEMORY_INVALID", "outcome memory is incomplete");
      outcome = candidate;
      this.journal.saveStep(operationId, "outcome", { paymentDigest: payment.transactionDigest, artifactSha256: artifact.artifactSha256 }, outcome);
    }
    const indexed = await this.ports.inventory(outcome.blobId);
    this.journal.recordOutcome(operationId, outcome.payloadHash, outcome.blobId, indexed);
    return this.journal.advance(operationId, "outcome_pending", "complete");
  }
}
