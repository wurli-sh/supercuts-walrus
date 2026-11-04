import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { verifySignedCapability, type SignedCapabilityRegistration } from "./capability.js";
import type { DealArtifact, DealNegotiation, DealOutcome, DealPayment, DealPorts } from "./deal-engine.js";
import type { ExecuteDealInput } from "./deal.js";
import { WalrusDealBlobs, wireDecrypt, wireEncrypt, wireHash, wireJsonHash, wireKey } from "./deal-wire.js";
import { fail } from "./errors.js";
import { LiveRuntime, type LiveRuntimeProfile } from "./live-runtime.js";
import { executeMandated, type AgentMandate } from "./mandate.js";
import type { Phase3App } from "./phase3.js";
import { canonicalJson, settlementMandateHash, validateSettlementPlan, type SettlementPlanV1 } from "./settlement.js";
import type { SellerDelivery, ServiceRequest } from "./seller-runtime.js";
import { validateDirectoryOrigin } from "./seller-directory.js";

type LiveNegotiation = DealNegotiation & { sessionId: string; agreementHash: string; agreedAmount: string; resourceUrl?: string; sellerOrigin: string; sellerTransportPublicKey: string; };
const halves = (hash: string): [string, string] => [BigInt(`0x${hash.slice(0, 32)}`).toString(), BigInt(`0x${hash.slice(32)}`).toString()];
const scalar = () => BigInt(`0x${randomBytes(16).toString("hex")}`).toString();
const offerSignatureBytes = (sessionId: string, capabilityId: string, buyerPublicKey: string, ciphertext: string) => Buffer.from(`${sessionId}:${capabilityId}:${buyerPublicKey}:${wireHash(Buffer.from(ciphertext, "base64"))}`);

/** Built-in live buyer adapter. The owner supplies only seller catalog origins;
 * signing, payment, Walrus and memory stay in the buyer role home. */
