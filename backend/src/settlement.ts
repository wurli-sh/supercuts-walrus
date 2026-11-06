import { createHash } from "node:crypto";
import type { CapabilityManifest, CapabilityRail } from "./capability.js";
import { fail } from "./errors.js";
import { buildScorecard, spentSince, type SellerScorecard } from "./memory-scorecard.js";

export const SETTLEMENT_PLAN_VERSION = "supercuts.settlement-plan.v1" as const;
export const SETTLEMENT_MEMORY_VERSION = "supercuts.settlement-memory.v1" as const;
export type SettlementRisk = "low" | "medium" | "review_required";
export type SettlementMemoryProvenance = "owner_policy" | "verified_outcome" | "agent_observation" | "legacy_untrusted";
export type SettlementMemoryKind = "privacy_rule" | "budget_limit" | "reliability" | "quality" | "outcome";

export interface SettlementMemoryScope { counterparty?: string; capabilityId?: string; capabilityClass?: string; network?: "sui:testnet"; asset?: string; }
export interface SettlementMemoryV1 {
  version: typeof SETTLEMENT_MEMORY_VERSION; kind: SettlementMemoryKind; provenance: SettlementMemoryProvenance;
  scope: SettlementMemoryScope; createdAt: number; evidenceHash?: string;
  observation?: string;
  signal: { requiresShielded?: boolean; maximumAmount?: string; reliability?: number; quality?: number; outcome?: "succeeded" | "failed" | "unresolved"; amount?: string; latencyMs?: number; rail?: CapabilityRail; periodMs?: number };
}
export interface SettlementCitation { blobId: string; kind: SettlementMemoryKind | "legacy"; provenance: SettlementMemoryProvenance; distance: number; }
export type SettlementReasonCode =
  | "MANDATE_DEFAULTS_APPLIED" | "MEMORY_PRIVACY_APPLIED" | "MEMORY_BUDGET_APPLIED" | "MEMORY_OUTCOME_APPLIED"
  | "MEMORY_LOW_RELEVANCE_IGNORED" | "MEMORY_UNTRUSTED_ADVISORY" | "OWNER_POLICY_CONFLICT"
  | "RISK_LOW" | "RISK_MEDIUM" | "RISK_REVIEW_REQUIRED" | "RAIL_X402_SELECTED"
  | "RAIL_SHIELDED_SELECTED" | "REQUESTED_AMOUNT_CLAMPED" | "OWNER_REVIEW_APPROVED"
  | "MEMORY_RELIABILITY_LEARNED" | "MEMORY_SELLER_DEMOTED" | "MEMORY_SPEND_LIMIT_REACHED" | "MEMORY_PRIVACY_OVERRODE_RAIL";
export interface SettlementPlanV1 {
  version: typeof SETTLEMENT_PLAN_VERSION; planHash: string; operationId: string; status: "approved" | "review_required";
  mandateHash: string; manifestHash: string; capabilityId: string; capabilityClass: string; sellerId: string; endpoint: string;
  network: "sui:testnet"; asset: string; rail: CapabilityRail; openingAmount: string; maximumAmount: string;
  manifestMinimum: string; manifestMaximum: string; riskLevel: SettlementRisk; createdAt: number; expiresAt: number;
  citations: SettlementCitation[]; reasonCodes: SettlementReasonCode[]; approvedFromPlanHash?: string;
}
export interface PlanningMandate {
  version: "supercuts.mandate.v1" | "supercuts.mandate.v2"; allowedCounterparties: string[]; allowedAssets: string[]; perDealCeiling: string;
  requiredPrivacy: "any" | "shielded"; expiresAt: number; allowedCapabilityIds?: string[];
  allowedCapabilityClasses?: string[]; allowedRails?: CapabilityRail[]; allowPublicX402?: boolean;
}
export interface RecalledSettlementMemory { blobId: string; distance: number; memory?: SettlementMemoryV1; legacy?: boolean; }

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  if (typeof value === "number" && !Number.isFinite(value)) fail("SETTLEMENT_JSON_INVALID", "settlement records must contain finite JSON values");
  const encoded = JSON.stringify(value); if (encoded === undefined) fail("SETTLEMENT_JSON_INVALID", "settlement records must be JSON-compatible"); return encoded;
}
const digest = (domain: string, value: unknown) => createHash("sha256").update(canonicalJson({ domain, value })).digest("hex");
export const settlementMandateHash = (mandate: PlanningMandate): string => digest("supercuts-settlement-mandate-v1", mandate);
export function settlementPlanHash(plan: Omit<SettlementPlanV1, "planHash">): string { return digest("supercuts-settlement-plan-v1", plan); }
const unsigned = (value: unknown): value is string => typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => { if (Object.keys(value).some((key) => !keys.includes(key))) fail("SETTLEMENT_MEMORY_INVALID", "record contains unknown fields"); };

