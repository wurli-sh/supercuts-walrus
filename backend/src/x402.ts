import { createHash } from "node:crypto";
import { RoleStore } from "./store.js";
import { fail } from "./errors.js";

export interface ExactRequirements { scheme: "exact"; network: string; amount: string; asset: string; payTo: string; maxTimeoutSeconds: number; extra: Record<string, unknown>; }
export interface PaymentBinding { requestId: string; nonce: string; requirementsHash: string; transactionDigest: string; payerSignature: string; }
export interface FinalPayment { digest: string; network: string; asset: string; amount: bigint; payTo: string; finalized: boolean; }
export function requirementsHash(requirements: ExactRequirements): string { return createHash("sha256").update(JSON.stringify(requirements)).digest("hex"); }

export class PaymentConsumptionLedger {
  constructor(private readonly store: RoleStore) {}
  claim(payment: FinalPayment, requestId: string): void {
    if (!payment.finalized) fail("PAYMENT_PENDING", "payment is not finalized");
    const key = `${payment.network}:${payment.digest}`;
    const existing = this.store.db.prepare("SELECT request_id FROM deliveries WHERE payment_key = ?").get(key) as { request_id: string } | undefined;
    if (existing && existing.request_id !== requestId) fail("PAYMENT_CONSUMED", "payment was already used for another request");
    if (!existing) this.store.db.prepare("INSERT INTO deliveries(request_id, payment_key, response, finalized) VALUES (?, ?, ?, 1)").run(requestId, key, Buffer.alloc(0));
  }
  recordDelivery(requestId: string, response: Uint8Array): void { this.store.db.prepare("UPDATE deliveries SET response = ?, finalized = 1 WHERE request_id = ?").run(Buffer.from(response), requestId); }
  getDelivery(requestId: string): Buffer | undefined {
    const row = this.store.db.prepare("SELECT response FROM deliveries WHERE request_id = ?").get(requestId) as { response: Uint8Array } | undefined;
    return row ? Buffer.from(row.response) : undefined;
  }
}

export function verifyBinding(binding: PaymentBinding, requestId: string, nonce: string, requirements: ExactRequirements, transactionDigest: string): void {
  if (binding.requestId !== requestId || binding.nonce !== nonce || binding.transactionDigest !== transactionDigest || binding.requirementsHash !== requirementsHash(requirements)) fail("X402_REQUEST_BINDING_INVALID", "payment does not bind to this request");
}
