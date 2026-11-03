import { createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from "node:crypto";
import { fail } from "./errors.js";
import { decryptSessionMessage, encryptSessionMessage } from "./negotiation.js";
import { canonicalJson } from "./settlement.js";
import type { Phase3App } from "./phase3.js";

export const wireHash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
export const wireJsonHash = (value: unknown): string => wireHash(canonicalJson(value));
export function wireKey(app: Phase3App, peerPublicKey: string, sessionId: string): Buffer {
  const privateDer = app.store.getSecret("identity:x25519-private") ?? fail("IDENTITY_MISSING", "role transport key is missing");
  let publicKey;
  try { publicKey = createPublicKey({ key: Buffer.from(peerPublicKey, "base64url"), format: "der", type: "spki" }); }
  catch (error) { return fail("DEAL_TRANSPORT_KEY_INVALID", "peer transport key is invalid", error); }
  if (publicKey.asymmetricKeyType !== "x25519") fail("DEAL_TRANSPORT_KEY_INVALID", "peer transport key must be X25519");
  const shared = diffieHellman({ privateKey: createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" }), publicKey });
  return Buffer.from(hkdfSync("sha256", shared, Buffer.from(sessionId), Buffer.from("supercuts-deal-wire-v1"), 32));
}
export function wireEncrypt(key: Uint8Array, sessionId: string, kind: string, value: unknown): string {
  return encryptSessionMessage(key, sessionId, `${sessionId}:${kind}`, Buffer.from(canonicalJson(value)));
}
export function wireDecrypt<T>(key: Uint8Array, sessionId: string, kind: string, ciphertext: string): T {
  try { return JSON.parse(decryptSessionMessage(key, sessionId, `${sessionId}:${kind}`, ciphertext).toString()) as T; }
  catch (error) { return fail("DEAL_MESSAGE_INVALID", "encrypted deal message could not be decoded", error); }
}
export class WalrusDealBlobs {
  readonly #publisher: string; readonly #aggregator: string;
  constructor(app: Phase3App, private readonly http: typeof fetch = fetch) {
    this.#publisher = app.profile.live?.walrusPublisherUrl ?? fail("LIVE_WALRUS_CONFIG_MISSING", "Walrus publisher is required");
    this.#aggregator = app.profile.live?.walrusAggregatorUrl ?? fail("LIVE_WALRUS_CONFIG_MISSING", "Walrus aggregator is required");
  }
  async read(blobId: string): Promise<Uint8Array> {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(blobId)) fail("WALRUS_BLOB_INVALID", "Walrus blob ID is invalid");
    const response = await this.http(`${this.#aggregator.replace(/\/$/, "")}/v1/blobs/${encodeURIComponent(blobId)}`, { signal: AbortSignal.timeout(60_000), redirect: "error" });
    if (!response.ok) fail("WALRUS_READ_FAILED", `Walrus aggregator returned ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 1024 * 1024) fail("WALRUS_BLOB_TOO_LARGE", "deal blob exceeds 1 MiB");
    return bytes;
  }
  async publish(bytes: Uint8Array): Promise<{ blobId: string; ciphertextHash: string }> {
    if (!bytes.length || bytes.length > 1024 * 1024) fail("WALRUS_BLOB_INVALID", "deal blob must contain 1..1048576 bytes");
    const response = await this.http(`${this.#publisher.replace(/\/$/, "")}/v1/blobs?epochs=5`, { method: "PUT", body: Buffer.from(bytes), signal: AbortSignal.timeout(60_000), redirect: "error" });
    if (!response.ok) fail("WALRUS_PUBLISH_FAILED", `Walrus publisher returned ${response.status}`);
    const result = await response.json() as { newlyCreated?: { blobObject?: { blobId?: string } }; alreadyCertified?: { blobId?: string }; alreadyRegistered?: { blobId?: string } };
    const blobId = result.newlyCreated?.blobObject?.blobId ?? result.alreadyCertified?.blobId ?? result.alreadyRegistered?.blobId ?? fail("WALRUS_PUBLISH_FAILED", "Walrus publisher omitted blob ID");
    const fetched = await this.read(blobId);
    if (!Buffer.from(fetched).equals(Buffer.from(bytes))) fail("WALRUS_BLOB_MISMATCH", "deal blob failed Walrus readback");
    return { blobId, ciphertextHash: wireHash(bytes) };
  }
}
