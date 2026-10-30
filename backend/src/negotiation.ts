import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { fail } from "./errors.js";
import { RoleStore } from "./store.js";
import { MessageEnvelope, SignatureVerifier, hydrateTranscript, sha256 } from "./transcript.js";

export interface BlobTransport {
  put(id: string, ciphertext: string): Promise<string>;
  get(blobId: string): Promise<string>;
  resolve(id: string): Promise<string | undefined>;
}

export interface TranscriptManifestEntry extends Omit<MessageEnvelope, "ciphertext"> { blobId: string; }

function sessionKey(key: Uint8Array): Buffer {
  if (key.length !== 32) fail("SESSION_KEY_INVALID", "session key must contain 32 bytes");
  return Buffer.from(key);
}

export function encryptSessionMessage(key: Uint8Array, sessionId: string, id: string, plaintext: Uint8Array): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sessionKey(key), nonce);
  cipher.setAAD(Buffer.from(`${sessionId}:${id}`));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64");
}

export function decryptSessionMessage(key: Uint8Array, sessionId: string, id: string, encoded: string): Buffer {
  try {
    const value = Buffer.from(encoded, "base64");
    if (value.length < 29) fail("SESSION_CIPHERTEXT_INVALID", "session ciphertext is truncated");
    const decipher = createDecipheriv("aes-256-gcm", sessionKey(key), value.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${sessionId}:${id}`));
    decipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]);
  } catch (error) { return fail("SESSION_DECRYPT_FAILED", "participant could not authenticate the session message", error); }
}

/** Persists exact ciphertext before transport and makes uncertain uploads idempotent. */
export class DurableTranscriptTransport {
  constructor(private readonly store: RoleStore, private readonly blobs: BlobTransport) {}

  async upload(message: MessageEnvelope): Promise<TranscriptManifestEntry> {
    const ciphertextHash = sha256(Buffer.from(message.ciphertext, "base64"));
    if (ciphertextHash !== message.ciphertextHash) fail("CIPHERTEXT_TAMPERED", "message ciphertext hash does not match");
    this.store.prepareMessage({ id: message.id, sessionId: message.sessionId, sequence: message.sequence, ciphertextHash });
    this.store.putSecretOnce(`message:${message.id}`, Buffer.from(message.ciphertext));
    const prepared = this.store.getMessage(message.id)!;
    let blobId = prepared.blobId ?? await this.blobs.resolve(message.id);
    if (!blobId) blobId = await this.blobs.put(message.id, this.store.getSecret(`message:${message.id}`)!.toString());
    const remote = await this.blobs.get(blobId);
    if (sha256(Buffer.from(remote, "base64")) !== ciphertextHash) fail("WALRUS_BLOB_MISMATCH", "retrieved blob differs from durable ciphertext");
    this.store.attachMessageBlob(message.id, ciphertextHash, blobId);
    const { ciphertext: _ciphertext, ...metadata } = message;
    return { ...metadata, blobId };
  }

  async restart(manifest: TranscriptManifestEntry[], verify: SignatureVerifier, sessionId: string, participants: ReadonlySet<string>) {
    return hydrateTranscript(manifest, (blobId) => this.blobs.get(blobId), verify, { sessionId, participants });
  }
}

