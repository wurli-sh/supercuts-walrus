#!/usr/bin/env node
import { createCipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedClaude } from "./claude.js";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { isValidPersonalMessageSignature } from "@mysten/sui/verify";
import { validateCapabilityManifest, type CapabilityManifest } from "./capability.js";
import { fail, SupercutsError } from "./errors.js";
import { executeMandated, loadMandate } from "./mandate.js";
import { Phase3App } from "./phase3.js";
import { decryptSessionMessage, encryptSessionMessage } from "./negotiation.js";
import { SellerDatabase } from "./seller-database.js";
import { captureSellerHome, decryptSellerSnapshot, encryptSellerSnapshot, restoreSellerHome } from "./seller-state.js";
import { X402ResourceService } from "./x402-resource-service.js";

interface CatalogRow { seller_id: string; capability_id: string; manifest: CapabilityManifest; blob_id: string; signature: string; transport_public_key: string; preview: Record<string, unknown>; }
interface Quote { requestId: string; operationId: string; capabilityId: string; amount: string; artifactKey: string; runId: string; }
interface Slot { sellerId: string; home: string; app: Phase3App; artifacts: Record<string, string>; revision: number; resources: Map<string, X402ResourceService>; }

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const validId = (value: unknown, name: string): string => typeof value === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(value) ? value : fail("SELLER_REQUEST_INVALID", `${name} is invalid`);
const asObject = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail("SELLER_REQUEST_INVALID", "request must be an object");

export class SellerService {
  readonly #slots = new Map<string, Slot>();
  readonly #catalog = new Map<string, CatalogRow>();
  readonly #root = mkdtempSync(join(tmpdir(), "supercuts-sellers-"));
  readonly #claude: BoundedClaude;
  #queue: Promise<unknown> = Promise.resolve();
  #healthy = true;

  private constructor(private readonly db: SellerDatabase, private readonly snapshotKey: string, private readonly origin: string, private readonly facilitatorUrl: string, private readonly facilitatorKey: string, private readonly allowedBuyers: ReadonlySet<string>, claudeKey: string) {
    this.#claude = new BoundedClaude({ apiKey: claudeKey });
  }

