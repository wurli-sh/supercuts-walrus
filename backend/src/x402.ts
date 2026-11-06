import { createHash } from "node:crypto";
import { RoleStore } from "./store.js";
import { fail } from "./errors.js";

export interface ExactRequirements { scheme: "exact"; network: string; amount: string; asset: string; payTo: string; maxTimeoutSeconds: number; extra: Record<string, unknown>; }
export interface PaymentBinding { requestId: string; nonce: string; requirementsHash: string; transactionDigest: string; payer: string; payerSignature: string; }
export interface FinalPayment { digest: string; network: string; asset: string; amount: bigint; payTo: string; finalized: boolean; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) fail("X402_REQUIREMENTS_INVALID", "x402 values must be JSON-compatible");
  return result;
}
export function requirementsHash(requirements: ExactRequirements): string { return createHash("sha256").update(canonical(requirements)).digest("hex"); }
export function paymentBindingBytes(binding: Omit<PaymentBinding, "payerSignature">): Uint8Array {
  return Buffer.from(canonical({ domain: "supercuts-x402-binding-v1", ...binding }));
}

export class PaymentConsumptionLedger {
  constructor(private readonly store: RoleStore) {}
  hasClaim(requestId: string): boolean {
    return Boolean(this.store.db.prepare("SELECT 1 FROM deliveries WHERE request_id = ?").get(requestId));
  }
  claim(payment: FinalPayment, requestId: string): void {
    if (!payment.finalized) fail("PAYMENT_PENDING", "payment is not finalized");
    if (!payment.network || !payment.digest || payment.network.length > 256 || payment.digest.length > 256 || !requestId || requestId.length > 256) fail("PAYMENT_ID_INVALID", "payment or request identity is invalid");
    const key = createHash("sha256").update(canonical([payment.network, payment.digest])).digest("hex");
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const request = this.store.db.prepare("SELECT payment_key FROM deliveries WHERE request_id = ?").get(requestId) as { payment_key: string } | undefined;
      if (request && request.payment_key !== key) fail("REQUEST_PAYMENT_CONFLICT", "request is already bound to another payment");
      const existing = this.store.db.prepare("SELECT request_id FROM deliveries WHERE payment_key = ?").get(key) as { request_id: string } | undefined;
      if (existing && existing.request_id !== requestId) fail("PAYMENT_CONSUMED", "payment was already used for another request");
      if (!existing) this.store.db.prepare("INSERT INTO deliveries(request_id, payment_key, response, finalized) VALUES (?, ?, ?, 1)").run(requestId, key, Buffer.alloc(0));
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
  }
  recordDelivery(requestId: string, response: Uint8Array): void {
    const result = this.store.db.prepare("UPDATE deliveries SET response = ?, finalized = 1 WHERE request_id = ?").run(Buffer.from(response), requestId);
    if (result.changes !== 1) fail("PAYMENT_NOT_CLAIMED", "resource cannot be delivered before payment consumption");
  }
  getDelivery(requestId: string): Buffer | undefined {
    const row = this.store.db.prepare("SELECT response FROM deliveries WHERE request_id = ?").get(requestId) as { response: Uint8Array } | undefined;
    return row ? Buffer.from(row.response) : undefined;
  }
  isDeliveryComplete(requestId: string): boolean {
    const row = this.store.db.prepare("SELECT status FROM delivery_jobs WHERE request_id = ?").get(requestId) as { status: string } | undefined;
    return row?.status === "delivered";
  }
  acquireDelivery(requestId: string, now = Date.now(), leaseMs = 30_000): boolean {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.store.db.prepare("SELECT status, lease_until FROM delivery_jobs WHERE request_id = ?").get(requestId) as { status: string; lease_until: number } | undefined;
      if (row?.status === "delivered" || (row?.status === "producing" && row.lease_until > now)) { this.store.db.exec("COMMIT"); return false; }
      this.store.db.prepare("INSERT INTO delivery_jobs(request_id, status, lease_until) VALUES (?, 'producing', ?) ON CONFLICT(request_id) DO UPDATE SET status='producing', lease_until=excluded.lease_until").run(requestId, now + leaseMs);
      this.store.db.exec("COMMIT"); return true;
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
  }
  releaseDelivery(requestId: string): void { this.store.db.prepare("UPDATE delivery_jobs SET status = 'pending', lease_until = 0 WHERE request_id = ? AND status = 'producing'").run(requestId); }
  completeDelivery(requestId: string, response: Uint8Array): void {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.recordDelivery(requestId, response);
      this.store.db.prepare("INSERT INTO delivery_jobs(request_id, status, lease_until) VALUES (?, 'delivered', 0) ON CONFLICT(request_id) DO UPDATE SET status='delivered', lease_until=0").run(requestId);
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
  }
  challenge(requestId: string, requirementsHashValue: string, createNonce: () => string, renewAfterMs?: number, now = Date.now()): string {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.store.db.prepare("SELECT nonce, requirements_hash, created_at FROM x402_challenges WHERE request_id = ?").get(requestId) as { nonce: string; requirements_hash: string; created_at: number } | undefined;
      if (existing) {
        if (existing.requirements_hash !== requirementsHashValue) fail("X402_REQUEST_CONFLICT", "request identity was reused with different requirements");
        if (renewAfterMs !== undefined && now > existing.created_at + renewAfterMs && !this.hasClaim(requestId)) {
          const nonce = createNonce();
          this.store.db.prepare("UPDATE x402_challenges SET nonce = ?, created_at = ? WHERE request_id = ?").run(nonce, now, requestId);
          this.store.db.exec("COMMIT");
          return nonce;
        }
        this.store.db.exec("COMMIT");
        return existing.nonce;
      }
      const nonce = createNonce();
      this.store.db.prepare("INSERT INTO x402_challenges(request_id, nonce, requirements_hash, created_at) VALUES (?, ?, ?, ?)").run(requestId, nonce, requirementsHashValue, now);
      this.store.db.exec("COMMIT");
      return nonce;
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
  }
  getChallenge(requestId: string, requirementsHashValue: string): { nonce: string; createdAt: number } | undefined {
    const row = this.store.db.prepare("SELECT nonce, requirements_hash, created_at FROM x402_challenges WHERE request_id = ?").get(requestId) as { nonce: string; requirements_hash: string; created_at: number } | undefined;
    if (row && row.requirements_hash !== requirementsHashValue) fail("X402_REQUEST_CONFLICT", "request identity was reused with different requirements");
    return row ? { nonce: row.nonce, createdAt: row.created_at } : undefined;
  }
}