export function validateSettlementMemory(value: unknown, assignedProvenance?: SettlementMemoryProvenance): asserts value is SettlementMemoryV1 {
  if (!object(value)) fail("SETTLEMENT_MEMORY_INVALID", "settlement memory must be an object");
  const raw = value as Record<string, unknown>;
  exactKeys(raw, ["version", "kind", "provenance", "scope", "createdAt", "evidenceHash", "observation", "signal"]);
  if (raw.version !== SETTLEMENT_MEMORY_VERSION || !["privacy_rule", "budget_limit", "reliability", "quality", "outcome"].includes(String(raw.kind))) fail("SETTLEMENT_MEMORY_INVALID", "settlement memory version or kind is invalid");
  if (!["owner_policy", "verified_outcome", "agent_observation", "legacy_untrusted"].includes(String(raw.provenance))) fail("SETTLEMENT_MEMORY_INVALID", "settlement memory provenance is invalid");
  if (assignedProvenance && raw.provenance !== assignedProvenance) fail("SETTLEMENT_MEMORY_PROVENANCE", "memory provenance is assigned by Supercuts");
  if (!Number.isSafeInteger(raw.createdAt) || Number(raw.createdAt) < 0 || !object(raw.scope) || !object(raw.signal)) fail("SETTLEMENT_MEMORY_INVALID", "memory timestamp, scope, or signal is invalid");
  if (raw.observation !== undefined && (typeof raw.observation !== "string" || !raw.observation.trim() || raw.observation.length > 512)) fail("SETTLEMENT_MEMORY_INVALID", "memory observation must be a short non-empty string");
  const scope = raw.scope as Record<string, unknown>, signal = raw.signal as SettlementMemoryV1["signal"];
  exactKeys(scope, ["counterparty", "capabilityId", "capabilityClass", "network", "asset"]); exactKeys(signal as Record<string, unknown>, ["requiresShielded", "maximumAmount", "reliability", "quality", "outcome", "amount", "latencyMs", "rail", "periodMs"]);
  for (const item of Object.values(scope)) if (typeof item !== "string" || !item || item.length > 1024) fail("SETTLEMENT_MEMORY_INVALID", "memory scope fields must be non-empty strings");
  if (scope.network !== undefined && scope.network !== "sui:testnet") fail("SETTLEMENT_MEMORY_INVALID", "memory network must be sui:testnet");
  if (signal.requiresShielded !== undefined && typeof signal.requiresShielded !== "boolean" || signal.maximumAmount !== undefined && !unsigned(signal.maximumAmount)) fail("SETTLEMENT_MEMORY_INVALID", "memory privacy or amount signal is invalid");
  for (const score of [signal.reliability, signal.quality]) if (score !== undefined && (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1)) fail("SETTLEMENT_MEMORY_INVALID", "memory scores must be finite values in [0,1]");
  if (signal.outcome !== undefined && !["succeeded", "failed", "unresolved"].includes(signal.outcome)) fail("SETTLEMENT_MEMORY_INVALID", "memory outcome is invalid");
  if (signal.amount !== undefined && !unsigned(signal.amount) || signal.rail !== undefined && !["x402", "shielded"].includes(signal.rail)) fail("SETTLEMENT_MEMORY_INVALID", "memory payment amount or rail is invalid");
  for (const value of [signal.latencyMs, signal.periodMs]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) fail("SETTLEMENT_MEMORY_INVALID", "memory durations must be non-negative integers");
  if (signal.periodMs !== undefined && (raw.kind !== "budget_limit" || signal.periodMs === 0)) fail("SETTLEMENT_MEMORY_INVALID", "only budget limits may declare a positive period");
  const required: Record<SettlementMemoryKind, keyof SettlementMemoryV1["signal"]> = { privacy_rule: "requiresShielded", budget_limit: "maximumAmount", reliability: "reliability", quality: "quality", outcome: "outcome" };
  if (signal[required[raw.kind as SettlementMemoryKind]] === undefined) fail("SETTLEMENT_MEMORY_INVALID", "memory kind does not have its required signal");
  if (raw.provenance === "verified_outcome" && (typeof raw.evidenceHash !== "string" || !/^[0-9a-f]{64}$/.test(raw.evidenceHash))) fail("SETTLEMENT_MEMORY_EVIDENCE_REQUIRED", "verified outcomes require a SHA-256 evidence hash");
  if (raw.evidenceHash !== undefined && (typeof raw.evidenceHash !== "string" || !/^[0-9a-f]{64}$/.test(raw.evidenceHash))) fail("SETTLEMENT_MEMORY_INVALID", "evidence hash must be SHA-256 hex");
}

