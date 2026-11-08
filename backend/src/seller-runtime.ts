import { createHash } from "node:crypto";
import { verifySignedCapability, validateCapabilityPayload, type SignedCapabilityRegistration } from "./capability.js";
import { fail } from "./errors.js";
import { canonicalJson } from "./settlement.js";
import type { RoleStore } from "./store.js";

/**
 * Buyers may hold agreements under an active capability's signed terms, so those terms cannot change
 * under the same ID until it expires. Provisioning runs the same rule before writing, so a seller is
 * never left with a catalog entry it refuses to load at startup.
 */
export function assertCapabilityReplaceable(old: SignedCapabilityRegistration | undefined, next: SignedCapabilityRegistration, now = Date.now()): void {
  if (!old || old.manifest.manifestHash === next.manifest.manifestHash) return;
  if (old.manifest.sellerId !== next.manifest.sellerId || old.manifest.capabilityId !== next.manifest.capabilityId) fail("SELLER_CAPABILITY_CONFLICT", "a capability cannot change seller or ID");
  if (old.manifest.expiresAt > now) fail("SELLER_CAPABILITY_CONFLICT", `${next.manifest.capabilityId} is active until ${new Date(old.manifest.expiresAt).toISOString()} and its signed terms cannot change; publish the new terms under a new capability ID, or wait until it expires`);
}

export interface ServiceRequest {
  dealId: string;
  capabilityId: string;
  input: Record<string, unknown>;
  requestId: string;
  paymentDigest: string;
  agreementHash: string;
  agreedAmount: string;
  rail: "shielded" | "x402";
}
export interface ServiceResult {
  artifact: Uint8Array;
  contentType: string;
  metadata: Record<string, unknown>;
}
export type ServiceHandler = (request: ServiceRequest) => Promise<ServiceResult>;
export interface VerifiedSellerPayment {
  finalized: true;
  tatumVerified: true;
  digest: string;
  agreementHash: string;
  sellerId: string;
  asset: string;
  amount: string;
  rail: "shielded" | "x402";
}
export interface SellerRuntimePorts {
  readBlob(blobId: string): Promise<Uint8Array>;
  verifyPayment(request: ServiceRequest): Promise<VerifiedSellerPayment>;
  encryptAndPublish(request: ServiceRequest, result: ServiceResult): Promise<{ blobId: string; ciphertext: Uint8Array }>;
  serve(runtime: SellerRuntime): Promise<void>;
}
export interface SellerDelivery { dealId: string; requestId: string; blobId: string; ciphertextHash: string; artifactSha256: string; contentType: string; metadata: Record<string, unknown>; }

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const cacheKey = (requestId: string) => `seller:delivery:${requestId}`;

/** Framework-neutral seller execution boundary. The trusted payment verifier
 * must use chain finality and exact agreement binding, never a buyer's digest
 * alone. The transport must decrypt/authenticate task input before calling
 * fulfill and encrypt the artifact before Walrus publication. */
export class SellerRuntime {
  readonly #handlers = new Map<string, { registration: SignedCapabilityRegistration; handler: ServiceHandler }>();
  constructor(private readonly store: RoleStore, private readonly ports: SellerRuntimePorts) {
    store.db.exec("CREATE TABLE IF NOT EXISTS seller_runtime_deliveries(request_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,status TEXT NOT NULL,blob_id TEXT,artifact_sha256 TEXT,created_at INTEGER NOT NULL)");
  }

  async registerCapability(registration: SignedCapabilityRegistration, handler: ServiceHandler): Promise<void> {
    await verifySignedCapability(registration);
    const bytes = await this.ports.readBlob(registration.manifestBlobId);
    let remote: unknown;
    try { remote = JSON.parse(Buffer.from(bytes).toString()); } catch (error) { return fail("CAPABILITY_BLOB_INVALID", "Walrus capability blob is not JSON", error); }
    if (canonicalJson(remote) !== canonicalJson(registration.manifest)) fail("CAPABILITY_BLOB_MISMATCH", "Walrus capability blob differs from the seller's signed manifest");
    const id = registration.manifest.capabilityId;
    const prior = this.#handlers.get(id);
    const saved = this.store.getSecret(`seller:capability:${id}`);
    const old = saved ? JSON.parse(saved.toString()) as SignedCapabilityRegistration : prior?.registration;
    if (old && old.manifest.manifestHash !== registration.manifest.manifestHash) {
      assertCapabilityReplaceable(old, registration);
      this.store.putSecret(`seller:capability:${id}`, Buffer.from(canonicalJson(registration)));
    } else this.store.putSecretOnce(`seller:capability:${id}`, Buffer.from(canonicalJson(registration)));
    this.#handlers.set(id, { registration, handler });
  }

