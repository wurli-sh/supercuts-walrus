import { randomBytes } from "node:crypto";
import { isValidPersonalMessageSignature } from "@mysten/sui/verify";
import { fail } from "./errors.js";
import { ExactRequirements, FinalPayment, PaymentBinding, PaymentConsumptionLedger, requirementsHash, verifyBinding, verifyExactPayment } from "./x402.js";
import { paymentBindingBytes } from "./x402.js";

export interface PaymentSubmission { binding: PaymentBinding; }
export type PayerSignatureVerifier = (binding: PaymentBinding, requirements: ExactRequirements) => Promise<boolean>;
export type PaymentSettlementReader = (digest: string) => Promise<FinalPayment | undefined>;

export interface PaymentChallenge { status: 402; requestId: string; nonce: string; requirements: ExactRequirements; }

export async function verifySuiPaymentBinding(binding: PaymentBinding): Promise<boolean> {
  const { payerSignature: _signature, ...unsigned } = binding;
  return isValidPersonalMessageSignature(paymentBindingBytes(unsigned), binding.payerSignature, { address: binding.payer });
}

export class ExactResourceServer {
  constructor(
    private readonly ledger: PaymentConsumptionLedger,
    private readonly requirements: ExactRequirements,
    private readonly verifyPayer: PayerSignatureVerifier,
    private readonly readSettlement: PaymentSettlementReader,
  ) {}

  challenge(requestId: string): PaymentChallenge {
    const nonce = this.ledger.challenge(requestId, requirementsHash(this.requirements), () => randomBytes(24).toString("hex"));
    return { status: 402 as const, requestId, nonce, requirements: structuredClone(this.requirements) };
  }

  async deliver(requestId: string, submission: PaymentSubmission, produce: () => Promise<Uint8Array>): Promise<Buffer> {
    const stored = this.ledger.getChallenge(requestId, requirementsHash(this.requirements)) ?? fail("X402_CHALLENGE_MISSING", "request has no active payment challenge");
    const challenge = { requestId, nonce: stored.nonce, requirements: this.requirements };
    verifyBinding(submission.binding, requestId, challenge.nonce, challenge.requirements, submission.binding.transactionDigest);
    if (!(await this.verifyPayer(submission.binding, challenge.requirements))) fail("X402_PAYER_SIGNATURE_INVALID", "payer did not authorize this request binding");
    if (!submission.binding.payer) fail("X402_PAYER_SIGNATURE_INVALID", "payment binding has no payer identity");
    const cached = this.ledger.getDelivery(requestId);
    if (this.ledger.isDeliveryComplete(requestId)) return cached ?? fail("DELIVERY_STATE_INVALID", "completed delivery has no persisted response");
    if (Date.now() > stored.createdAt + this.requirements.maxTimeoutSeconds * 1_000) fail("X402_CHALLENGE_EXPIRED", "payment challenge has expired");
    const payment = await this.readSettlement(submission.binding.transactionDigest) ?? fail("PAYMENT_NOT_FOUND", "payment transaction was not found");
    if (payment.digest !== submission.binding.transactionDigest) fail("PAYMENT_DIGEST_MISMATCH", "settlement reader returned another transaction");
    verifyExactPayment(payment, challenge.requirements);
    this.ledger.claim(payment, requestId);
    if (!this.ledger.acquireDelivery(requestId)) fail("DELIVERY_IN_PROGRESS", "resource delivery is already being produced");
    try {
      const response = Buffer.from(await produce());
      this.ledger.completeDelivery(requestId, response);
      return response;
    } catch (error) { this.ledger.releaseDelivery(requestId); throw error; }
  }
}