function specificity(scope: SettlementMemoryScope, manifest: CapabilityManifest): number {
  if (scope.network && scope.network !== "sui:testnet" || scope.asset && scope.asset !== manifest.asset || scope.counterparty && scope.counterparty !== manifest.sellerId || scope.capabilityClass && scope.capabilityClass !== manifest.capability || scope.capabilityId && scope.capabilityId !== manifest.capabilityId) return -1;
  return scope.capabilityId ? 4 : scope.capabilityClass ? 3 : scope.counterparty ? 2 : 1;
}
interface Candidate { manifest: CapabilityManifest; rail: CapabilityRail; reliability: number; quality: number; maximum: bigint; risk: SettlementRisk; citations: SettlementCitation[]; reasons: SettlementReasonCode[]; conflict: boolean; card: SellerScorecard; }
export interface PlanningInput { operationId: string; mandate: PlanningMandate; manifests: CapabilityManifest[]; requestedAmount?: string; privacyHint?: "any" | "shielded"; requestedRail?: CapabilityRail; recalled?: RecalledSettlementMemory[]; maxMemoryDistance?: number; now?: number }

/**
 * Trusted typed memories (owner policy or verified outcome) are matched by their structured scope, so a
 * semantic distance cutoff would only drop real evidence: embeddings of JSON records rank far from scope
 * queries. Advisory and legacy text still needs semantic relevance.
 */
export function isRelevantMemory(item: RecalledSettlementMemory, maxDistance: number): boolean {
  if (!Number.isFinite(item.distance) || item.distance < 0) return false;
  if (item.memory && (item.memory.provenance === "owner_policy" || item.memory.provenance === "verified_outcome")) return true;
  return item.distance <= maxDistance;
}

