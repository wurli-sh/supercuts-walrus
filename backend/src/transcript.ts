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
export interface TranscriptConstraints { sessionId?: string; participants?: ReadonlySet<string>; now?: number; allowExpired?: boolean; }
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

export async function validateTranscript(messages: MessageEnvelope[], verify: SignatureVerifier, constraints: number | TranscriptConstraints = {}): Promise<string> {
  if (!messages.length) fail("TRANSCRIPT_EMPTY", "a settlement transcript cannot be empty");
  const options = typeof constraints === "number" ? { now: constraints } : constraints;
  const now = options.now ?? Date.now();
  const sessionId = options.sessionId ?? messages[0]!.sessionId;
  let previous: string | null = null;
  const seen = new Set<string>();
  let revision = 0;
  for (let position = 0; position < messages.length; position++) {
    const message = messages[position]!;
    if (!message.id || message.id.length > 256 || !message.sessionId || message.sessionId.length > 256 || !message.author || message.author.length > 256 || !Number.isSafeInteger(message.sequence) || !Number.isSafeInteger(message.expiresAt) || message.ciphertext.length > 2_000_000) fail("TRANSCRIPT_MESSAGE_INVALID", "transcript message fields are invalid or too large");
    if (!(["offer", "counteroffer", "accept", "recovery", "cancel"] as string[]).includes(message.type)) fail("TRANSCRIPT_MESSAGE_INVALID", "transcript message type is invalid");
    if (message.sequence !== position || seen.has(message.id)) fail("TRANSCRIPT_ORDER_INVALID", "transcript has a gap, duplicate, or replay");
    if (message.sessionId !== sessionId) fail("TRANSCRIPT_SESSION_MISMATCH", "message belongs to another session");
    if (options.participants && !options.participants.has(message.author)) fail("TRANSCRIPT_PEER_MISMATCH", "message author is not a session participant");
    if (!Number.isSafeInteger(message.revision) || message.revision < 1 || message.revision < revision || message.revision > revision + 1) fail("TRANSCRIPT_REVISION_INVALID", "message revision is not monotonic");
    if (message.parentHash !== previous) fail("TRANSCRIPT_FORK", "transcript parent hash does not match its predecessor");
    if (!options.allowExpired && message.expiresAt < now && message.type !== "cancel") fail("OFFER_EXPIRED", "transcript contains an expired message");
    const ciphertext = Buffer.from(message.ciphertext, "base64");
    if (ciphertext.toString("base64") !== message.ciphertext || sha256(ciphertext) !== message.ciphertextHash) fail("CIPHERTEXT_TAMPERED", "ciphertext encoding or hash does not match");
    if (!(await verify(message.author, canonicalEnvelope(message), message.signature))) fail("MESSAGE_SIGNATURE_INVALID", "message signature is invalid");
    previous = sha256(Buffer.concat([canonicalEnvelope(message), Buffer.from(message.signature)]));
    revision = message.revision;
    seen.add(message.id);
  }
  return previous!;
}

export async function hydrateTranscript(
  manifest: Array<Omit<MessageEnvelope, "ciphertext"> & { blobId: string }>, load: CiphertextLoader, verify: SignatureVerifier,
  constraints: number | TranscriptConstraints = {},
): Promise<{ messages: MessageEnvelope[]; root: string }> {
  const messages = await Promise.all(manifest.map(async ({ blobId, ...message }) => ({ ...message, ciphertext: await load(blobId) })));
  return { messages, root: await validateTranscript(messages, verify, constraints) };
}