export function verifyBinding(binding: PaymentBinding, requestId: string, nonce: string, requirements: ExactRequirements, transactionDigest: string): void {
  if (!binding.payer || !binding.payerSignature || binding.payer.length > 256 || binding.payerSignature.length > 2048) fail("X402_REQUEST_BINDING_INVALID", "payer binding identity or signature is invalid");
  if (binding.requestId !== requestId || binding.nonce !== nonce || binding.transactionDigest !== transactionDigest || binding.requirementsHash !== requirementsHash(requirements)) fail("X402_REQUEST_BINDING_INVALID", "payment does not bind to this request");
}

export function verifyExactPayment(payment: FinalPayment, requirements: ExactRequirements): void {
  if (requirements.scheme !== "exact" || !Number.isSafeInteger(requirements.maxTimeoutSeconds) || requirements.maxTimeoutSeconds <= 0) fail("X402_REQUIREMENTS_INVALID", "exact requirements need a positive integer timeout");
  if (!requirements.network || !requirements.asset || !requirements.payTo || requirements.network.length > 256 || requirements.asset.length > 512 || requirements.payTo.length > 256) fail("X402_REQUIREMENTS_INVALID", "payment network, asset, or recipient is invalid");
  if (!payment.finalized) fail("PAYMENT_PENDING", "payment is not finalized");
  let required: bigint;
  try { required = BigInt(requirements.amount); } catch (error) { return fail("X402_REQUIREMENTS_INVALID", "payment amount is not an integer", error); }
  if (payment.network !== requirements.network) fail("X402_NETWORK_MISMATCH", "payment used the wrong network");
  if (payment.asset !== requirements.asset) fail("X402_ASSET_MISMATCH", "payment used the wrong asset");
  if (required <= 0n) fail("X402_REQUIREMENTS_INVALID", "payment amount must be positive");
  if (payment.amount !== required) fail("X402_AMOUNT_MISMATCH", "payment used the wrong exact amount");
  if (payment.payTo !== requirements.payTo) fail("X402_PAYEE_MISMATCH", "payment used the wrong recipient");
}