  static async create(config: { db: SellerDatabase; snapshotKey: string; origin: string; facilitatorUrl: string; facilitatorKey: string; allowedBuyers: ReadonlySet<string>; claudeKey: string }): Promise<SellerService> {
    const service = new SellerService(config.db, config.snapshotKey, config.origin, config.facilitatorUrl, config.facilitatorKey, config.allowedBuyers, config.claudeKey);
    const rows = await config.db.listCatalog() as unknown as CatalogRow[];
    if (!rows.length) fail("SELLER_CATALOG_EMPTY", "provision seller capabilities before starting the service");
    for (const row of rows) {
      validateCapabilityManifest(row.manifest);
      if (row.manifest.capabilityId !== row.capability_id || row.manifest.sellerId !== row.seller_id || !row.blob_id || !row.signature || !row.transport_public_key) fail("SELLER_CATALOG_INVALID", "catalog entry does not match its manifest");
      service.#catalog.set(row.capability_id, row);
    }
    for (const sellerId of new Set(rows.map((row) => row.seller_id))) {
      const stored = await config.db.getSnapshot(sellerId) ?? fail("SELLER_STATE_MISSING", `snapshot is missing for ${sellerId}`);
      const snapshot = decryptSellerSnapshot(stored.payload, config.snapshotKey), home = join(service.#root, sha256(sellerId).slice(0, 16));
      restoreSellerHome(home, snapshot);
      const app = new Phase3App(home);
      if (app.profile.role !== "seller" || app.profile.mock) fail("LIVE_PROFILE_REQUIRED", "remote seller requires a live seller profile");
      app.store.db.exec("CREATE TABLE IF NOT EXISTS remote_quotes(request_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, capability_id TEXT NOT NULL, amount TEXT NOT NULL, artifact_key TEXT NOT NULL, run_id TEXT NOT NULL)");
      app.store.db.exec("CREATE TABLE IF NOT EXISTS remote_deliveries(session_id TEXT PRIMARY KEY, capability_id TEXT NOT NULL, artifact_key TEXT NOT NULL, delivery_public_key TEXT NOT NULL, run_id TEXT NOT NULL)");
      app.store.db.exec("CREATE TABLE IF NOT EXISTS remote_negotiations(session_id TEXT PRIMARY KEY, capability_id TEXT NOT NULL, buyer_address TEXT NOT NULL, buyer_public_key TEXT NOT NULL, request_ciphertext TEXT NOT NULL, reply_ciphertext TEXT NOT NULL, reply_signature TEXT NOT NULL, request_blob_id TEXT NOT NULL, reply_blob_id TEXT NOT NULL, transcript_hash TEXT NOT NULL, brief_hash TEXT, run_id TEXT NOT NULL)");
      const slot: Slot = { sellerId, home, app, artifacts: snapshot.artifacts, revision: stored.revision, resources: new Map() };
      service.#slots.set(sellerId, slot);
      for (const row of rows.filter((item) => item.seller_id === sellerId && item.manifest.supportedRails.includes("x402"))) {
        const resource = service.resource(slot, row);
        for (const quote of app.store.db.prepare("SELECT request_id AS requestId,operation_id AS operationId,capability_id AS capabilityId,amount,artifact_key AS artifactKey,run_id AS runId FROM remote_quotes WHERE capability_id=?").all(row.capability_id) as unknown as Quote[]) {
          if (quote.amount !== row.manifest.priceBand.minimum) fail("SELLER_QUOTE_INVALID", "stored quote price differs from the manifest");
          resource.register(quote.requestId, quote.operationId, service.artifact(slot, quote.artifactKey));
        }
      }
    }
    return service;
  }

  private artifact(slot: Slot, key: string): Buffer {
    const encoded = slot.artifacts[key] ?? fail("SELLER_ARTIFACT_MISSING", "prepared artifact is missing");
    const body = Buffer.from(encoded, "base64url");
    if (!body.length || body.length > 10 * 1024 * 1024) fail("SELLER_ARTIFACT_INVALID", "prepared artifact size is invalid");
    return body;
  }

  private resource(slot: Slot, row: CatalogRow): X402ResourceService {
    const found = slot.resources.get(row.capability_id); if (found) return found;
    const resource = new X402ResourceService(slot.app.store, {
      origin: this.origin,
      pathPrefix: `/resource/${encodeURIComponent(row.capability_id)}`,
      facilitatorUrl: this.facilitatorUrl,
      facilitatorKey: this.facilitatorKey,
      network: "sui:testnet",
      asset: row.manifest.asset,
      payTo: slot.sellerId,
      amount: row.manifest.priceBand.minimum,
    }, fetch, async () => { try { await this.persist(slot); } catch (error) { this.#healthy = false; throw error; } }, (digest, requestId) => this.db.claimPayment(digest, requestId, slot.sellerId));
    slot.resources.set(row.capability_id, resource);
    return resource;
  }

  private async persist(slot: Slot): Promise<void> {
    const snapshot = await captureSellerHome(slot.home, slot.sellerId, slot.artifacts);
    slot.revision = await this.db.putSnapshot(encryptSellerSnapshot(snapshot, this.snapshotKey), slot.revision);
  }

  private async publishCiphertext(slot: Slot, ciphertext: string): Promise<string> {
    const publisher = slot.app.profile.live?.walrusPublisherUrl ?? fail("LIVE_WALRUS_CONFIG_MISSING", "seller needs a Walrus publisher"), aggregator = slot.app.profile.live?.walrusAggregatorUrl ?? fail("LIVE_WALRUS_CONFIG_MISSING", "seller needs a Walrus aggregator");
    const body = Buffer.from(ciphertext, "base64"), put = await fetch(`${publisher.replace(/\/$/, "")}/v1/blobs?epochs=5`, { method: "PUT", body, signal: AbortSignal.timeout(60_000) });
    if (!put.ok) fail("WALRUS_PUBLISH_FAILED", `Walrus publisher returned ${put.status}`);
    const result = await put.json() as { newlyCreated?: { blobObject?: { blobId?: string } }; alreadyCertified?: { blobId?: string }; alreadyRegistered?: { blobId?: string } };
    const blobId = result.newlyCreated?.blobObject?.blobId ?? result.alreadyCertified?.blobId ?? result.alreadyRegistered?.blobId ?? fail("WALRUS_PUBLISH_FAILED", "Walrus publisher omitted blob ID");
    const read = await fetch(`${aggregator.replace(/\/$/, "")}/v1/blobs/${encodeURIComponent(blobId)}`, { signal: AbortSignal.timeout(60_000) });
    if (!read.ok || !Buffer.from(await read.arrayBuffer()).equals(body)) fail("WALRUS_BLOB_MISMATCH", "negotiation ciphertext did not round-trip through Walrus");
    return blobId;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(async () => {
      if (!this.#healthy) fail("SELLER_STATE_UNAVAILABLE", "seller service requires restart after a failed persistence operation");
      return operation();
    });
    this.#queue = result.catch(() => undefined);
    return result;
  }

  private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) { length += chunk.length; if (length > 128 * 1024) fail("SELLER_REQUEST_INVALID", "request body is too large"); chunks.push(chunk); }
    try { return asObject(JSON.parse(Buffer.concat(chunks).toString())); } catch (error) { return fail("SELLER_REQUEST_INVALID", "request body is not JSON", error); }
  }

  private reply(response: ServerResponse, status: number, data: unknown): void {
    const body = Buffer.from(JSON.stringify(data));
    response.writeHead(status, { "content-type": "application/json", "content-length": String(body.length), "cache-control": "no-store" }); response.end(body);
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", this.origin);
      if (request.method === "GET" && url.pathname === "/health") return this.reply(response, this.#healthy ? 200 : 503, { ok: this.#healthy, service: "supercuts-sellers" });
      if (request.method === "GET" && url.pathname === "/v1/catalog") return this.reply(response, 200, { capabilities: [...this.#catalog.values()].map(({ manifest, blob_id, signature, transport_public_key, preview }) => ({ manifest, blobId: blob_id, signature, transportPublicKey: transport_public_key, preview })) });
      if (request.method === "GET" && url.pathname === "/v1/events") {
        const runId = validId(url.searchParams.get("runId"), "runId");
        return this.reply(response, 200, { events: await this.db.listEvents(runId) });
      }
      if (request.method === "POST" && url.pathname === "/v1/negotiate") {
        const input = await this.body(request);
        return await this.serialize(async () => {
          const capabilityId = validId(input.capabilityId, "capabilityId"), row = this.#catalog.get(capabilityId) ?? fail("SELLER_CAPABILITY_UNKNOWN", "capability is unknown"), slot = this.#slots.get(row.seller_id)!;
          const sessionId = validId(input.sessionId, "sessionId"), runId = validId(input.runId, "runId"), buyerAddress = String(input.buyerAddress ?? ""), buyerPublicKey = String(input.buyerPublicKey ?? ""), ciphertext = String(input.ciphertext ?? ""), buyerSignature = String(input.buyerSignature ?? "");
          if (!/^0x[0-9a-f]{64}$/.test(buyerAddress) || buyerPublicKey.length > 1024 || ciphertext.length > 16384 || !ciphertext || !buyerSignature) fail("SELLER_REQUEST_INVALID", "buyer identity or encrypted offer is invalid");
          if (!this.allowedBuyers.has(buyerAddress)) fail("SELLER_BUYER_FORBIDDEN", "buyer is outside the seller service allowlist");
          const signedBytes = Buffer.from(`${sessionId}:${capabilityId}:${buyerPublicKey}:${sha256(Buffer.from(ciphertext, "base64"))}`);
          if (!(await isValidPersonalMessageSignature(signedBytes, buyerSignature, { address: buyerAddress }))) fail("SELLER_BUYER_SIGNATURE_INVALID", "buyer did not authorize this negotiation request");
          const prior = slot.app.store.db.prepare("SELECT capability_id AS capabilityId,buyer_address AS buyerAddress,buyer_public_key AS buyerPublicKey,request_ciphertext AS ciphertext,reply_ciphertext AS replyCiphertext,reply_signature AS replySignature,request_blob_id AS requestBlobId,reply_blob_id AS replyBlobId,transcript_hash AS transcriptHash,brief_hash AS briefHash,run_id AS runId FROM remote_negotiations WHERE session_id=?").get(sessionId) as Record<string, unknown> | undefined;
          if (prior) {
            if (prior.capabilityId !== capabilityId || prior.buyerAddress !== buyerAddress || prior.buyerPublicKey !== buyerPublicKey || prior.ciphertext !== ciphertext || prior.runId !== runId) fail("NEGOTIATION_SESSION_CONFLICT", "session already contains a different buyer offer");
            return this.reply(response, 200, { sessionId, capabilityId, ciphertext: prior.replyCiphertext, signature: prior.replySignature, requestBlobId: prior.requestBlobId, replyBlobId: prior.replyBlobId, transcriptHash: prior.transcriptHash });
          }
          const sellerPrivateDer = slot.app.store.getSecret("identity:x25519-private") ?? fail("IDENTITY_MISSING", "seller transport key is missing");
          const shared = diffieHellman({ privateKey: createPrivateKey({ key: sellerPrivateDer, format: "der", type: "pkcs8" }), publicKey: createPublicKey({ key: Buffer.from(buyerPublicKey, "base64url"), format: "der", type: "spki" }) });
          const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(sessionId), Buffer.from("supercuts-negotiation-v1"), 32));
          let offer: Record<string, unknown>; try { offer = asObject(JSON.parse(decryptSessionMessage(key, sessionId, `${sessionId}:buyer:1`, ciphertext).toString())); } catch (error) { return fail("NEGOTIATION_DECRYPT_FAILED", "seller could not read the buyer offer", error); }
          const opening = BigInt(String(offer.opening ?? "0")), maximum = BigInt(String(offer.maximum ?? "0")), minimum = BigInt(row.manifest.priceBand.minimum), briefHash = typeof offer.briefHash === "string" ? offer.briefHash : undefined;
          if (opening <= 0n || opening > maximum || maximum < minimum || maximum > BigInt(row.manifest.priceBand.maximum) || briefHash !== undefined && !/^[0-9a-f]{64}$/.test(briefHash)) fail("NEGOTIATION_BOUNDS_INVALID", "buyer offer exceeds approved price bounds");
          const task = String(offer.task ?? "").slice(0, 512);
          const decision = await this.#claude.decide<{ action: string }>({ system: "You are a bounded research seller. Present only the fixed price and service terms approved by Supercuts.", task, candidates: [{ action: "counteroffer", capabilityId, amount: minimum.toString() }], schema: { name: "respond_to_private_offer", description: "Present the approved exact price.", properties: { action: { type: "string", enum: ["counteroffer"] } }, required: ["action"] } });
          if (decision.action.action !== "counteroffer") fail("SELLER_DECISION_INVALID", "seller did not choose the approved response");
          const reply = { capabilityId, amount: minimum.toString(), asset: row.manifest.asset, railOptions: row.manifest.supportedRails, accepted: true };
          const replyCiphertext = encryptSessionMessage(key, sessionId, `${sessionId}:seller:2`, Buffer.from(JSON.stringify(reply)));
          const requestBlobId = await this.publishCiphertext(slot, ciphertext), replyBlobId = await this.publishCiphertext(slot, replyCiphertext);
          const transcriptHash = sha256(JSON.stringify({ request: sha256(Buffer.from(ciphertext, "base64")), reply: sha256(Buffer.from(replyCiphertext, "base64")) }));
          const encodedSigner = slot.app.store.getSecret("live:sui-private-key")?.toString() ?? fail("LIVE_CREDENTIAL_MISSING", "seller signing key is missing"), decoded = decodeSuiPrivateKey(encodedSigner);
          if (decoded.scheme !== "ED25519") fail("SIGNER_UNSUPPORTED", "seller requires an ED25519 signer");
          const signature = (await Ed25519Keypair.fromSecretKey(decoded.secretKey).signPersonalMessage(Buffer.from(`${sessionId}:${capabilityId}:${sha256(Buffer.from(replyCiphertext, "base64"))}:${transcriptHash}`))).signature;
          slot.app.store.db.prepare("INSERT INTO remote_negotiations(session_id,capability_id,buyer_address,buyer_public_key,request_ciphertext,reply_ciphertext,reply_signature,request_blob_id,reply_blob_id,transcript_hash,brief_hash,run_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(sessionId, capabilityId, buyerAddress, buyerPublicKey, ciphertext, replyCiphertext, signature, requestBlobId, replyBlobId, transcriptHash, briefHash ?? null, runId);
          try { await this.persist(slot); } catch (error) { this.#healthy = false; throw error; }
          await this.db.addEvent({ run_id: runId, seller_id: slot.sellerId, stage: "negotiation", status: "complete", details: { capabilityId, sessionId, requestBlobId, replyBlobId, transcriptHash, model: decision.model } });
          return this.reply(response, 200, { sessionId, capabilityId, ciphertext: replyCiphertext, signature, requestBlobId, replyBlobId, transcriptHash });
        });
      }
      if (request.method === "GET" && url.pathname.startsWith("/resource/")) {
        const capabilityId = decodeURIComponent(url.pathname.split("/")[2] ?? ""), row = this.#catalog.get(capabilityId) ?? fail("SELLER_CAPABILITY_UNKNOWN", "resource capability is unknown"), slot = this.#slots.get(row.seller_id)!;
        return await this.serialize(async () => this.resource(slot, row).handle(request, response));
      }
      if (request.method === "POST" && url.pathname === "/v1/quote") {
        const input = await this.body(request);
        return await this.serialize(async () => {
          const capabilityId = validId(input.capabilityId, "capabilityId"), row = this.#catalog.get(capabilityId) ?? fail("SELLER_CAPABILITY_UNKNOWN", "capability is unknown"), slot = this.#slots.get(row.seller_id)!;
          if (!row.manifest.supportedRails.includes("x402")) fail("SELLER_RAIL_UNSUPPORTED", "capability cannot quote x402");
          const requestId = validId(input.requestId, "requestId"), operationId = validId(input.operationId, "operationId"), runId = validId(input.runId, "runId");
          const negotiation = slot.app.store.db.prepare("SELECT capability_id AS capabilityId,run_id AS runId FROM remote_negotiations WHERE session_id=?").get(requestId) as { capabilityId: string; runId: string } | undefined;
          if (!negotiation || negotiation.capabilityId !== capabilityId || negotiation.runId !== runId) fail("NEGOTIATION_REQUIRED", "exact quote requires the matching encrypted negotiation");
          const briefHash = typeof input.briefHash === "string" ? input.briefHash : undefined;
          if (briefHash !== undefined && !/^[0-9a-f]{64}$/.test(briefHash)) fail("SELLER_REQUEST_INVALID", "brief hash is invalid");
          const quote: Quote = { requestId, operationId, capabilityId, amount: row.manifest.priceBand.minimum, artifactKey: briefHash ? `${capabilityId}:${briefHash}` : capabilityId, runId };
          const prior = slot.app.store.db.prepare("SELECT operation_id AS operationId,capability_id AS capabilityId,amount,artifact_key AS artifactKey,run_id AS runId FROM remote_quotes WHERE request_id=?").get(requestId) as Omit<Quote, "requestId"> | undefined;
          if (prior && JSON.stringify(prior) !== JSON.stringify({ operationId, capabilityId, amount: quote.amount, artifactKey: quote.artifactKey, runId })) fail("SELLER_QUOTE_CONFLICT", "request ID identifies another quote");
          const decision = await this.#claude.decide<{ action: string }>({ system: "You are a bounded seller agent. You may present only the fixed approved quote.", task: String(input.task ?? "Sui market brief").slice(0, 512), candidates: [{ action: "present_quote", capabilityId, amount: quote.amount }], schema: { name: "respond_to_buyer", description: "Present the approved exact price.", properties: { action: { type: "string", enum: ["present_quote"] } }, required: ["action"] } });
          if (decision.action.action !== "present_quote") fail("SELLER_DECISION_INVALID", "seller did not choose the approved quote");
          slot.app.store.db.prepare("INSERT OR IGNORE INTO remote_quotes(request_id,operation_id,capability_id,amount,artifact_key,run_id) VALUES(?,?,?,?,?,?)").run(requestId, operationId, capabilityId, quote.amount, quote.artifactKey, runId);
          const artifact = this.artifact(slot, quote.artifactKey), registration = this.resource(slot, row).register(requestId, operationId, artifact);
          try { await this.persist(slot); } catch (error) { this.#healthy = false; throw error; }
          await this.db.addEvent({ run_id: runId, seller_id: slot.sellerId, stage: "quote", status: "complete", details: { capabilityId, amount: quote.amount, model: decision.model } });
          return this.reply(response, 200, { capabilityId, sellerId: slot.sellerId, amount: quote.amount, asset: row.manifest.asset, requestId, operationId, resourceUrl: registration.url, artifactSha256: registration.artifactSha256 });
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/agreement") {
        const input = await this.body(request);
        return await this.serialize(async () => {
          const capabilityId = validId(input.capabilityId, "capabilityId"), row = this.#catalog.get(capabilityId) ?? fail("SELLER_CAPABILITY_UNKNOWN", "capability is unknown"), slot = this.#slots.get(row.seller_id)!;
          if (!row.manifest.supportedRails.includes("shielded")) fail("SELLER_RAIL_UNSUPPORTED", "capability cannot use shielded settlement");
          const sessionId = validId(input.sessionId, "sessionId"), runId = validId(input.runId, "runId"), briefHash = String(input.briefHash ?? ""), deliveryPublicKey = String(input.deliveryPublicKey ?? "");
          if (!/^[0-9a-f]{64}$/.test(briefHash) || deliveryPublicKey.length > 1024) fail("SELLER_REQUEST_INVALID", "brief hash or delivery key is invalid");
          const negotiation = slot.app.store.db.prepare("SELECT capability_id AS capabilityId,run_id AS runId,brief_hash AS briefHash,transcript_hash AS transcriptHash FROM remote_negotiations WHERE session_id=?").get(sessionId) as { capabilityId: string; runId: string; briefHash: string; transcriptHash: string } | undefined ?? fail("NEGOTIATION_REQUIRED", "agreement requires the matching encrypted negotiation");
          if (negotiation.capabilityId !== capabilityId || negotiation.runId !== runId || negotiation.briefHash !== briefHash) fail("NEGOTIATION_REQUIRED", "agreement requires the matching encrypted negotiation");
          const artifactKey = `${capabilityId}:${briefHash}`, artifact = this.artifact(slot, artifactKey), artifactSha256 = sha256(artifact);
          const encoded = String(input.agreement ?? ""), draft = asObject(JSON.parse(Buffer.from(encoded, "base64url").toString()));
          if (draft.counterparty !== slot.sellerId || draft.capabilityId !== capabilityId || draft.manifestHash !== row.manifest.manifestHash || draft.paymentAmount !== row.manifest.priceBand.minimum) fail("AGREEMENT_BINDING_MISMATCH", "draft does not match the seller offer");
          if (draft.transcriptRootLo !== BigInt(`0x${negotiation.transcriptHash.slice(0, 32)}`).toString() || draft.transcriptRootHi !== BigInt(`0x${negotiation.transcriptHash.slice(32)}`).toString()) fail("AGREEMENT_BINDING_MISMATCH", "draft does not bind the encrypted negotiation transcript");
          const expected = sha256(JSON.stringify({ capabilityId, briefHash, artifactSha256, deliveryPublicKey }));
          if (draft.serviceDigestLo !== BigInt(`0x${expected.slice(0, 32)}`).toString() || draft.serviceDigestHi !== BigInt(`0x${expected.slice(32)}`).toString()) fail("AGREEMENT_BINDING_MISMATCH", "draft does not bind the prepared analysis and buyer delivery key");
          const prior = slot.app.store.db.prepare("SELECT capability_id AS capabilityId,artifact_key AS artifactKey,delivery_public_key AS deliveryPublicKey,run_id AS runId FROM remote_deliveries WHERE session_id=?").get(sessionId) as Record<string, unknown> | undefined;
          if (prior && JSON.stringify(prior) !== JSON.stringify({ capabilityId, artifactKey, deliveryPublicKey, runId })) fail("AGREEMENT_SESSION_CONFLICT", "session identifies another delivery");
          const decision = await this.#claude.decide<{ action: string }>({ system: "You are a bounded seller agent. Sign only the backend-verified agreement.", task: `Respond to accepted competitor analysis request for ${capabilityId}.`, candidates: [{ action: "sign_approved_agreement", capabilityId }], schema: { name: "respond_to_private_offer", description: "Approve the backend-verified agreement.", properties: { action: { type: "string", enum: ["sign_approved_agreement"] } }, required: ["action"] } });
          if (decision.action.action !== "sign_approved_agreement") fail("SELLER_DECISION_INVALID", "seller did not choose the approved agreement");
          const signed = await executeMandated(slot.app, loadMandate(slot.home), "offer.counter", { "operation-id": `remote-counter-${sessionId}`, session: sessionId, agreement: encoded });
          slot.app.store.db.prepare("INSERT OR IGNORE INTO remote_deliveries(session_id,capability_id,artifact_key,delivery_public_key,run_id) VALUES(?,?,?,?,?)").run(sessionId, capabilityId, artifactKey, deliveryPublicKey, runId);
          try { await this.persist(slot); } catch (error) { this.#healthy = false; throw error; }
          await this.db.addEvent({ run_id: runId, seller_id: slot.sellerId, stage: "agreement", status: "complete", details: { capabilityId, sessionId, model: decision.model, dealCommitment: signed.dealCommitment } });
          return this.reply(response, 200, { sessionId, capabilityId, agreement: signed.agreement, dealCommitment: signed.dealCommitment, artifactSha256 });
        });
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/delivery/")) {
        const sessionId = validId(decodeURIComponent(url.pathname.slice("/v1/delivery/".length)), "sessionId");
        return await this.serialize(async () => {
          const slot = [...this.#slots.values()].find((item) => item.app.store.db.prepare("SELECT 1 FROM remote_deliveries WHERE session_id=?").get(sessionId)) ?? fail("DELIVERY_NOT_FOUND", "delivery session is unknown");
          const row = slot.app.store.db.prepare("SELECT capability_id AS capabilityId,artifact_key AS artifactKey,delivery_public_key AS deliveryPublicKey,run_id AS runId FROM remote_deliveries WHERE session_id=?").get(sessionId) as { capabilityId: string; artifactKey: string; deliveryPublicKey: string; runId: string };
          await executeMandated(slot.app, loadMandate(slot.home), "wallet.recover", { "operation-id": `remote-recover-${sessionId}` });
          const note = slot.app.store.db.prepare("SELECT commitment FROM notes WHERE operation_id=? AND role='payment'").get(sessionId) as { commitment: string } | undefined;
          if (!note) return this.reply(response, 202, { status: "payment-pending", sessionId });
          const artifact = this.artifact(slot, row.artifactKey);
          const recipient = createPublicKey({ key: Buffer.from(row.deliveryPublicKey, "base64url"), format: "der", type: "spki" });
          const ephemeral = generateKeyPairSync("x25519");
          const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
          const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(sessionId), Buffer.from("supercuts-delivery-v1"), 32));
          const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
          cipher.setAAD(Buffer.from(`${sessionId}:${row.capabilityId}:${sha256(artifact)}`));
          const ciphertext = Buffer.concat([cipher.update(artifact), cipher.final()]);
          try { await this.persist(slot); } catch (error) { this.#healthy = false; throw error; }
          await this.db.addEvent({ run_id: row.runId, seller_id: slot.sellerId, stage: "delivery", status: "complete", details: { capabilityId: row.capabilityId, sessionId, artifactSha256: sha256(artifact), paymentNoteCommitment: note.commitment } });
          return this.reply(response, 200, { status: "delivered", sessionId, capabilityId: row.capabilityId, artifactSha256: sha256(artifact), ephemeralPublicKey: ephemeral.publicKey.export({ type: "spki", format: "der" }).toString("base64url"), nonce: nonce.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") });
        });
      }
      return this.reply(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      const known = error instanceof SupercutsError ? error : new SupercutsError("SELLER_INTERNAL_ERROR", "seller request failed");
      if (!response.headersSent) this.reply(response, known.code === "SELLER_STATE_UNAVAILABLE" ? 503 : 400, { error: known.code, message: known.message });
    }
  }

  createServer() { return createServer((request, response) => { void this.handle(request, response); }); }
  close(): void { for (const slot of this.#slots.values()) slot.app.close(); rmSync(this.#root, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  const required = (key: string) => process.env[key] ?? fail("SELLER_CONFIG_MISSING", `${key} is required`);
  const port = Number(process.env.PORT ?? "3000");
  const origin = required("SELLER_ORIGIN");
  SellerService.create({ db: new SellerDatabase(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY")), snapshotKey: required("SELLER_STATE_KEY"), origin, facilitatorUrl: required("FACILITATOR_URL"), facilitatorKey: required("FACILITATOR_SHARED_KEY"), allowedBuyers: new Set(required("SELLER_ALLOWED_BUYERS").split(",")), claudeKey: required("CLAUDE_API_KEY") })
    .then((service) => { const server = service.createServer(); server.listen(port, "0.0.0.0"); const close = () => server.close(() => { service.close(); process.exit(0); }); process.on("SIGINT", close); process.on("SIGTERM", close); })
    .catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "seller service failed"}\n`); process.exitCode = 1; });
}
