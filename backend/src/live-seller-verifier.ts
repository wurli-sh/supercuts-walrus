import { createHash } from "node:crypto";
import type { Phase3App } from "./phase3.js";
import { LiveRuntime, type LiveRuntimeProfile } from "./live-runtime.js";
import { fail } from "./errors.js";
import { assertSuiFinality, assertTatumFinality } from "./finality.js";
import type { ServiceRequest, VerifiedSellerPayment } from "./seller-runtime.js";
import { canonicalJson } from "./settlement.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const canonicalType = (value: string) => value.replace(/^0x0*2::/, "0x2::").toLowerCase();
function bytes32(value: unknown): string {
  if (typeof value !== "string") return fail("SELLER_PAYMENT_UNVERIFIED", "pool event commitment is missing");
  const bytes = /^(?:0x)?[0-9a-f]{64}$/i.test(value) ? Buffer.from(value.replace(/^0x/, ""), "hex") : Buffer.from(value, "base64");
  if (bytes.length !== 32) fail("SELLER_PAYMENT_UNVERIFIED", "pool event commitment is invalid");
  return bytes.toString("hex");
}

/** Reads independently finalized chain and Tatum evidence from the seller home.
 * The signed agreement was already persisted by prepareSellerAgreement. */
export class LiveSellerPaymentVerifier {
  constructor(private readonly app: Phase3App, private readonly runtimeFactory: () => Promise<LiveRuntime> = () => LiveRuntime.create(app.profile as LiveRuntimeProfile, app.store)) {
    if (app.profile.role !== "seller" || app.profile.mock) fail("SELLER_LIVE_REQUIRED", "seller payment verification requires a live seller role home");
    app.store.db.exec("CREATE TABLE IF NOT EXISTS seller_payment_claims(digest TEXT PRIMARY KEY,request_id TEXT NOT NULL,agreement_hash TEXT NOT NULL,created_at INTEGER NOT NULL)");
  }

  async verify(request: ServiceRequest): Promise<VerifiedSellerPayment> {
    const row = this.app.store.db.prepare("SELECT agreement FROM live_seller_agreements WHERE session_id=?").get(request.requestId) as { agreement: string } | undefined;
    if (!row || sha256(row.agreement) !== request.agreementHash) return fail("SELLER_AGREEMENT_MISMATCH", "request does not match the locally signed agreement");
    const agreement = JSON.parse(row.agreement) as Record<string, unknown>;
    if (agreement.capabilityId !== request.capabilityId || agreement.paymentAmount !== request.agreedAmount || agreement.rail !== request.rail || agreement.sessionId && agreement.sessionId !== request.requestId || agreement.dealOperationId !== request.dealId || agreement.taskHash !== sha256(canonicalJson(request.input))) fail("SELLER_AGREEMENT_MISMATCH", "request differs from signed agreement terms");
    const runtime = await this.runtimeFactory();
    const result = await runtime.client.getTransaction({ digest: request.paymentDigest, include: { effects: true, events: true, balanceChanges: true, transaction: true } });
    const tx = result.Transaction ?? result.FailedTransaction;
    const checkpoint = assertSuiFinality(result, request.paymentDigest);
    if (tx.transaction?.sender?.toLowerCase() !== (this.app.store.db.prepare("SELECT buyer_address FROM seller_deal_prepares WHERE session_id=?").get(request.requestId) as { buyer_address: string } | undefined)?.buyer_address.toLowerCase()) fail("SELLER_PAYMENT_UNVERIFIED", "payment sender differs from the authenticated buyer");
    assertTatumFinality(await runtime.tatum.getTransaction(request.paymentDigest), request.paymentDigest, checkpoint);
    if (request.rail === "x402") {
      if (!tx.balanceChanges?.some((change) => change.address?.toLowerCase() === String(agreement.counterparty).toLowerCase() && canonicalType(String(change.coinType)) === canonicalType(this.app.profile.coinType) && BigInt(String(change.amount)) === BigInt(request.agreedAmount))) fail("SELLER_PAYMENT_UNVERIFIED", "x402 transaction does not credit the exact seller and amount");
    } else {
      const values = runtime.engine.agreementValues({ dealId: BigInt(String(agreement.dealId)), revision: BigInt(String(agreement.revision)), transcriptRootLo: BigInt(String(agreement.transcriptRootLo)), transcriptRootHi: BigInt(String(agreement.transcriptRootHi)), serviceDigestLo: BigInt(String(agreement.serviceDigestLo)), serviceDigestHi: BigInt(String(agreement.serviceDigestHi)), settlementNonceLo: BigInt(String(agreement.settlementNonceLo)), settlementNonceHi: BigInt(String(agreement.settlementNonceHi)), paymentAmount: BigInt(String(agreement.paymentAmount)), blinding: BigInt(String(agreement.blinding)), expiry: BigInt(String(agreement.expiry)), buyer: { seed: new Uint8Array(32), publicKey: (agreement.buyerPublicKey as string[]).map(BigInt) as [bigint, bigint] }, sellerPublicKey: (agreement.sellerPublicKey as string[]).map(BigInt) as [bigint, bigint], recipientSpendTag: BigInt(String(agreement.recipientSpendTag)) });
      const expected = values.dealCommitment.toString(16).padStart(64, "0");
      if (!/^[0-9a-f]{64}$/.test(expected) || !tx.events?.some((event) => event.packageId?.toLowerCase() === this.app.profile.packageId.toLowerCase() && event.module === (this.app.profile.verifierVersion === 2 ? "pool_v2" : "pool") && event.eventType?.endsWith("::TransferEvent") && event.json && bytes32(event.json.deal_commitment) === expected)) fail("SELLER_PAYMENT_UNVERIFIED", "pool transfer does not contain the signed deal commitment");
      await runtime.recover();
      const note = this.app.store.db.prepare("SELECT commitment FROM notes WHERE operation_id=? AND role='payment'").get(request.requestId) as { commitment: string } | undefined;
      if (!note) return fail("SELLER_PAYMENT_UNVERIFIED", "seller could not recover the payment note from the pinned pool");
      const leaf = this.app.store.db.prepare("SELECT transaction_digest FROM live_pool_leaves WHERE commitment=?").get(note.commitment) as { transaction_digest: string } | undefined;
      if (leaf?.transaction_digest !== request.paymentDigest) fail("SELLER_PAYMENT_UNVERIFIED", "recovered note does not belong to the supplied payment transaction");
    }
    const prior = this.app.store.db.prepare("SELECT request_id,agreement_hash FROM seller_payment_claims WHERE digest=?").get(request.paymentDigest) as { request_id: string; agreement_hash: string } | undefined;
    if (prior && (prior.request_id !== request.requestId || prior.agreement_hash !== request.agreementHash)) fail("SELLER_PAYMENT_REPLAY", "payment digest is already bound to another seller request");
    this.app.store.db.prepare("INSERT OR IGNORE INTO seller_payment_claims(digest,request_id,agreement_hash,created_at) VALUES(?,?,?,?)").run(request.paymentDigest, request.requestId, request.agreementHash, Date.now());
    return { finalized: true, tatumVerified: true, digest: request.paymentDigest, agreementHash: request.agreementHash, sellerId: String(agreement.counterparty), asset: this.app.profile.coinType, amount: request.agreedAmount, rail: request.rail };
  }
}
