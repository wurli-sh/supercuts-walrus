import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { isValidPersonalMessageSignature } from "@mysten/sui/verify";
import { validateCapabilityPayload, type SignedCapabilityRegistration } from "./capability.js";
import { fail, SupercutsError } from "./errors.js";
import { LiveRuntime, type LiveRuntimeProfile } from "./live-runtime.js";
import { LiveSellerPaymentVerifier } from "./live-seller-verifier.js";
import type { Phase3App } from "./phase3.js";
import { SellerRuntime, type ServiceHandler, type ServiceRequest, type ServiceResult } from "./seller-runtime.js";
import { canonicalJson } from "./settlement.js";
import { WalrusDealBlobs, wireDecrypt, wireEncrypt, wireHash, wireJsonHash, wireKey } from "./deal-wire.js";
import { X402ResourceService } from "./x402-resource-service.js";
import { dealChildId } from "./deal.js";

interface Prepared { session_id: string; capability_id: string; buyer_address: string; buyer_public_key: string; offer_hash: string; offer_ciphertext: string; reply_ciphertext: string; offer_blob_id: string | null; reply_blob_id: string | null; payment_operation_id: string; }
interface Offer { input: Record<string, unknown>; planHash: string; paymentOperationId: string; amount: string; maximum: string; rail: "shielded" | "x402"; draft: Record<string, unknown>; }
const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : fail("SELLER_REQUEST_INVALID", "deal wire identity is invalid");
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail("SELLER_REQUEST_INVALID", "deal wire object is invalid");
const halves = (hash: string): [string, string] => [BigInt(`0x${hash.slice(0, 32)}`).toString(), BigInt(`0x${hash.slice(32)}`).toString()];
const signedOffer = (sessionId: string, capabilityId: string, buyerPublicKey: string, ciphertext: string) => Buffer.from(`${sessionId}:${capabilityId}:${buyerPublicKey}:${wireHash(Buffer.from(ciphertext, "base64"))}`);