export class LiveDealPorts implements DealPorts {
  readonly #blobs!: WalrusDealBlobs;
  readonly #origins!: URL[];
  readonly #directory?: URL;
  constructor(private readonly app: Phase3App, private readonly mandate: AgentMandate, private readonly http: typeof fetch = fetch) {
    if (app.profile.role !== "buyer" || app.profile.mock) fail("DEAL_LIVE_REQUIRED", "built-in deal adapter requires a live buyer role");
    const path = join(app.home, "deal-sellers.json");
    let source: unknown;
    try { if ((statSync(path).mode & 0o077) !== 0) fail("DEAL_SELLERS_PERMISSIONS", "seller catalog configuration must be owner-only"); source = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) { return fail("DEAL_SELLERS_NOT_CONFIGURED", "buyer requires owner-only deal-sellers.json containing seller origins", error); }
    const config: { origins?: unknown[]; directoryUrl?: string } = Array.isArray(source) ? { origins: source } : source as { origins?: unknown[]; directoryUrl?: string };
    if (!config || !Array.isArray(config.origins) || config.origins.length > 32 || !config.origins.length && !config.directoryUrl) return fail("DEAL_SELLERS_INVALID", "seller configuration requires a directory or 1..32 origins");
    this.#origins = config.origins.map((value: unknown) => {
      const url = new URL(String(value));
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) fail("DEAL_SELLERS_INVALID", "seller origin must be HTTPS or loopback HTTP without path or credentials");
      return url;
    });
    if (config.directoryUrl) {
      const url = new URL(config.directoryUrl);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) fail("DEAL_SELLERS_INVALID", "directory URL must be an HTTPS or loopback origin");
      this.#directory = url;
    }
    this.#blobs = new WalrusDealBlobs(app, http);
  }
  readBlob(blobId: string): Promise<Uint8Array> { return this.#blobs.read(blobId); }
  private signer(): Ed25519Keypair {
    const encoded = this.app.store.getSecret("live:sui-private-key")?.toString() ?? fail("LIVE_CREDENTIAL_MISSING", "buyer signer is missing");
    const decoded = decodeSuiPrivateKey(encoded);
    if (decoded.scheme !== "ED25519") fail("SIGNER_UNSUPPORTED", "buyer requires an ED25519 signer");
    return Ed25519Keypair.fromSecretKey(decoded.secretKey);
  }
  private async request(origin: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await this.http(new URL(path, origin), { ...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(90_000) });
    let value: unknown; try { value = await response.json(); } catch (error) { return fail("DEAL_SELLER_RESPONSE_INVALID", "seller response is not JSON", error); }
    if (!response.ok || !value || typeof value !== "object" || Array.isArray(value)) fail("DEAL_SELLER_RESPONSE_INVALID", `seller returned HTTP ${response.status}`);
    return value as Record<string, unknown>;
  }
  async catalog(): Promise<Array<{ origin: string; registration: SignedCapabilityRegistration }>> {
    const found: Array<{ origin: string; registration: SignedCapabilityRegistration }> = [];
    const sources = this.#origins.map((origin) => ({ origin, path: "/v2/catalog" }));
    if (this.#directory) sources.push({ origin: this.#directory, path: "/v2/directory/catalog" });
    for (const { origin, path } of sources) {
      let offset = 0;
      do {
      const catalog = await this.request(origin.toString(), path === "/v2/directory/catalog" ? `${path}?offset=${offset}` : path);
      if (!Array.isArray(catalog.capabilities) || catalog.capabilities.length > 100) fail("SELLER_CATALOG_INVALID", "seller catalog is invalid");
      for (const item of catalog.capabilities as unknown[]) {
        const registration = item as SignedCapabilityRegistration;
        await verifySignedCapability(registration);
        if (path === "/v2/catalog" && new URL(registration.manifest.endpoint).origin !== origin.origin) fail("SELLER_CATALOG_INVALID", "signed capability points outside catalog seller origin");
        if (!this.mandate.allowedCounterparties.includes(registration.manifest.sellerId) || this.mandate.allowedCapabilityIds && !this.mandate.allowedCapabilityIds.includes(registration.manifest.capabilityId) || this.mandate.allowedCapabilityClasses && !this.mandate.allowedCapabilityClasses.includes(registration.manifest.capability)) continue;
        if (path === "/v2/directory/catalog") {
          const endpoint = await validateDirectoryOrigin(registration.manifest.endpoint);
          const served = await this.request(endpoint.origin, "/v2/catalog");
          if (!Array.isArray(served.capabilities) || !served.capabilities.some((item) => canonicalJson(item) === canonicalJson(registration))) fail("SELLER_CATALOG_INVALID", "directory listing is no longer served by the seller");
        }
        const readback = await this.readBlob(registration.manifestBlobId);
        if (canonicalJson(JSON.parse(Buffer.from(readback).toString())) !== canonicalJson(registration.manifest)) fail("CAPABILITY_BLOB_MISMATCH", "Walrus capability blob differs from signed manifest");
        found.push({ origin: new URL(registration.manifest.endpoint).origin, registration });
      }
      if (path !== "/v2/directory/catalog" || catalog.nextOffset === undefined) break;
      if (catalog.nextOffset !== offset + 100 || (catalog.capabilities as unknown[]).length !== 100) fail("SELLER_CATALOG_INVALID", "directory pagination is invalid");
      offset = catalog.nextOffset as number;
      if (offset > 100_000) fail("SELLER_CATALOG_INVALID", "directory contains too many listings");
      } while (true);
    }
    return found;
  }
  async discover(input: ExecuteDealInput): Promise<SignedCapabilityRegistration> {
    const candidates = (await this.catalog()).map(({ registration }) => registration).filter((registration) =>
      (input.capabilityId && registration.manifest.capabilityId === input.capabilityId || input.capabilityClass && registration.manifest.capability === input.capabilityClass) && registration.manifest.asset === input.budget.asset);
    if (!candidates.length) fail("DEAL_CAPABILITY_NOT_FOUND", "configured sellers have no matching signed capability");
    candidates.sort((a, b) => BigInt(a.manifest.priceBand.minimum) < BigInt(b.manifest.priceBand.minimum) ? -1 : BigInt(a.manifest.priceBand.minimum) > BigInt(b.manifest.priceBand.minimum) ? 1 : a.manifest.capabilityId.localeCompare(b.manifest.capabilityId));
    return candidates[0]!;
  }
  async plan(input: ExecuteDealInput, registration: SignedCapabilityRegistration, paymentOperationId: string): Promise<SettlementPlanV1> {
    const existing = this.app.store.db.prepare("SELECT plan_json FROM settlement_plans WHERE operation_id=?").get(paymentOperationId) as { plan_json: string } | undefined;
    if (existing) {
      const saved = JSON.parse(existing.plan_json) as SettlementPlanV1;
      validateSettlementPlan(saved);
      if (saved.mandateHash !== settlementMandateHash(this.mandate) || saved.manifestHash !== registration.manifest.manifestHash || saved.operationId !== paymentOperationId) fail("DEAL_PLAN_MISMATCH", "persisted plan differs from the owner mandate or seller capability");
      return saved;
    }
    const result = await executeMandated(this.app, this.mandate, "settlement.plan", { "operation-id": paymentOperationId, manifest: registration.manifest, "requested-amount": registration.manifest.priceBand.minimum, ...(input.privacyHint ? { "privacy-hint": input.privacyHint } : {}), ...(input.requestedRail ? { "requested-rail": input.requestedRail } : {}) });
    return result as unknown as SettlementPlanV1;
  }
  async negotiate(input: ExecuteDealInput, registration: SignedCapabilityRegistration, plan: SettlementPlanV1, agreementOperationId: string): Promise<LiveNegotiation> {
    const sessionId = agreementOperationId, capabilityId = registration.manifest.capabilityId, buyerPublicKey = this.app.store.getSecret("identity:x25519-public")?.toString("base64url") ?? fail("IDENTITY_MISSING", "buyer transport key is missing");
    const key = wireKey(this.app, registration.transportPublicKey, sessionId), taskHash = wireJsonHash(input.input), amount = registration.manifest.priceBand.minimum;
    const transcript = wireJsonHash({ domain: "supercuts-deal-transcript-v1", sessionId, taskHash, planHash: plan.planHash, amount, rail: plan.rail });
    const service = wireJsonHash({ domain: "supercuts-deal-service-v1", taskHash, planHash: plan.planHash, capabilityId, rail: plan.rail, buyerPublicKey });
    const [transcriptRootLo, transcriptRootHi] = halves(transcript), [serviceDigestLo, serviceDigestHi] = halves(service);
    const secretKey = `deal:wire:offer:${sessionId}`;
    let ciphertext = this.app.store.getSecret(secretKey)?.toString();
    if (!ciphertext) {
      const runtime = await LiveRuntime.create(this.app.profile as LiveRuntimeProfile, this.app.store);
      const buyer = runtime.engine.identity(this.app.store.getSecret("identity:babyjub-seed") ?? fail("IDENTITY_MISSING", "buyer settlement identity is missing"));
      const draft = { sessionId, dealOperationId: input.operationId, capabilityId, manifestHash: registration.manifest.manifestHash, counterparty: registration.manifest.sellerId, paymentAmount: amount, rail: plan.rail, taskHash, planHash: plan.planHash, dealId: scalar(), revision: "1", transcriptRootLo, transcriptRootHi, serviceDigestLo, serviceDigestHi, settlementNonceLo: scalar(), settlementNonceHi: scalar(), blinding: scalar(), expiry: String(Math.min(plan.expiresAt, Date.now() + 30 * 60_000)), buyerPublicKey: buyer.publicKey.map(String) };
      ciphertext = wireEncrypt(key, sessionId, "offer", { input: input.input, planHash: plan.planHash, paymentOperationId: plan.operationId, amount, maximum: plan.maximumAmount, rail: plan.rail, draft });
      this.app.store.putSecretOnce(secretKey, Buffer.from(ciphertext));
    }
    const signer = this.signer(), signature = (await signer.signPersonalMessage(offerSignatureBytes(sessionId, capabilityId, buyerPublicKey, ciphertext))).signature;
    const origin = new URL(registration.manifest.endpoint).origin;
    const reply = await this.request(origin, "/v2/prepare", { sessionId, capabilityId, dealOperationId: input.operationId, buyerAddress: signer.toSuiAddress(), buyerPublicKey, buyerSignature: signature, ciphertext });
    if (reply.sessionId !== sessionId || reply.capabilityId !== capabilityId || typeof reply.ciphertext !== "string") return fail("DEAL_SELLER_RESPONSE_INVALID", "seller changed the prepared deal identity");
    const offerBlob = reply.offerBlob as { blobId: string; ciphertextHash: string }, replyBlob = reply.replyBlob as { blobId: string; ciphertextHash: string }, agreementBlob = reply.agreementBlob as { blobId: string; ciphertextHash: string };
    if (wireHash(await this.readBlob(offerBlob.blobId)) !== offerBlob.ciphertextHash || offerBlob.ciphertextHash !== wireHash(Buffer.from(ciphertext, "base64")) || wireHash(await this.readBlob(replyBlob.blobId)) !== replyBlob.ciphertextHash || replyBlob.ciphertextHash !== wireHash(Buffer.from(reply.ciphertext, "base64")) || agreementBlob.blobId !== replyBlob.blobId || agreementBlob.ciphertextHash !== replyBlob.ciphertextHash) fail("WALRUS_BLOB_MISMATCH", "seller transcript differs from encrypted Walrus evidence");
    const decoded = wireDecrypt<{ agreement: string; agreementHash: string; dealCommitment: string; resourceUrl?: string }>(key, sessionId, "reply", reply.ciphertext);
    if (plan.rail === "x402" && decoded.resourceUrl !== `${registration.manifest.endpoint.replace(/\/$/, "")}/${encodeURIComponent(sessionId)}` || plan.rail === "shielded" && decoded.resourceUrl) fail("DEAL_RESOURCE_MISMATCH", "seller returned a resource outside the signed capability endpoint");
    const rawAgreement = Buffer.from(decoded.agreement, "base64url").toString(), agreement = JSON.parse(rawAgreement) as Record<string, unknown>;
    if (wireHash(rawAgreement) !== decoded.agreementHash || agreement.sessionId !== sessionId || agreement.dealOperationId !== input.operationId || agreement.capabilityId !== capabilityId || agreement.manifestHash !== registration.manifest.manifestHash || agreement.counterparty !== registration.manifest.sellerId || agreement.paymentAmount !== amount || agreement.rail !== plan.rail || agreement.taskHash !== taskHash || agreement.planHash !== plan.planHash || agreement.transcriptRootLo !== transcriptRootLo || agreement.transcriptRootHi !== transcriptRootHi || agreement.serviceDigestLo !== serviceDigestLo || agreement.serviceDigestHi !== serviceDigestHi) fail("AGREEMENT_BINDING_MISMATCH", "seller signed different deal terms");
    const accepted = await executeMandated(this.app, this.mandate, "offer.accept", { "operation-id": `accept-${sessionId}`, session: sessionId, agreement: decoded.agreement, ...(plan.rail === "shielded" ? { "plan-hash": plan.planHash } : {}) });
    if (accepted.dealCommitment !== decoded.dealCommitment) fail("AGREEMENT_BINDING_MISMATCH", "seller commitment differs from accepted agreement");
    return { sessionId, agreementHash: decoded.agreementHash, agreedAmount: amount, sellerOrigin: origin, sellerTransportPublicKey: registration.transportPublicKey, ...(decoded.resourceUrl ? { resourceUrl: decoded.resourceUrl } : {}), transcriptBlobs: [offerBlob, replyBlob], agreementBlobId: agreementBlob.blobId, agreementCiphertextHash: agreementBlob.ciphertextHash };
  }
  async pay(input: ExecuteDealInput, plan: SettlementPlanV1, negotiation: DealNegotiation, paymentOperationId: string): Promise<DealPayment> {
    const prepared = negotiation as LiveNegotiation;
    if (!prepared.sessionId || !prepared.agreementHash || prepared.agreedAmount !== plan.manifestMinimum) fail("DEAL_AGREEMENT_INVALID", "saved negotiation is missing exact payment terms");
    const result = plan.rail === "shielded" ? await executeMandated(this.app, this.mandate, "pay.shielded", { "operation-id": paymentOperationId, session: prepared.sessionId, "plan-hash": plan.planHash }) : await executeMandated(this.app, this.mandate, "pay.x402", { "operation-id": paymentOperationId, "resource-url": prepared.resourceUrl ?? fail("DEAL_RESOURCE_MISSING", "seller did not provide an x402 protected resource"), "plan-hash": plan.planHash });
    if (result.finalized !== true || result.tatumVerified !== true || result.rail !== plan.rail || result.amount !== prepared.agreedAmount || result.counterparty !== plan.sellerId || result.asset !== plan.asset || typeof result.transactionDigest !== "string") return fail("DEAL_PAYMENT_UNVERIFIED", "live payment differs from the accepted agreement and settlement plan");
    if (plan.rail === "x402") {
      const response = JSON.parse(Buffer.from(String(result.response ?? ""), "base64").toString()) as Record<string, unknown>;
      if (response.status !== "paid" || response.requestId !== prepared.sessionId) fail("DEAL_PAYMENT_UNVERIFIED", "seller-owned x402 resource returned a different receipt");
    }
    return { transactionDigest: result.transactionDigest, finalized: true, tatumVerified: true, ...(typeof result.proveMs === "number" ? { proveMs: result.proveMs } : {}) };
  }
  async deliver(input: ExecuteDealInput, plan: SettlementPlanV1, negotiation: DealNegotiation, payment: DealPayment, _deliveryOperationId: string): Promise<DealArtifact> {
    const prepared = negotiation as LiveNegotiation, key = wireKey(this.app, prepared.sellerTransportPublicKey, prepared.sessionId);
    const request: ServiceRequest = { dealId: input.operationId, capabilityId: plan.capabilityId, input: input.input, requestId: prepared.sessionId, paymentDigest: payment.transactionDigest, agreementHash: prepared.agreementHash, agreedAmount: prepared.agreedAmount, rail: plan.rail };
    const ciphertext = wireEncrypt(key, prepared.sessionId, "fulfill", request), signer = this.signer();
    const signature = (await signer.signPersonalMessage(Buffer.from(`${prepared.sessionId}:${wireHash(Buffer.from(ciphertext, "base64"))}`))).signature;
    const reply = await this.request(prepared.sellerOrigin, "/v2/fulfill", { sessionId: prepared.sessionId, sellerId: plan.sellerId, ciphertext, buyerSignature: signature });
    if (reply.sessionId !== prepared.sessionId || typeof reply.ciphertext !== "string") return fail("DEAL_DELIVERY_UNVERIFIED", "seller delivery response is invalid");
    const receipt = wireDecrypt<SellerDelivery>(key, prepared.sessionId, "receipt", reply.ciphertext);
    if (receipt.dealId !== input.operationId || receipt.requestId !== prepared.sessionId) fail("DEAL_DELIVERY_UNVERIFIED", "seller delivery belongs to another deal");
    const encrypted = await this.readBlob(receipt.blobId);
    if (wireHash(encrypted) !== receipt.ciphertextHash) fail("WALRUS_BLOB_MISMATCH", "seller delivery ciphertext differs from Walrus");
    const artifact = wireDecrypt<{ artifactBase64: string; contentType: string; metadata: Record<string, unknown> }>(key, prepared.sessionId, "delivery", Buffer.from(encrypted).toString("base64"));
    if (wireHash(Buffer.from(artifact.artifactBase64, "base64")) !== receipt.artifactSha256 || artifact.contentType !== receipt.contentType || canonicalJson(artifact.metadata) !== canonicalJson(receipt.metadata)) fail("DEAL_DELIVERY_UNVERIFIED", "seller delivery bytes or metadata differ from the receipt");
    return { blobId: receipt.blobId, ciphertextHash: receipt.ciphertextHash, artifactSha256: receipt.artifactSha256, contentType: receipt.contentType, metadata: receipt.metadata, artifactBase64: artifact.artifactBase64 };
  }
  async rememberOutcome(input: ExecuteDealInput, plan: SettlementPlanV1, payment: DealPayment, artifact: DealArtifact, _outcomeOperationId: string): Promise<{ queued: true; payloadHash: string }> {
    return this.app.recordVerifiedDealOutcome(input.operationId, plan.planHash, payment.transactionDigest, artifact.artifactSha256);
  }
  async inventory(blobId: string): Promise<boolean> {
    const result = (await this.app.execute("memory.inventory", { "blob-id": blobId })).data;
    return result.present === true;
  }
}
