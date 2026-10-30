import { createHash } from "node:crypto";
import { fail } from "./errors.js";

export type MessageType = "offer" | "counteroffer" | "accept" | "recovery" | "cancel";
export interface MessageEnvelope {
  id: string;
  sessionId: string;
  revision: number;
  sequence: number;
  parentHash: string | null;
  author: string;
  type: MessageType;
  expiresAt: number;
  ciphertext: string;
  ciphertextHash: string;
  signature: string;
}
export type SignatureVerifier = (author: string, bytes: Uint8Array, signature: string) => Promise<boolean>;
export type CiphertextLoader = (blobId: string) => Promise<string>;

export function canonicalEnvelope(envelope: Omit<MessageEnvelope, "signature">): Uint8Array {
  return Buffer.from(JSON.stringify({
    id: envelope.id, sessionId: envelope.sessionId, revision: envelope.revision, sequence: envelope.sequence,
    parentHash: envelope.parentHash, author: envelope.author, type: envelope.type, expiresAt: envelope.expiresAt,
    ciphertextHash: envelope.ciphertextHash,
  }));
}
export function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

export async function validateTranscript(messages: MessageEnvelope[], verify: SignatureVerifier, now = Date.now()): Promise<string> {
  if (!messages.length) fail("TRANSCRIPT_EMPTY", "a settlement transcript cannot be empty");
  const ordered = [...messages].sort((a, b) => a.sequence - b.sequence);
  let previous: string | null = null;
  const seen = new Set<string>();
  for (let position = 0; position < ordered.length; position++) {
    const message = ordered[position]!;
    if (message.sequence !== position || seen.has(message.id)) fail("TRANSCRIPT_ORDER_INVALID", "transcript has a gap, duplicate, or replay");
    if (message.parentHash !== previous) fail("TRANSCRIPT_FORK", "transcript parent hash does not match its predecessor");
    if (message.expiresAt < now && message.type !== "cancel") fail("OFFER_EXPIRED", "transcript contains an expired message");
    if (sha256(Buffer.from(message.ciphertext, "base64")) !== message.ciphertextHash) fail("CIPHERTEXT_TAMPERED", "ciphertext hash does not match");
    if (!(await verify(message.author, canonicalEnvelope(message), message.signature))) fail("MESSAGE_SIGNATURE_INVALID", "message signature is invalid");
    previous = sha256(Buffer.concat([canonicalEnvelope(message), Buffer.from(message.signature)]));
    seen.add(message.id);
  }
  return previous!;
}

export async function hydrateTranscript(
  manifest: Array<Omit<MessageEnvelope, "ciphertext"> & { blobId: string }>, load: CiphertextLoader, verify: SignatureVerifier,
): Promise<{ messages: MessageEnvelope[]; root: string }> {
  const messages = await Promise.all(manifest.map(async ({ blobId, ...message }) => ({ ...message, ciphertext: await load(blobId) })));
  return { messages, root: await validateTranscript(messages, verify) };
}