export function createSettlementPlan(input: PlanningInput): SettlementPlanV1 {
  const now = input.now ?? Date.now(), maxDistance = input.maxMemoryDistance ?? 0.35;
  if (!input.operationId || input.operationId.length > 256 || !input.manifests.length) fail("SETTLEMENT_PLAN_INVALID", "planning requires an operation ID and at least one capability");
  if (input.requestedAmount !== undefined && !unsigned(input.requestedAmount)) fail("SETTLEMENT_PLAN_INVALID", "requestedAmount must be canonical unsigned base units");
  if (!Number.isFinite(maxDistance) || maxDistance < 0 || maxDistance > 1 || now >= input.mandate.expiresAt) fail("SETTLEMENT_PLAN_DENIED", "planning limits or owner mandate are invalid");
  const relevant = (item: RecalledSettlementMemory) => isRelevantMemory(item, maxDistance);
  const ignored = (input.recalled ?? []).filter((item) => !relevant(item));
  const recalled = (input.recalled ?? []).filter(relevant);
  for (const item of recalled) if (item.memory) validateSettlementMemory(item.memory);
  const candidates: Candidate[] = [];
  for (const manifest of input.manifests) {
    if (manifest.expiresAt <= now || input.mandate.allowedCapabilityIds && !input.mandate.allowedCapabilityIds.includes(manifest.capabilityId) || input.mandate.allowedCapabilityClasses && !input.mandate.allowedCapabilityClasses.includes(manifest.capability) || !input.mandate.allowedCounterparties.includes(manifest.sellerId) || !input.mandate.allowedAssets.includes(manifest.asset)) continue;
    const matching = recalled.filter((item) => item.memory && specificity(item.memory.scope, manifest) >= 0);
    const citations: SettlementCitation[] = recalled.map((item) => ({ blobId: item.blobId, kind: item.memory?.kind ?? "legacy", provenance: item.memory?.provenance ?? "legacy_untrusted", distance: item.distance }));
    const trusted = matching.filter((item) => item.memory && ["owner_policy", "verified_outcome"].includes(item.memory.provenance));
    const latest = (kind: SettlementMemoryKind, provenance?: SettlementMemoryProvenance): SettlementMemoryV1[] => {
      let values = trusted.filter((item) => item.memory!.kind === kind && (!provenance || item.memory!.provenance === provenance));
      if (!provenance && values.some((item) => item.memory!.provenance === "owner_policy")) values = values.filter((item) => item.memory!.provenance === "owner_policy");
      const best = Math.max(-1, ...values.map((item) => specificity(item.memory!.scope, manifest)));
      const sorted = values.filter((item) => specificity(item.memory!.scope, manifest) === best).sort((a, b) => b.memory!.createdAt - a.memory!.createdAt || b.blobId.localeCompare(a.blobId)); if (!sorted.length) return [];
      return sorted.filter((item) => item.memory!.createdAt === sorted[0]!.memory!.createdAt).map((item) => item.memory!);
    };
    const policies = latest("privacy_rule"), conflict = policies[0]?.provenance === "owner_policy" && new Set(policies.map((item) => item.signal.requiresShielded)).size > 1;
    const requiresShielded = input.mandate.requiredPrivacy === "shielded" || input.privacyHint === "shielded" || policies.some((item) => item.signal.requiresShielded === true);
    // The owner's remembered privacy rule outranks the agent's x402 request when the seller and mandate allow shielded.
    const overridesRail = input.requestedRail === "x402" && policies.some((item) => item.provenance === "owner_policy" && item.signal.requiresShielded === true) && !conflict && manifest.supportedRails.includes("shielded") && (!input.mandate.allowedRails || input.mandate.allowedRails.includes("shielded"));
    const requestedRail = overridesRail ? "shielded" : input.requestedRail;
    const rails = manifest.supportedRails.filter((rail) => (!input.mandate.allowedRails || input.mandate.allowedRails.includes(rail)) && (!requiresShielded || rail === "shielded") && (input.mandate.version !== "supercuts.mandate.v2" || rail !== "x402" || input.mandate.allowPublicX402 === true) && (!requestedRail || rail === requestedRail)); if (!rails.length) continue;
    const budgetMemories = trusted.filter((item) => item.memory!.kind === "budget_limit").map((item) => item.memory!);
    const budgets = budgetMemories.filter((item) => item.signal.periodMs === undefined).map((item) => BigInt(item.signal.maximumAmount!));
    // Periodic owner budgets subtract the verified spend that Walrus Memory remembers for the same scope.
    const remaining = budgetMemories.filter((item) => item.signal.periodMs !== undefined).map((item) => { const limit = BigInt(item.signal.maximumAmount!), spent = spentSince(recalled, item.scope, now - item.signal.periodMs!); return limit > spent ? limit - spent : 0n; });
    const minimumPrice = BigInt(manifest.priceBand.minimum);
    let maximum = [BigInt(manifest.priceBand.maximum), BigInt(input.mandate.perDealCeiling), ...budgets, ...remaining].reduce((a, b) => a < b ? a : b);
    const spendLimited = maximum < minimumPrice && remaining.some((value) => value < minimumPrice) && [BigInt(manifest.priceBand.maximum), BigInt(input.mandate.perDealCeiling), ...budgets].every((value) => value >= minimumPrice);
    if (maximum < minimumPrice && !spendLimited) continue;
    if (spendLimited) maximum = minimumPrice;
    const card = buildScorecard(recalled, { counterparty: manifest.sellerId, capabilityClass: manifest.capability }, now);
    const explicit = latest("reliability")[0];
    const reliability = explicit?.provenance === "owner_policy" ? explicit.signal.reliability! : card.observations ? card.reliability : explicit?.signal.reliability ?? 0.5;
    const quality = latest("quality")[0]?.signal.quality ?? 0.5, outcome = card.lastOutcome ?? latest("outcome")[0]?.signal.outcome;
    const risk: SettlementRisk = conflict || spendLimited || outcome === "unresolved" || reliability < 0.5 ? "review_required" : reliability >= 0.8 ? "low" : "medium";
    for (const rail of rails) candidates.push({ manifest, rail, reliability, quality, maximum, risk, citations, conflict, card, reasons: ["MANDATE_DEFAULTS_APPLIED", ...(policies.length ? ["MEMORY_PRIVACY_APPLIED" as const] : []), ...(overridesRail ? ["MEMORY_PRIVACY_OVERRODE_RAIL" as const] : []), ...(budgetMemories.length ? ["MEMORY_BUDGET_APPLIED" as const] : []), ...(spendLimited ? ["MEMORY_SPEND_LIMIT_REACHED" as const] : []), ...(outcome ? ["MEMORY_OUTCOME_APPLIED" as const] : []), ...(card.observations ? ["MEMORY_RELIABILITY_LEARNED" as const] : []), ...(citations.some((c) => ["agent_observation", "legacy_untrusted"].includes(c.provenance)) ? ["MEMORY_UNTRUSTED_ADVISORY" as const] : []), ...(ignored.length ? ["MEMORY_LOW_RELEVANCE_IGNORED" as const] : [])] });
  }
  candidates.sort((a, b) => Number(a.risk === "review_required") - Number(b.risk === "review_required") || b.reliability - a.reliability || b.quality - a.quality || (a.maximum < b.maximum ? -1 : a.maximum > b.maximum ? 1 : 0) || a.manifest.capabilityId.localeCompare(b.manifest.capabilityId) || (a.rail === b.rail ? 0 : input.mandate.version === "supercuts.mandate.v2" ? a.rail === "shielded" ? -1 : 1 : a.rail === "x402" ? -1 : 1));
  const selected = candidates[0] ?? fail("SETTLEMENT_PLAN_DENIED", "no capability remains within the owner mandate, privacy rules, and price bounds");
  const minimum = BigInt(selected.manifest.priceBand.minimum), desired = input.requestedAmount === undefined ? minimum : BigInt(input.requestedAmount), opening = desired < minimum ? minimum : desired > selected.maximum ? selected.maximum : desired;
  const demoted = candidates.some((item) => item.manifest.sellerId !== selected.manifest.sellerId && item.card.observations > 0 && item.reliability < selected.reliability);
  const reasons = [...selected.reasons, ...(demoted ? ["MEMORY_SELLER_DEMOTED" as const] : []), ...(selected.conflict ? ["OWNER_POLICY_CONFLICT" as const] : []), ...(opening !== desired ? ["REQUESTED_AMOUNT_CLAMPED" as const] : []), selected.rail === "shielded" ? "RAIL_SHIELDED_SELECTED" as const : "RAIL_X402_SELECTED" as const, selected.risk === "low" ? "RISK_LOW" as const : selected.risk === "medium" ? "RISK_MEDIUM" as const : "RISK_REVIEW_REQUIRED" as const];
  const withoutHash: Omit<SettlementPlanV1, "planHash"> = { version: SETTLEMENT_PLAN_VERSION, operationId: input.operationId, status: selected.risk === "review_required" ? "review_required" : "approved", mandateHash: settlementMandateHash(input.mandate), manifestHash: selected.manifest.manifestHash, capabilityId: selected.manifest.capabilityId, capabilityClass: selected.manifest.capability, sellerId: selected.manifest.sellerId, endpoint: selected.manifest.endpoint, network: "sui:testnet", asset: selected.manifest.asset, rail: selected.rail, openingAmount: opening.toString(), maximumAmount: selected.maximum.toString(), manifestMinimum: selected.manifest.priceBand.minimum, manifestMaximum: selected.manifest.priceBand.maximum, riskLevel: selected.risk, createdAt: now, expiresAt: Math.min(now + 300_000, input.mandate.expiresAt, selected.manifest.expiresAt), citations: selected.citations.sort((a, b) => a.blobId.localeCompare(b.blobId)), reasonCodes: [...new Set(reasons)] };
  return { ...withoutHash, planHash: settlementPlanHash(withoutHash) };
}

