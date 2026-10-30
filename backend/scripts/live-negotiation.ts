import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { isValidPersonalMessageSignature } from "@mysten/sui/verify";
import {
  BlobTransport, canonicalEnvelope, decryptSessionMessage, DurableTranscriptTransport,
  encryptSessionMessage, MessageEnvelope, RoleStore, sha256, TranscriptManifestEntry,
} from "../src/index.js";

const publisher = process.env.WALRUS_PUBLISHER_URL ?? "https://publisher.walrus-testnet.walrus.space";
const aggregator = process.env.WALRUS_AGGREGATOR_URL ?? "https://aggregator.walrus-testnet.walrus.space";

class WalrusHttp implements BlobTransport {
  private readonly ids = new Map<string, string>();
  async put(id: string, ciphertext: string): Promise<string> {
    const response = await fetch(`${publisher}/v1/blobs?epochs=5`, { method: "PUT", body: ciphertext });
    if (!response.ok) throw new Error(`Walrus publisher failed: HTTP ${response.status} ${await response.text()}`);
    const result = await response.json() as { newlyCreated?: { blobObject?: { blobId?: string } }; alreadyCertified?: { blobId?: string }; alreadyRegistered?: { blobId?: string } };
    const blobId = result.newlyCreated?.blobObject?.blobId ?? result.alreadyCertified?.blobId ?? result.alreadyRegistered?.blobId;
    if (!blobId) throw new Error(`Walrus publisher response has no blob ID: ${JSON.stringify(result)}`);
    this.ids.set(id, blobId); return blobId;
  }
  async get(blobId: string): Promise<string> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await fetch(`${aggregator}/v1/blobs/${encodeURIComponent(blobId)}`);
      if (response.ok) return response.text();
      if (response.status !== 404) throw new Error(`Walrus aggregator failed: HTTP ${response.status}`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`Walrus blob ${blobId} did not propagate`);
  }
  async resolve(id: string) { return this.ids.get(id); }
}

const directory = mkdtempSync(join(tmpdir(), "supercuts-live-negotiation-"));
const path = join(directory, "buyer.sqlite"); const stateKey = randomBytes(32);
const buyer = new Ed25519Keypair(); const sellers = [new Ed25519Keypair(), new Ed25519Keypair(), new Ed25519Keypair()];
const addresses = new Set([buyer.toSuiAddress(), ...sellers.map((seller) => seller.toSuiAddress())]);
const verify = (author: string, bytes: Uint8Array, signature: string) => isValidPersonalMessageSignature(bytes, signature, { address: author });
const blobs = new WalrusHttp();

async function signedMessage(keypair: Ed25519Keypair, sessionKey: Buffer, sessionId: string, sequence: number, parentHash: string | null, payload: object, type: "offer" | "accept"): Promise<MessageEnvelope> {
  const id = `${sessionId}-${sequence}`; const ciphertext = encryptSessionMessage(sessionKey, sessionId, id, Buffer.from(JSON.stringify(payload)));
  const unsigned = { id, sessionId, revision: 1, sequence, parentHash, author: keypair.toSuiAddress(), type, expiresAt: Date.now() + 3_600_000, ciphertext, ciphertextHash: sha256(Buffer.from(ciphertext, "base64")) };
  const { signature } = await keypair.signPersonalMessage(canonicalEnvelope(unsigned));
  return { ...unsigned, signature };
}

try {
  let store = new RoleStore(path, stateKey); let transport = new DurableTranscriptTransport(store, blobs);
  const sessions: Array<{ sessionId: string; key: Buffer; manifest: TranscriptManifestEntry[]; seller: string; price: number }> = [];
  for (let index = 0; index < sellers.length; index++) {
    const seller = sellers[index]!; const price = [12, 9, 15][index]!; const sessionId = `phase2-${randomBytes(12).toString("hex")}`; const key = randomBytes(32);
    const offer = await signedMessage(seller, key, sessionId, 0, null, { price, seller: seller.toSuiAddress() }, "offer");
    const offerManifest = await transport.upload(offer);
    const parentHash = sha256(Buffer.concat([canonicalEnvelope(offer), Buffer.from(offer.signature)]));
    const accept = await signedMessage(buyer, key, sessionId, 1, parentHash, { selected: price === 9 }, "accept");
    sessions.push({ sessionId, key, seller: seller.toSuiAddress(), price, manifest: [offerManifest, await transport.upload(accept)] });
  }
  store.close();

  store = new RoleStore(path, stateKey); transport = new DurableTranscriptTransport(store, blobs);
  const evidence = [];
  for (const session of sessions) {
    const hydrated = await transport.restart(session.manifest, verify, session.sessionId, new Set([buyer.toSuiAddress(), session.seller]));
    const offer = JSON.parse(decryptSessionMessage(session.key, session.sessionId, hydrated.messages[0]!.id, hydrated.messages[0]!.ciphertext).toString()) as { price: number };
    if (offer.price !== session.price) throw new Error("fresh-process transcript reconstruction changed the offer");
    evidence.push({ sessionHash: sha256(session.sessionId), seller: session.seller, selected: session.price === 9, transcriptRoot: hydrated.root, blobIds: session.manifest.map((message) => message.blobId) });
  }
  let unrelatedCannotDecrypt = false;
  try {
    const session = sessions[0]!; const ciphertext = await blobs.get(session.manifest[0]!.blobId);
    decryptSessionMessage(randomBytes(32), session.sessionId, session.manifest[0]!.id, ciphertext);
  } catch { unrelatedCannotDecrypt = true; }
  if (!unrelatedCannotDecrypt) throw new Error("unrelated participant decrypted a transcript");
  console.log(JSON.stringify({ network: "walrus-testnet", publisher, aggregator, sessions: evidence, selectedSellerCount: evidence.filter((item) => item.selected).length, unrelatedCannotDecrypt }, null, 2));
  store.close();
} finally { rmSync(directory, { recursive: true, force: true }); }