  catalog(): Array<SignedCapabilityRegistration> { return [...this.#handlers.values()].map((item) => item.registration); }

  async fulfill(request: ServiceRequest): Promise<SellerDelivery> {
    if (!request || typeof request.requestId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(request.requestId) || typeof request.dealId !== "string" || !request.dealId || typeof request.paymentDigest !== "string" || !request.paymentDigest || typeof request.agreementHash !== "string" || !/^[0-9a-f]{64}$/.test(request.agreementHash) || typeof request.agreedAmount !== "string" || !/^[1-9][0-9]*$/.test(request.agreedAmount) || !request.input || typeof request.input !== "object" || Array.isArray(request.input)) fail("SELLER_REQUEST_INVALID", "deal or request identity is invalid");
    const registered = this.#handlers.get(request.capabilityId) ?? fail("SELLER_CAPABILITY_UNKNOWN", "capability is not registered");
    const manifest = registered.registration.manifest;
    if (!manifest.supportedRails.includes(request.rail)) fail("SELLER_RAIL_UNSUPPORTED", "seller capability does not offer this payment rail");
    if (BigInt(request.agreedAmount) < BigInt(manifest.priceBand.minimum) || BigInt(request.agreedAmount) > BigInt(manifest.priceBand.maximum)) fail("SELLER_PAYMENT_UNVERIFIED", "agreed amount is outside the signed capability price band");
    validateCapabilityPayload(manifest, "input", request.input);
    const requestHash = sha256(canonicalJson({ domain: "supercuts-seller-request-v1", request }));
    const prior = this.store.db.prepare("SELECT request_hash,status FROM seller_runtime_deliveries WHERE request_id=?").get(request.requestId) as { request_hash: string; status: string } | undefined;
    if (prior && prior.request_hash !== requestHash) fail("SELLER_REQUEST_CONFLICT", "request ID identifies a different task or payment");
    if (prior?.status === "complete") {
      const saved = this.store.getSecret(cacheKey(request.requestId)) ?? fail("SELLER_DELIVERY_CORRUPT", "completed delivery metadata is missing");
      return JSON.parse(saved.toString()) as SellerDelivery;
    }
    if (prior) fail("SELLER_DELIVERY_UNRESOLVED", "seller request may already have run; operator reconciliation is required");

    const payment = await this.ports.verifyPayment(request);
    if (payment.finalized !== true || payment.tatumVerified !== true || payment.digest !== request.paymentDigest || payment.agreementHash !== request.agreementHash || payment.sellerId !== manifest.sellerId || payment.asset !== manifest.asset || payment.amount !== request.agreedAmount || payment.rail !== request.rail) fail("SELLER_PAYMENT_UNVERIFIED", "final payment does not match the signed capability and agreement");
    this.store.db.prepare("INSERT INTO seller_runtime_deliveries(request_id,request_hash,status,created_at) VALUES(?,?,'running',?)").run(request.requestId, requestHash, Date.now());
    const result = await registered.handler(request);
    if (!(result.artifact instanceof Uint8Array) || result.artifact.length > 512 * 1024 || !result.artifact.length || typeof result.contentType !== "string" || !result.contentType) fail("DEAL_ARTIFACT_TOO_LARGE", "seller artifact must contain 1..524288 bytes and a content type");
    if (!result.metadata || typeof result.metadata !== "object" || Array.isArray(result.metadata)) fail("CAPABILITY_PAYLOAD_INVALID", "seller metadata must be an object");
    validateCapabilityPayload(manifest, "output", result.metadata);
    const published = await this.ports.encryptAndPublish(request, result);
    if (!published.blobId || !(published.ciphertext instanceof Uint8Array) || !published.ciphertext.length) fail("SELLER_DELIVERY_INVALID", "encrypted delivery publication is incomplete");
    const fetched = await this.ports.readBlob(published.blobId);
    if (!Buffer.from(fetched).equals(Buffer.from(published.ciphertext))) fail("WALRUS_BLOB_MISMATCH", "encrypted seller delivery failed Walrus readback");
    const delivery: SellerDelivery = { dealId: request.dealId, requestId: request.requestId, blobId: published.blobId, ciphertextHash: sha256(published.ciphertext), artifactSha256: sha256(result.artifact), contentType: result.contentType, metadata: result.metadata };
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.putSecretOnce(cacheKey(request.requestId), Buffer.from(canonicalJson(delivery)));
      this.store.db.prepare("UPDATE seller_runtime_deliveries SET status='complete',blob_id=?,artifact_sha256=? WHERE request_id=? AND status='running'").run(delivery.blobId, delivery.artifactSha256, request.requestId);
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
    return delivery;
  }

  serve(): Promise<void> { return this.ports.serve(this); }
}