export function validateSettlementPlan(value: unknown): asserts value is SettlementPlanV1 {
  if (!object(value) || value.version !== SETTLEMENT_PLAN_VERSION) fail("SETTLEMENT_PLAN_INVALID", "settlement plan has an invalid version");
  const allowed = new Set(["version", "planHash", "operationId", "status", "mandateHash", "manifestHash", "capabilityId", "capabilityClass", "sellerId", "endpoint", "network", "asset", "rail", "openingAmount", "maximumAmount", "manifestMinimum", "manifestMaximum", "riskLevel", "createdAt", "expiresAt", "citations", "reasonCodes", "approvedFromPlanHash"]);
  if (Object.keys(value as Record<string, unknown>).some((key) => !allowed.has(key))) fail("SETTLEMENT_PLAN_INVALID", "settlement plan contains unknown fields");
  const plan = value as unknown as SettlementPlanV1, { planHash, ...unsignedPlan } = plan;
  if (typeof planHash !== "string" || !/^[0-9a-f]{64}$/.test(planHash) || settlementPlanHash(unsignedPlan) !== planHash) fail("SETTLEMENT_PLAN_HASH_MISMATCH", "settlement plan hash does not match its canonical record");
  for (const amount of [plan.openingAmount, plan.maximumAmount, plan.manifestMinimum, plan.manifestMaximum]) if (!unsigned(amount)) fail("SETTLEMENT_PLAN_INVALID", "settlement plan contains a non-canonical amount");
  if (!Number.isSafeInteger(plan.createdAt) || !Number.isSafeInteger(plan.expiresAt) || plan.expiresAt <= plan.createdAt || BigInt(plan.openingAmount) > BigInt(plan.maximumAmount) || BigInt(plan.maximumAmount) > BigInt(plan.manifestMaximum) || BigInt(plan.openingAmount) < BigInt(plan.manifestMinimum)) fail("SETTLEMENT_PLAN_INVALID", "settlement plan bounds or timestamps are invalid");
  if (!["approved", "review_required"].includes(plan.status) || !["low", "medium", "review_required"].includes(plan.riskLevel) || !["x402", "shielded"].includes(plan.rail)) fail("SETTLEMENT_PLAN_INVALID", "settlement plan decision fields are invalid");
  for (const field of [plan.operationId, plan.mandateHash, plan.manifestHash, plan.capabilityId, plan.capabilityClass, plan.sellerId, plan.endpoint, plan.asset]) if (typeof field !== "string" || !field || field.length > 2048) fail("SETTLEMENT_PLAN_INVALID", "settlement plan string fields are invalid");
  if (plan.network !== "sui:testnet" || !/^[0-9a-f]{64}$/.test(plan.mandateHash) || !/^[0-9a-f]{64}$/.test(plan.manifestHash) || plan.approvedFromPlanHash !== undefined && !/^[0-9a-f]{64}$/.test(plan.approvedFromPlanHash)) fail("SETTLEMENT_PLAN_INVALID", "settlement plan hashes or network are invalid");
  if (!Array.isArray(plan.reasonCodes) || !Array.isArray(plan.citations) || plan.citations.some((citation) => !object(citation) || Object.keys(citation).some((key) => !["blobId", "kind", "provenance", "distance"].includes(key)) || typeof citation.blobId !== "string" || !citation.blobId || typeof citation.distance !== "number" || !Number.isFinite(citation.distance) || citation.distance < 0 || citation.distance > 1)) fail("SETTLEMENT_PLAN_INVALID", "settlement plan citations or reasons are invalid");
}