export class LiveSellerTransport {
  readonly runtime: SellerRuntime;
  readonly #blobs: WalrusDealBlobs;
  readonly #verifier: LiveSellerPaymentVerifier;
  readonly #resources = new Map<string, X402ResourceService>();
  readonly #registrations = new Map<string, SignedCapabilityRegistration>();
  constructor(private readonly app: Phase3App, private readonly config: { origin: string; facilitatorUrl?: string; facilitatorKey?: string; allowedBuyers?: string[]; persist?: () => Promise<void>; claimPayment?: (digest: string, requestId: string) => Promise<void> }, runtimeFactory?: () => Promise<LiveRuntime>) {
    if (app.profile.role !== "seller" || app.profile.mock) fail("SELLER_LIVE_REQUIRED", "generic seller transport requires a live seller role home");
    const origin = new URL(config.origin);
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(origin.hostname))) fail("SELLER_ORIGIN_INVALID", "seller transport requires HTTPS except on loopback");
    this.#blobs = new WalrusDealBlobs(app); this.#verifier = new LiveSellerPaymentVerifier(app, runtimeFactory);
    app.store.db.exec("CREATE TABLE IF NOT EXISTS seller_deal_prepares(session_id TEXT PRIMARY KEY,capability_id TEXT NOT NULL,buyer_address TEXT NOT NULL,buyer_public_key TEXT NOT NULL,offer_hash TEXT NOT NULL,offer_ciphertext TEXT NOT NULL,reply_ciphertext TEXT NOT NULL,offer_blob_id TEXT,reply_blob_id TEXT,payment_operation_id TEXT NOT NULL)");
    this.runtime = new SellerRuntime(app.store, {
      readBlob: (blobId) => this.#blobs.read(blobId),
      verifyPayment: (request) => this.#verifier.verify(request),
      encryptAndPublish: async (request, result) => {
        const row = this.prepared(request.requestId);
        const key = wireKey(app, row.buyer_public_key, request.requestId);
        const encoded = wireEncrypt(key, request.requestId, "delivery", { artifactBase64: Buffer.from(result.artifact).toString("base64"), contentType: result.contentType, metadata: result.metadata });
        const ciphertext = Buffer.from(encoded, "base64"), published = await this.#blobs.publish(ciphertext);
        return { blobId: published.blobId, ciphertext };
      },
      serve: async () => fail("SELLER_TRANSPORT_START", "start the seller HTTP service with createServer"),
    });
  }
  private prepared(sessionId: string): Prepared { return this.app.store.db.prepare("SELECT * FROM seller_deal_prepares WHERE session_id=?").get(sessionId) as Prepared | undefined ?? fail("NEGOTIATION_REQUIRED", "seller has no matching prepared deal"); }
  async register(registration: SignedCapabilityRegistration, handler: ServiceHandler): Promise<void> {
    if (registration.manifest.sellerId.toLowerCase() !== (await this.signer()).toSuiAddress().toLowerCase()) fail("SELLER_IDENTITY_MISMATCH", "capability seller does not match this role signer");
    if (new URL(registration.manifest.endpoint).origin !== new URL(this.config.origin).origin) fail("SELLER_ENDPOINT_MISMATCH", "capability endpoint must be hosted by this seller transport");
    await this.runtime.registerCapability(registration, handler);
    this.#registrations.set(registration.manifest.capabilityId, registration);
    if (registration.manifest.supportedRails.includes("x402")) {
      const facilitatorUrl = this.config.facilitatorUrl ?? fail("SELLER_FACILITATOR_REQUIRED", "x402 capability requires a facilitator URL");
      const facilitatorKey = this.config.facilitatorKey ?? fail("SELLER_FACILITATOR_REQUIRED", "x402 capability requires a seller-only facilitator key");
      const endpoint = new URL(registration.manifest.endpoint);
      const resource = new X402ResourceService(this.app.store, { origin: this.config.origin, pathPrefix: endpoint.pathname, facilitatorUrl, facilitatorKey, network: "sui:testnet", asset: registration.manifest.asset, payTo: registration.manifest.sellerId, amount: registration.manifest.priceBand.minimum }, fetch, this.config.persist, this.config.claimPayment);
      this.#resources.set(registration.manifest.capabilityId, resource);
      const rows = this.app.store.db.prepare("SELECT session_id,payment_operation_id FROM seller_deal_prepares WHERE capability_id=?").all(registration.manifest.capabilityId) as Array<{ session_id: string; payment_operation_id: string }>;
      for (const row of rows) resource.register(row.session_id, row.payment_operation_id, Buffer.from(canonicalJson({ status: "paid", requestId: row.session_id })));
    }
  }
  private async signer(): Promise<Ed25519Keypair> {
    const encoded = this.app.store.getSecret("live:sui-private-key")?.toString() ?? fail("LIVE_CREDENTIAL_MISSING", "seller signer is missing");
    const decoded = decodeSuiPrivateKey(encoded);
    if (decoded.scheme !== "ED25519") fail("SIGNER_UNSUPPORTED", "seller requires an ED25519 signer");
    return Ed25519Keypair.fromSecretKey(decoded.secretKey);
  }
  private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 256 * 1024) fail("SELLER_REQUEST_INVALID", "seller request exceeds 256 KiB"); chunks.push(chunk); }
    try { return object(JSON.parse(Buffer.concat(chunks).toString())); }
    catch (error) { return fail("SELLER_REQUEST_INVALID", "seller request is not JSON", error); }
  }
  private respond(response: ServerResponse, code: number, value: unknown): void {
    const bytes = Buffer.from(JSON.stringify(value)); response.writeHead(code, { "content-type": "application/json", "content-length": String(bytes.length), "cache-control": "no-store" }); response.end(bytes);
  }
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", this.config.origin);
      if (request.method === "GET" && url.pathname === "/v2/catalog") return this.respond(response, 200, { capabilities: this.runtime.catalog() });
      if (request.method === "POST" && url.pathname === "/v2/prepare") return this.respond(response, 200, await this.prepareRequest(await this.body(request)));
      if (request.method === "POST" && url.pathname === "/v2/fulfill") return this.respond(response, 200, await this.fulfillRequest(await this.body(request)));
      if (request.method === "GET") {
        for (const resource of this.#resources.values()) if (url.pathname.startsWith(`${(resource.config.pathPrefix ?? "/capability").replace(/\/$/, "")}/`)) return resource.handle(request, response);
      }
      return this.respond(response, 404, { error: "NOT_FOUND" });
    } catch (error) { const known = error instanceof SupercutsError ? error : new SupercutsError("SELLER_REQUEST_FAILED", "seller request failed"); if (!response.headersSent) this.respond(response, 400, { error: known.code, message: known.message }); }
  }
  createServer(): Server { return createServer((request, response) => void this.handle(request, response)); }

  async prepareRequest(body: Record<string, unknown>): Promise<Record<string, unknown>> { const result = await this.prepare(body); await this.config.persist?.(); return result; }
  async fulfillRequest(body: Record<string, unknown>): Promise<Record<string, unknown>> { const result = await this.fulfill(body); await this.config.persist?.(); return result; }

  private async prepare(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = id(body.sessionId), capabilityId = id(body.capabilityId);
    const registration = this.#registrations.get(capabilityId) ?? fail("SELLER_CAPABILITY_UNKNOWN", "capability is not registered");
    const buyerAddress = String(body.buyerAddress ?? ""), buyerPublicKey = String(body.buyerPublicKey ?? ""), ciphertext = String(body.ciphertext ?? ""), signature = String(body.buyerSignature ?? "");
    if (!/^0x[0-9a-f]{64}$/i.test(buyerAddress) || !buyerPublicKey || ciphertext.length > 192 * 1024 || !ciphertext || !signature) fail("SELLER_REQUEST_INVALID", "buyer identity or ciphertext is invalid");
    if (this.config.allowedBuyers && !this.config.allowedBuyers.some((item) => item.toLowerCase() === buyerAddress.toLowerCase())) fail("SELLER_BUYER_FORBIDDEN", "buyer is outside the seller allowlist");
    if (!(await isValidPersonalMessageSignature(signedOffer(sessionId, capabilityId, buyerPublicKey, ciphertext), signature, { address: buyerAddress }))) fail("SELLER_BUYER_SIGNATURE_INVALID", "buyer did not authorize the encrypted offer");
    const key = wireKey(this.app, buyerPublicKey, sessionId), offer = object(wireDecrypt(key, sessionId, "offer", ciphertext)) as unknown as Offer;
    const manifest = registration.manifest, draft = object(offer.draft), amount = manifest.priceBand.minimum;
    validateCapabilityPayload(manifest, "input", offer.input);
    if (offer.amount !== amount || !/^[1-9][0-9]*$/.test(offer.maximum) || BigInt(offer.maximum) < BigInt(amount) || BigInt(offer.maximum) > BigInt(manifest.priceBand.maximum) || !manifest.supportedRails.includes(offer.rail) || !/^[0-9a-f]{64}$/.test(offer.planHash)) fail("SELLER_OFFER_INVALID", "offer is outside signed price or rail terms");
    const taskHash = wireJsonHash(offer.input), transcript = wireJsonHash({ domain: "supercuts-deal-transcript-v1", sessionId, taskHash, planHash: offer.planHash, amount, rail: offer.rail });
    const service = wireJsonHash({ domain: "supercuts-deal-service-v1", taskHash, planHash: offer.planHash, capabilityId, rail: offer.rail, buyerPublicKey });
    const [transcriptRootLo, transcriptRootHi] = halves(transcript), [serviceDigestLo, serviceDigestHi] = halves(service);
    const dealOperationId = typeof body.dealOperationId === "string" && body.dealOperationId.length <= 256 && body.dealOperationId.length > 0 ? body.dealOperationId : fail("SELLER_REQUEST_INVALID", "deal operation ID is invalid");
    if (draft.sessionId !== sessionId || draft.dealOperationId !== dealOperationId || draft.capabilityId !== capabilityId || draft.manifestHash !== manifest.manifestHash || draft.counterparty !== manifest.sellerId || draft.paymentAmount !== amount || draft.rail !== offer.rail || draft.taskHash !== taskHash || draft.planHash !== offer.planHash || draft.transcriptRootLo !== transcriptRootLo || draft.transcriptRootHi !== transcriptRootHi || draft.serviceDigestLo !== serviceDigestLo || draft.serviceDigestHi !== serviceDigestHi || offer.paymentOperationId !== dealChildId(dealOperationId, "payment")) fail("AGREEMENT_BINDING_MISMATCH", "draft does not bind the encrypted task and signed capability");
    const prior = this.app.store.db.prepare("SELECT offer_hash FROM seller_deal_prepares WHERE session_id=?").get(sessionId) as { offer_hash: string } | undefined;
    const offerHash = wireHash(Buffer.from(ciphertext, "base64"));
    if (prior && prior.offer_hash !== offerHash) fail("NEGOTIATION_SESSION_CONFLICT", "session identifies a different encrypted offer");
    const runtime = await LiveRuntime.create(this.app.profile as LiveRuntimeProfile, this.app.store);
    const signed = runtime.prepareSellerAgreement(sessionId, Buffer.from(canonicalJson(draft)).toString("base64url"));
    const agreement = Buffer.from(String(signed.agreement), "base64url").toString(), agreementHash = wireHash(agreement);
    const resource = offer.rail === "x402" ? this.#resources.get(capabilityId) ?? fail("SELLER_RAIL_UNSUPPORTED", "seller has no x402 resource") : undefined;
    const resourceUrl = resource?.register(sessionId, offer.paymentOperationId, Buffer.from(canonicalJson({ status: "paid", requestId: sessionId }))).url;
    const replyCiphertext = prior ? this.prepared(sessionId).reply_ciphertext : wireEncrypt(key, sessionId, "reply", { agreement: signed.agreement, agreementHash, dealCommitment: signed.dealCommitment, ...(resourceUrl ? { resourceUrl } : {}) });
    if (!prior) this.app.store.db.prepare("INSERT INTO seller_deal_prepares(session_id,capability_id,buyer_address,buyer_public_key,offer_hash,offer_ciphertext,reply_ciphertext,payment_operation_id) VALUES(?,?,?,?,?,?,?,?)").run(sessionId, capabilityId, buyerAddress, buyerPublicKey, offerHash, ciphertext, replyCiphertext, offer.paymentOperationId);
    const offerBlob = await this.#blobs.publish(Buffer.from(ciphertext, "base64")), replyBlob = await this.#blobs.publish(Buffer.from(replyCiphertext, "base64"));
    this.app.store.db.prepare("UPDATE seller_deal_prepares SET offer_blob_id=?,reply_blob_id=? WHERE session_id=?").run(offerBlob.blobId, replyBlob.blobId, sessionId);
    return { sessionId, capabilityId, offerBlob, replyBlob, agreementBlob: replyBlob, ciphertext: replyCiphertext };
  }
  private async fulfill(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = id(body.sessionId), row = this.prepared(sessionId), ciphertext = String(body.ciphertext ?? ""), signature = String(body.buyerSignature ?? "");
    if (!ciphertext || ciphertext.length > 192 * 1024 || !(await isValidPersonalMessageSignature(Buffer.from(`${sessionId}:${wireHash(Buffer.from(ciphertext, "base64"))}`), signature, { address: row.buyer_address }))) fail("SELLER_BUYER_SIGNATURE_INVALID", "buyer did not authorize the delivery request");
    const key = wireKey(this.app, row.buyer_public_key, sessionId), serviceRequest = wireDecrypt<ServiceRequest>(key, sessionId, "fulfill", ciphertext);
    if (serviceRequest.requestId !== sessionId || serviceRequest.capabilityId !== row.capability_id) fail("SELLER_REQUEST_INVALID", "fulfillment differs from prepared seller request");
    const delivery = await this.runtime.fulfill(serviceRequest);
    return { sessionId, ciphertext: wireEncrypt(key, sessionId, "receipt", delivery) };
  }
}
