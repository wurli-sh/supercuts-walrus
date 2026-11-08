import { createHash, randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import { canonicalJson } from "./settlement.js";
import type { RoleStore } from "./store.js";

export const DEAL_VERSION = "supercuts.deal.v2" as const;
export type DealState = "created" | "discovered" | "planned" | "awaiting_approval" | "review_required" | "funding_required" | "negotiating" | "agreed" | "evidence_ready" | "payment_pending" | "paid" | "delivery_pending" | "delivered" | "outcome_pending" | "complete" | "failed" | "unresolved";
export interface ExecuteDealInput {
  operationId: string;
  capabilityId?: string;
  capabilityClass?: string;
  input: Record<string, unknown>;
  budget: { asset: string; maximum: string };
  privacyHint?: "any" | "shielded";
  requestedRail?: "shielded" | "x402";
}
export interface DealView {
  version: typeof DEAL_VERSION;
  dealId: string;
  operationId: string;
  state: DealState;
  rail?: "shielded" | "x402";
  visibility?: "shielded-direct-payment" | "public-x402";
  planHash?: string;
  paymentDigest?: string;
  deliveryHash?: string;
  evidence: { agreement: "pending" | "verified"; payment: "pending" | "finalized"; delivery: "pending" | "verified"; outcomeMemory: "pending" | "indexed" | "unresolved" };
  nextAction?: "resume" | "check_memory" | "reconcile_memory" | "fund_buyer" | "owner_approval" | "owner_review";
  timingsMs?: Record<string, number>;
}
export interface DealEvidenceView {
  version: "supercuts.deal-evidence.v1";
  dealId: string;
  transcriptBlobIds: string[];
  agreementBlobId?: string;
  deliveryBlobId?: string;
  outcomeMemoryBlobId?: string;
  ciphertextReadback: "pending" | "verified" | "unresolved";
  inventory: "pending" | "indexed" | "missing" | "unresolved";
  paymentFinalized: boolean;
  paymentDigest?: string;
  /** What Walrus Memory changed about this payment versus the same mandate with no memory. */
  memoryInfluence?: { changedSeller: boolean; changedRail: boolean; changedRisk: boolean; changedMaximum: boolean; withoutMemory?: { sellerId: string; capabilityId: string; rail: string; riskLevel: string; maximumAmount: string }; withMemory: { sellerId: string; capabilityId: string; rail: string; riskLevel: string; maximumAmount: string }; citedBlobIds: string[] };
  /** Learned seller scorecards used for discovery; counts and blob IDs only, never memory plaintext. */
  memoryRanking?: Array<{ capabilityId: string; counterparty: string; reliability: number; observations: number; successes: number; failures: number; unresolved: number; lastOutcome?: string; medianLatencyMs?: number; priceMinimum: string }>;
}
export interface DealDelivery { dealId: string; contentType: string; artifactSha256: string; artifact: Uint8Array; }

const digest = (domain: string, value: unknown) => createHash("sha256").update(canonicalJson({ domain, value })).digest("hex");
const sha256Bytes = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
export function validateDealInput(value: unknown): asserts value is ExecuteDealInput {
  if (!isObject(value) || Object.keys(value).some((key) => !["operationId", "capabilityId", "capabilityClass", "input", "budget", "privacyHint", "requestedRail"].includes(key))) fail("DEAL_INPUT_INVALID", "deal input contains invalid fields");
  const item = value as unknown as ExecuteDealInput;
  if (typeof item.operationId !== "string" || item.operationId.length < 1 || item.operationId.length > 256 || Number(typeof item.capabilityId === "string") + Number(typeof item.capabilityClass === "string") !== 1 || item.capabilityId !== undefined && (!item.capabilityId || item.capabilityId.length > 256) || item.capabilityClass !== undefined && (!item.capabilityClass || item.capabilityClass.length > 256)) fail("DEAL_INPUT_INVALID", "deal requires one capability selector and a stable operation ID");
  if (!isObject(item.input) || !isObject(item.budget) || Object.keys(item.budget).some((key) => !["asset", "maximum"].includes(key)) || typeof item.budget.asset !== "string" || !item.budget.asset || typeof item.budget.maximum !== "string" || !/^[1-9][0-9]*$/.test(item.budget.maximum)) fail("DEAL_INPUT_INVALID", "deal input or budget is invalid");
  if (item.privacyHint !== undefined && !["any", "shielded"].includes(item.privacyHint) || item.requestedRail !== undefined && !["shielded", "x402"].includes(item.requestedRail)) fail("DEAL_INPUT_INVALID", "deal privacy or rail hint is invalid");
  const encoded = canonicalJson(item); if (Buffer.byteLength(encoded) > 64 * 1024) fail("DEAL_INPUT_TOO_LARGE", "deal input exceeds 64 KiB");
}

export function dealChildId(operationId: string, step: "plan" | "agreement" | "payment" | "delivery" | "outcome"): string {
  if (!operationId || operationId.length > 256) fail("DEAL_INPUT_INVALID", "operation ID is invalid");
  return `deal:${step}:${digest("supercuts-deal-child-v1", operationId).slice(0, 48)}`;
}

const transitions: Record<DealState, DealState[]> = {
  created: ["discovered", "failed", "unresolved"], discovered: ["planned", "failed", "unresolved"],
  planned: ["awaiting_approval", "review_required", "funding_required", "negotiating", "failed", "unresolved"],
  awaiting_approval: ["negotiating", "failed"], review_required: ["planned", "failed"],
  funding_required: ["planned", "payment_pending", "failed", "unresolved"],
  negotiating: ["agreed", "failed", "unresolved"], agreed: ["funding_required", "evidence_ready", "failed", "unresolved"],
  evidence_ready: ["payment_pending", "failed", "unresolved"], payment_pending: ["paid", "funding_required", "unresolved"],
  paid: ["delivery_pending", "unresolved"], delivery_pending: ["delivered", "unresolved"],
  delivered: ["outcome_pending", "unresolved"], outcome_pending: ["complete", "unresolved"],
  complete: [], failed: [], unresolved: ["discovered", "planned", "negotiating", "agreed", "evidence_ready", "payment_pending", "paid", "delivery_pending", "delivered", "outcome_pending"],
};

export class DealJournal {
  constructor(private readonly store: RoleStore) {}

  create(input: ExecuteDealInput): DealView {
    validateDealInput(input);
    const inputHash = digest("supercuts-deal-input-v2", input);
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.store.db.prepare("SELECT input_hash FROM deal_operations WHERE operation_id=?").get(input.operationId) as { input_hash: string } | undefined;
      if (prior && prior.input_hash !== inputHash) fail("DEAL_OPERATION_CONFLICT", "operation ID identifies a different deal input");
      if (!prior) {
        const now = Date.now();
        this.store.putSecretOnce(`deal:input:${input.operationId}`, Buffer.from(canonicalJson(input)));
        this.store.db.prepare("INSERT INTO deal_operations(operation_id,deal_id,input_hash,state,payment_operation_id,created_at,updated_at) VALUES(?,?,?,'created',?,?,?)")
          .run(input.operationId, randomUUID(), inputHash, dealChildId(input.operationId, "payment"), now, now);
      }
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
    return this.get(input.operationId);
  }

  get(operationId: string): DealView {
    const row = this.store.db.prepare("SELECT deal_id,input_hash,state,rail,plan_hash,payment_operation_id FROM deal_operations WHERE operation_id=?").get(operationId) as { deal_id: string; input_hash: string; state: DealState; rail: "shielded" | "x402" | null; plan_hash: string | null; payment_operation_id: string } | undefined;
    if (!row) return fail("DEAL_NOT_FOUND", "deal operation was not found");
    const agreement = this.store.db.prepare("SELECT status FROM deal_blobs WHERE operation_id=? AND kind='agreement'").get(operationId) as { status: string } | undefined;
    const delivery = this.store.db.prepare("SELECT status FROM deal_blobs WHERE operation_id=? AND kind='delivery'").get(operationId) as { status: string } | undefined;
    const memory = this.store.db.prepare("SELECT status FROM deal_memory_outbox WHERE operation_id=? AND event_kind='outcome'").get(operationId) as { status: string } | undefined;
    const timings = this.store.db.prepare("SELECT stage,duration_ms FROM deal_timings WHERE operation_id=?").all(operationId) as Array<{ stage: string; duration_ms: number }>;
    const payment = this.store.getOperation(row.payment_operation_id);
    const hasLiveTransactions = Boolean(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_signed_transactions'").get());
    const signed = hasLiveTransactions ? this.store.db.prepare("SELECT status,digest FROM live_signed_transactions WHERE operation_id=?").get(row.payment_operation_id) as { status: string; digest: string } | undefined : undefined;
    const verifiedPayment = this.step<{ transactionDigest: string; finalized: boolean; tatumVerified: boolean }>(operationId, "payment");
    const finalized = Boolean(verifiedPayment?.finalized && verifiedPayment.tatumVerified && ((payment?.status === "confirmed" || payment?.status === "delivered") && payment.txDigest === verifiedPayment.transactionDigest || signed?.status === "finalized" && signed.digest === verifiedPayment.transactionDigest));
    return { version: DEAL_VERSION, dealId: row.deal_id, operationId, state: row.state, ...(row.rail ? { rail: row.rail, visibility: row.rail === "shielded" ? "shielded-direct-payment" as const : "public-x402" as const } : {}), ...(row.plan_hash ? { planHash: row.plan_hash } : {}), ...(finalized ? { paymentDigest: verifiedPayment!.transactionDigest } : {}), evidence: { agreement: agreement?.status === "verified" ? "verified" : "pending", payment: finalized ? "finalized" : "pending", delivery: delivery?.status === "verified" ? "verified" : "pending", outcomeMemory: memory?.status === "indexed" ? "indexed" : memory?.status === "unresolved" ? "unresolved" : "pending" }, ...(timings.length ? { timingsMs: Object.fromEntries(timings.map((item) => [item.stage, item.duration_ms])) } : {}), ...(row.state === "funding_required" ? { nextAction: "fund_buyer" as const } : row.state === "awaiting_approval" ? { nextAction: "owner_approval" as const } : row.state === "review_required" ? { nextAction: "owner_review" as const } : row.state === "outcome_pending" ? { nextAction: memory?.status === "unresolved" ? "reconcile_memory" as const : "check_memory" as const } : !["complete", "failed"].includes(row.state) ? { nextAction: "resume" as const } : {}) };
  }

  input(operationId: string): ExecuteDealInput {
    this.get(operationId);
    const encoded = this.store.getSecret(`deal:input:${operationId}`) ?? fail("DEAL_INPUT_MISSING", "encrypted deal input was not found");
    let value: unknown;
    try { value = JSON.parse(encoded.toString()); } catch (error) { return fail("DEAL_INPUT_CORRUPT", "encrypted deal input is invalid", error); }
    validateDealInput(value);
    return value;
  }

  saveStep(operationId: string, step: string, input: unknown, result: unknown): void {
    this.get(operationId);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(step)) fail("DEAL_STEP_INVALID", "deal step name is invalid");
    const inputHash = digest(`supercuts-deal-step-input-v1:${step}`, input);
    const resultBytes = Buffer.from(canonicalJson(result));
    const resultHash = digest(`supercuts-deal-step-result-v1:${step}`, result);
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.store.db.prepare("SELECT input_hash,result_hash FROM deal_steps WHERE operation_id=? AND step=?").get(operationId, step) as { input_hash: string; result_hash: string } | undefined;
      if (previous && (previous.input_hash !== inputHash || previous.result_hash !== resultHash)) fail("DEAL_STEP_CONFLICT", "deal step already has a different input or result");
      this.store.putSecretOnce(`deal:step:${operationId}:${step}`, resultBytes);
      if (!previous) this.store.db.prepare("INSERT INTO deal_steps(operation_id,step,input_hash,state,result_hash,updated_at) VALUES(?,?,?,'complete',?,?)").run(operationId, step, inputHash, resultHash, Date.now());
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
  }

  step<T>(operationId: string, step: string): T | undefined {
    const row = this.store.db.prepare("SELECT result_hash FROM deal_steps WHERE operation_id=? AND step=? AND state='complete'").get(operationId, step) as { result_hash: string } | undefined;
    if (!row) return undefined;
    const bytes = this.store.getSecret(`deal:step:${operationId}:${step}`) ?? fail("DEAL_STEP_CORRUPT", "deal step result is missing");
    let result: T;
    try { result = JSON.parse(bytes.toString()) as T; } catch (error) { return fail("DEAL_STEP_CORRUPT", "deal step result is invalid", error); }
    if (digest(`supercuts-deal-step-result-v1:${step}`, result) !== row.result_hash) fail("DEAL_STEP_CORRUPT", "deal step result hash differs");
    return result;
  }

  recordBlob(operationId: string, kind: "agreement" | "delivery", ciphertextHash: string, blobId: string): void {
    this.get(operationId);
    if (!/^[0-9a-f]{64}$/.test(ciphertextHash) || !blobId) fail("DEAL_BLOB_INVALID", "deal ciphertext hash or blob ID is invalid");
    const prior = this.store.db.prepare("SELECT ciphertext_hash,blob_id FROM deal_blobs WHERE operation_id=? AND kind=?").get(operationId, kind) as { ciphertext_hash: string; blob_id: string } | undefined;
    if (prior && (prior.ciphertext_hash !== ciphertextHash || prior.blob_id !== blobId)) fail("DEAL_BLOB_CONFLICT", "deal evidence already identifies different ciphertext");
    this.store.db.prepare("INSERT INTO deal_blobs(operation_id,kind,ciphertext_hash,blob_id,status) VALUES(?,?,?,?,'verified') ON CONFLICT(operation_id,kind) DO UPDATE SET status='verified'").run(operationId, kind, ciphertextHash, blobId);
  }

  recordOutcome(operationId: string, payloadHash: string, blobId: string, indexed: boolean): void {
    this.get(operationId);
    if (!/^[0-9a-f]{64}$/.test(payloadHash) || !blobId) fail("DEAL_MEMORY_INVALID", "outcome hash or blob ID is invalid");
    const prior = this.store.db.prepare("SELECT payload_hash,blob_id FROM deal_memory_outbox WHERE operation_id=? AND event_kind='outcome'").get(operationId) as { payload_hash: string; blob_id: string } | undefined;
    if (prior && (prior.payload_hash !== payloadHash || prior.blob_id && prior.blob_id !== blobId)) fail("DEAL_MEMORY_CONFLICT", "outcome memory already identifies a different write");
    this.store.db.prepare("INSERT INTO deal_memory_outbox(operation_id,event_kind,payload_hash,blob_id,status,updated_at) VALUES(?,'outcome',?,?,?,?) ON CONFLICT(operation_id,event_kind) DO UPDATE SET blob_id=COALESCE(deal_memory_outbox.blob_id,excluded.blob_id),status=CASE WHEN deal_memory_outbox.status='indexed' THEN 'indexed' ELSE excluded.status END,updated_at=excluded.updated_at")
      .run(operationId, payloadHash, blobId, indexed ? "indexed" : "pending", Date.now());
  }

  outcomeStatus(operationId: string): { payloadHash: string; blobId: string | null; status: string } | undefined {
    const row = this.store.db.prepare("SELECT payload_hash,blob_id,status FROM deal_memory_outbox WHERE operation_id=? AND event_kind='outcome'").get(operationId) as { payload_hash: string; blob_id: string | null; status: string } | undefined;
    return row ? { payloadHash: row.payload_hash, blobId: row.blob_id, status: row.status } : undefined;
  }

  queueOutcome(operationId: string, payloadHash: string): void {
    this.get(operationId);
    if (!/^[0-9a-f]{64}$/.test(payloadHash)) fail("DEAL_MEMORY_INVALID", "outcome hash is invalid");
    const prior = this.store.db.prepare("SELECT payload_hash FROM deal_memory_outbox WHERE operation_id=? AND event_kind='outcome'").get(operationId) as { payload_hash: string } | undefined;
    if (prior && prior.payload_hash !== payloadHash) fail("DEAL_MEMORY_CONFLICT", "outcome memory identifies different evidence");
    this.store.db.prepare("INSERT OR IGNORE INTO deal_memory_outbox(operation_id,event_kind,payload_hash,blob_id,status,updated_at) VALUES(?,'outcome',?,NULL,'pending',?)").run(operationId, payloadHash, Date.now());
  }

  /** Back to pending after reconciliation proved the ambiguous write never reached Walrus Memory. */
  requeueOutcome(operationId: string): void {
    this.store.db.prepare("UPDATE deal_memory_outbox SET status='pending',updated_at=? WHERE operation_id=? AND event_kind='outcome' AND status='unresolved'").run(Date.now(), operationId);
  }
  setOutcomeUnresolved(operationId: string): void {
    this.store.db.prepare("UPDATE deal_memory_outbox SET status='unresolved',updated_at=? WHERE operation_id=? AND event_kind='outcome' AND status='pending'").run(Date.now(), operationId);
  }

  recordTiming(operationId: string, stage: string, durationMs: number): void {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(stage) || !Number.isSafeInteger(durationMs) || durationMs < 0) fail("DEAL_TIMING_INVALID", "deal timing is invalid");
    this.store.db.prepare("INSERT OR IGNORE INTO deal_timings(operation_id,stage,duration_ms) VALUES(?,?,?)").run(operationId, stage, durationMs);
  }

  evidence(dealId: string): DealEvidenceView {
    const row = this.store.db.prepare("SELECT operation_id,payment_operation_id FROM deal_operations WHERE deal_id=?").get(dealId) as { operation_id: string; payment_operation_id: string } | undefined;
    if (!row) return fail("DEAL_NOT_FOUND", "deal was not found");
    const view = this.get(row.operation_id);
    const blobs = this.store.db.prepare("SELECT kind,blob_id,status FROM deal_blobs WHERE operation_id=?").all(row.operation_id) as Array<{ kind: string; blob_id: string | null; status: string }>;
    const memory = this.store.db.prepare("SELECT blob_id,status FROM deal_memory_outbox WHERE operation_id=? AND event_kind='outcome'").get(row.operation_id) as { blob_id: string | null; status: string } | undefined;
    const transcript = this.step<{ transcriptBlobs?: Array<{ blobId: string }> }>(row.operation_id, "negotiation");
    const hasRecords = Boolean(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_records'").get());
    const record = <T>(scope: string, id: string): T | undefined => { if (!hasRecords) return undefined; const found = this.store.db.prepare("SELECT value FROM app_records WHERE scope=? AND id=?").get(scope, id) as { value: string } | undefined; return found ? JSON.parse(found.value) as T : undefined; };
    const influence = record<NonNullable<DealEvidenceView["memoryInfluence"]>>("memory-influence", `deal:${row.operation_id}`);
    const ranking = record<{ scorecards: Array<NonNullable<DealEvidenceView["memoryRanking"]>[number] & { citedBlobIds?: string[]; lastOutcomeAt?: number }> }>("deal-ranking", row.operation_id);
    const memoryRanking = ranking?.scorecards.map(({ capabilityId, counterparty, reliability, observations, successes, failures, unresolved, lastOutcome, medianLatencyMs, priceMinimum }) => ({ capabilityId, counterparty, reliability, observations, successes, failures, unresolved, ...(lastOutcome ? { lastOutcome } : {}), ...(medianLatencyMs !== undefined ? { medianLatencyMs } : {}), priceMinimum }));
    return { version: "supercuts.deal-evidence.v1", dealId, transcriptBlobIds: transcript?.transcriptBlobs?.map((item) => item.blobId) ?? [], ...(blobs.find((item) => item.kind === "agreement")?.blob_id ? { agreementBlobId: blobs.find((item) => item.kind === "agreement")!.blob_id! } : {}), ...(blobs.find((item) => item.kind === "delivery")?.blob_id ? { deliveryBlobId: blobs.find((item) => item.kind === "delivery")!.blob_id! } : {}), ...(memory?.blob_id ? { outcomeMemoryBlobId: memory.blob_id } : {}), ciphertextReadback: blobs.some((item) => item.status === "unresolved") ? "unresolved" : ["agreement", "delivery"].every((kind) => blobs.some((item) => item.kind === kind && item.status === "verified")) ? "verified" : "pending", inventory: memory?.status === "indexed" ? "indexed" : memory?.status === "unresolved" ? "unresolved" : "pending", paymentFinalized: view.evidence.payment === "finalized", ...(view.paymentDigest ? { paymentDigest: view.paymentDigest } : {}), ...(influence ? { memoryInfluence: influence } : {}), ...(memoryRanking ? { memoryRanking } : {}) };
  }

  delivery(dealId: string): DealDelivery {
    const row = this.store.db.prepare("SELECT operation_id FROM deal_operations WHERE deal_id=?").get(dealId) as { operation_id: string } | undefined;
    if (!row) return fail("DEAL_NOT_FOUND", "deal was not found");
    const view = this.get(row.operation_id);
    if (view.evidence.payment !== "finalized" || view.evidence.delivery !== "verified") fail("DEAL_DELIVERY_UNAVAILABLE", "payment and delivery must be verified before artifact access");
    const saved = this.step<{ artifactBase64: string; artifactSha256: string; contentType: string }>(row.operation_id, "delivery") ?? fail("DEAL_DELIVERY_UNAVAILABLE", "encrypted delivery is missing");
    const artifact = Buffer.from(saved.artifactBase64, "base64");
    if (sha256Bytes(artifact) !== saved.artifactSha256) fail("DEAL_DELIVERY_UNVERIFIED", "saved artifact differs from its delivery hash");
    return { dealId, contentType: saved.contentType, artifactSha256: saved.artifactSha256, artifact };
  }

  advance(operationId: string, expected: DealState, next: DealState, result?: { rail?: "shielded" | "x402"; planHash?: string }): DealView {
    if (!transitions[expected].includes(next)) fail("DEAL_TRANSITION_INVALID", `${expected} cannot transition to ${next}`);
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.store.db.prepare("SELECT state,rail,plan_hash FROM deal_operations WHERE operation_id=?").get(operationId) as { state: DealState; rail: string | null; plan_hash: string | null } | undefined;
      if (!row) return fail("DEAL_STATE_CONFLICT", "deal state changed before the transition");
      if (result?.rail && row.rail && result.rail !== row.rail || result?.planHash && row.plan_hash && result.planHash !== row.plan_hash) fail("DEAL_BINDING_CONFLICT", "deal rail or plan cannot change after binding");
      if (row.state === next) { this.store.db.exec("COMMIT"); return this.get(operationId); }
      if (row.state !== expected) return fail("DEAL_STATE_CONFLICT", "deal state changed before the transition");
      if (next === "evidence_ready" && !(this.store.db.prepare("SELECT 1 FROM deal_blobs WHERE operation_id=? AND kind='agreement' AND status='verified'").get(operationId))) fail("DEAL_EVIDENCE_REQUIRED", "agreement ciphertext readback is required before payment");
      if (next === "paid" && this.get(operationId).evidence.payment !== "finalized") fail("DEAL_PAYMENT_UNVERIFIED", "confirmed payment evidence is required");
      if (next === "delivered" && !(this.store.db.prepare("SELECT 1 FROM deal_blobs WHERE operation_id=? AND kind='delivery' AND status='verified'").get(operationId))) fail("DEAL_DELIVERY_UNVERIFIED", "verified delivery evidence is required");
      if (next === "complete" && (this.get(operationId).evidence.payment !== "finalized" || this.get(operationId).evidence.delivery !== "verified")) fail("DEAL_DELIVERY_UNVERIFIED", "finalized payment and verified delivery are required before deal completion");
      this.store.db.prepare("UPDATE deal_operations SET state=?,rail=COALESCE(?,rail),plan_hash=COALESCE(?,plan_hash),updated_at=? WHERE operation_id=?")
        .run(next, result?.rail ?? null, result?.planHash ?? null, Date.now(), operationId);
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
    return this.get(operationId);
  }
}