export interface MemoryDecision { sellerId: string; capabilityId: string; rail: CapabilityRail; riskLevel: SettlementRisk; maximumAmount: string; }
export interface MemoryInfluence { changedSeller: boolean; changedRail: boolean; changedRisk: boolean; changedMaximum: boolean; withoutMemory?: MemoryDecision; withMemory: MemoryDecision; citedBlobIds: string[]; }
const decision = (plan: SettlementPlanV1): MemoryDecision => ({ sellerId: plan.sellerId, capabilityId: plan.capabilityId, rail: plan.rail, riskLevel: plan.riskLevel, maximumAmount: plan.maximumAmount });

/** Counterfactual: what the same mandate would have paid without any recalled memory. Not part of the plan hash. */
/** True when the plan honours the agent's requested rail, or an owner privacy memory rerouted x402 to shielded. */
export function planHonoursRail(plan: Pick<SettlementPlanV1, "rail" | "reasonCodes">, requestedRail?: CapabilityRail): boolean {
  return !requestedRail || plan.rail === requestedRail || requestedRail === "x402" && plan.rail === "shielded" && plan.reasonCodes.includes("MEMORY_PRIVACY_OVERRODE_RAIL");
}

export function explainMemoryInfluence(input: PlanningInput, plan: SettlementPlanV1): MemoryInfluence {
  let withoutMemory: MemoryDecision | undefined;
  try { withoutMemory = decision(createSettlementPlan({ ...input, recalled: [], now: plan.createdAt })); } catch { withoutMemory = undefined; }
  const withMemory = decision(plan);
  return { changedSeller: withoutMemory?.sellerId !== withMemory.sellerId, changedRail: withoutMemory?.rail !== withMemory.rail, changedRisk: withoutMemory?.riskLevel !== withMemory.riskLevel, changedMaximum: withoutMemory?.maximumAmount !== withMemory.maximumAmount, ...(withoutMemory ? { withoutMemory } : {}), withMemory, citedBlobIds: plan.citations.map((item) => item.blobId) };
}
