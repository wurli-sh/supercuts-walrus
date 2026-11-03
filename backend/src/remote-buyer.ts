import { createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes } from "node:crypto";
import { isValidPersonalMessageSignature } from "@mysten/sui/verify";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { validateCapabilityManifest, verifySignedCapability, type CapabilityManifest } from "./capability.js";
import { fail } from "./errors.js";
import { executeMandated, type AgentMandate } from "./mandate.js";
import type { Phase3App } from "./phase3.js";
import { decryptSessionMessage, encryptSessionMessage } from "./negotiation.js";

interface Entry { manifest: CapabilityManifest; blobId: string; signature: string; transportPublicKey: string; preview: Record<string, unknown>; }
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const num = (value: unknown, name: string) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fail("SELLER_PREVIEW_INVALID", `${name} must be between zero and one`);
const halves = (content: string): [string, string] => { const hash = sha256(content); return [BigInt(`0x${hash.slice(0, 32)}`).toString(), BigInt(`0x${hash.slice(32)}`).toString()]; };

export class RemoteBuyer {
  readonly #origin: URL;
  constructor(private readonly app: Phase3App, private readonly mandate: AgentMandate, origin: string, private readonly http: typeof fetch = fetch) {
    this.#origin = new URL(origin);
    if (this.#origin.protocol !== "https:" && !(this.#origin.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(this.#origin.hostname))) fail("SELLER_ORIGIN_INVALID", "seller origin must use HTTPS except on loopback");
  }

  private async request(path: string, init: RequestInit = {}): Promise<Record<string, any>> {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { response = await this.http(new URL(path, this.#origin), { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) }, signal: init.signal ?? AbortSignal.timeout(90_000), redirect: "error" }); }
      catch (error) { if (attempt === 0) continue; return fail("REMOTE_SELLER_UNAVAILABLE", "seller transport failed after retry", error); }
      if (response.status !== 503 || attempt === 1) break;
      await response.arrayBuffer(); await new Promise((done) => setTimeout(done, 3000));
    }
    const received = response ?? fail("REMOTE_SELLER_UNAVAILABLE", "seller did not respond");
    const value = await received.json() as Record<string, any>;
    if (!received.ok && received.status !== 202) fail("REMOTE_SELLER_ERROR", `seller returned ${received.status}: ${String(value.error ?? "unknown error")}`);
    return value;
  }

  async catalog(): Promise<{ capabilities: Entry[] }> {
    const listed = await this.request("/v1/catalog"), entries = listed.capabilities as Entry[];
    if (!Array.isArray(entries) || !entries.length || entries.length > 100) fail("SELLER_CATALOG_INVALID", "remote catalog is empty or too large");
    const discovered = (await this.app.execute("capability.discover", { "blob-ids": Buffer.from(JSON.stringify(entries.map((entry) => entry.blobId))).toString("base64url") })).data.capabilities as Array<CapabilityManifest & { blobId: string }>;
    if (discovered.length !== entries.length) fail("SELLER_CATALOG_INVALID", "Walrus discovery returned a different capability count");
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!; validateCapabilityManifest(entry.manifest);
      if (entry.manifest.manifestHash !== discovered[i]!.manifestHash || entry.blobId !== discovered[i]!.blobId || !this.mandate.allowedCounterparties.includes(entry.manifest.sellerId)) fail("SELLER_CATALOG_INVALID", "catalog differs from Walrus or owner allowlist");
      await verifySignedCapability({ manifest: entry.manifest, manifestBlobId: entry.blobId, transportPublicKey: entry.transportPublicKey, sellerSignature: entry.signature });
    }
    return { capabilities: entries };
  }

  async rankBriefs(input: { budget: string; topic: string }): Promise<Record<string, unknown>> {
    if (!/^[1-9][0-9]*$/.test(input.budget)) fail("BUYER_BUDGET_INVALID", "budget must be positive MIST");
    const budget = BigInt(input.budget), catalog = await this.catalog();
    const analysis = catalog.capabilities.find((entry) => entry.manifest.capability === "sui.competitor-analysis" && entry.manifest.supportedRails.includes("shielded")) ?? fail("ANALYSIS_UNAVAILABLE", "no shielded competitor analysis is available");
    const analysisPrice = BigInt(analysis.manifest.priceBand.minimum), variants = analysis.preview.artifactHashes as Record<string, string> | undefined;
    const candidates = catalog.capabilities.filter((entry) => {
      const briefHash = (entry.preview.artifactHashes as Record<string, string> | undefined)?.default;
      return entry.manifest.capability === "sui.market-brief" && entry.manifest.supportedRails.includes("x402") && typeof briefHash === "string" && /^[0-9a-f]{64}$/.test(briefHash) && typeof variants?.[briefHash] === "string" && BigInt(entry.manifest.priceBand.minimum) + analysisPrice <= budget;
    });
    if (candidates.length < 2) fail("BRIEF_COMPARISON_UNAVAILABLE", "at least two eligible market briefs are required");
    const scored = candidates.map((entry) => {
      const preview = entry.preview, relevance = num(preview.relevance, "relevance"), sourceQuality = num(preview.sourceQuality, "sourceQuality"), freshnessDays = Number(preview.freshnessDays);
      if (!Number.isFinite(freshnessDays) || freshnessDays < 0 || freshnessDays > 365) fail("SELLER_PREVIEW_INVALID", "freshnessDays is invalid");
      const freshness = Math.max(0, 1 - freshnessDays / 30), price = BigInt(entry.manifest.priceBand.minimum), totalPrice = price + analysisPrice, priceScore = Number((budget - totalPrice) * 1000n / budget) / 1000;
      const score = Math.round((0.35 * relevance + 0.30 * sourceQuality + 0.20 * freshness + 0.15 * priceScore) * 1000) / 1000;
      return { capabilityId: entry.manifest.capabilityId, sellerId: entry.manifest.sellerId, priceMist: price.toString(), projectedTotalMist: totalPrice.toString(), score, components: { relevance, sourceQuality, freshness, price: priceScore }, preview: { title: preview.title, summary: preview.summary, citations: preview.citations, freshnessDays }, manifestHash: entry.manifest.manifestHash };
    }).sort((a, b) => b.score - a.score || (BigInt(a.priceMist) < BigInt(b.priceMist) ? -1 : BigInt(a.priceMist) > BigInt(b.priceMist) ? 1 : a.capabilityId.localeCompare(b.capabilityId)));
    return { topic: input.topic, budgetMist: input.budget, analysisCapabilityId: analysis.manifest.capabilityId, analysisPriceMist: analysisPrice.toString(), rubric: { relevance: 0.35, sourceQuality: 0.30, freshness: 0.20, price: 0.15 }, rankings: scored, winner: scored[0], note: "Preview quality fields are seller supplied; the buyer checks artifact citations after delivery." };
  }

  async negotiate(input: { capabilityId: string; sessionId: string; runId: string; task: string; opening: string; maximum: string; briefHash?: string }): Promise<Record<string, unknown>> {
    const catalog = await this.catalog(), entry = catalog.capabilities.find((item) => item.manifest.capabilityId === input.capabilityId) ?? fail("SELLER_CAPABILITY_UNKNOWN", "capability is not in the verified catalog");
    if (!/^[1-9][0-9]*$/.test(input.opening) || !/^[1-9][0-9]*$/.test(input.maximum) || BigInt(input.opening) > BigInt(input.maximum) || BigInt(input.maximum) < BigInt(entry.manifest.priceBand.minimum) || BigInt(input.maximum) > BigInt(entry.manifest.priceBand.maximum)) fail("NEGOTIATION_BOUNDS_INVALID", "offer bounds are outside the seller price band");
    if (input.briefHash !== undefined && !/^[0-9a-f]{64}$/.test(input.briefHash)) fail("BUYER_BRIEF_HASH_INVALID", "brief hash is invalid");
    const privateDer = this.app.store.getSecret("identity:x25519-private") ?? fail("IDENTITY_MISSING", "buyer negotiation key is missing"), publicKey = this.app.store.getSecret("identity:x25519-public")?.toString("base64url") ?? fail("IDENTITY_MISSING", "buyer negotiation key is missing");
    const shared = diffieHellman({ privateKey: createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" }), publicKey: createPublicKey({ key: Buffer.from(entry.transportPublicKey, "base64url"), format: "der", type: "spki" }) });
    const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(input.sessionId), Buffer.from("supercuts-negotiation-v1"), 32));
    this.app.store.db.exec("CREATE TABLE IF NOT EXISTS remote_buyer_negotiations(session_id TEXT PRIMARY KEY, capability_id TEXT NOT NULL, run_id TEXT NOT NULL, offer_hash TEXT NOT NULL, request_ciphertext TEXT NOT NULL, buyer_signature TEXT NOT NULL, reply_json TEXT)");
    const offer = { task: input.task.slice(0, 512), opening: input.opening, maximum: input.maximum, ...(input.briefHash ? { briefHash: input.briefHash } : {}) }, offerHash = sha256(JSON.stringify(offer));
    const existing = this.app.store.db.prepare("SELECT capability_id AS capabilityId,run_id AS runId,offer_hash AS offerHash,request_ciphertext AS ciphertext,buyer_signature AS buyerSignature,reply_json AS replyJson FROM remote_buyer_negotiations WHERE session_id=?").get(input.sessionId) as { capabilityId: string; runId: string; offerHash: string; ciphertext: string; buyerSignature: string; replyJson: string | null } | undefined;
    if (existing && (existing.capabilityId !== input.capabilityId || existing.runId !== input.runId || existing.offerHash !== offerHash)) fail("NEGOTIATION_SESSION_CONFLICT", "session belongs to another offer or run");
    const encrypted = existing?.ciphertext ?? encryptSessionMessage(key, input.sessionId, `${input.sessionId}:buyer:1`, Buffer.from(JSON.stringify(offer)));
    const encodedSigner = this.app.store.getSecret("live:sui-private-key")?.toString() ?? fail("LIVE_CREDENTIAL_MISSING", "buyer signing key is missing"), decoded = decodeSuiPrivateKey(encodedSigner);
    if (decoded.scheme !== "ED25519") fail("SIGNER_UNSUPPORTED", "buyer requires an ED25519 signer");
    const signer = Ed25519Keypair.fromSecretKey(decoded.secretKey), signedBytes = Buffer.from(`${input.sessionId}:${input.capabilityId}:${publicKey}:${sha256(Buffer.from(encrypted, "base64"))}`);
    const buyerSignature = existing?.buyerSignature ?? (await signer.signPersonalMessage(signedBytes)).signature;
    if (!existing) this.app.store.db.prepare("INSERT INTO remote_buyer_negotiations(session_id,capability_id,run_id,offer_hash,request_ciphertext,buyer_signature) VALUES(?,?,?,?,?,?)").run(input.sessionId, input.capabilityId, input.runId, offerHash, encrypted, buyerSignature);
    const result = existing?.replyJson ? JSON.parse(existing.replyJson) as Record<string, any> : await this.request("/v1/negotiate", { method: "POST", body: JSON.stringify({ capabilityId: input.capabilityId, sessionId: input.sessionId, runId: input.runId, buyerAddress: signer.toSuiAddress(), buyerPublicKey: publicKey, buyerSignature, ciphertext: encrypted }) });
    const replyCiphertext = String(result.ciphertext ?? ""), transcriptHash = sha256(JSON.stringify({ request: sha256(Buffer.from(encrypted, "base64")), reply: sha256(Buffer.from(replyCiphertext, "base64")) }));
    if (result.sessionId !== input.sessionId || result.capabilityId !== input.capabilityId || result.transcriptHash !== transcriptHash || !(await isValidPersonalMessageSignature(Buffer.from(`${input.sessionId}:${input.capabilityId}:${sha256(Buffer.from(replyCiphertext, "base64"))}:${transcriptHash}`), String(result.signature), { address: entry.manifest.sellerId }))) fail("NEGOTIATION_RESPONSE_INVALID", "seller response or signature is invalid");
    const aggregator = this.app.profile.live?.walrusAggregatorUrl ?? fail("LIVE_WALRUS_CONFIG_MISSING", "buyer needs a Walrus aggregator");
    for (const [blobId, ciphertext] of [[result.requestBlobId, encrypted], [result.replyBlobId, replyCiphertext]] as const) {
      const read = await this.http(`${aggregator.replace(/\/$/, "")}/v1/blobs/${encodeURIComponent(String(blobId))}`, { signal: AbortSignal.timeout(60_000) });
      if (!read.ok || !Buffer.from(await read.arrayBuffer()).equals(Buffer.from(ciphertext, "base64"))) fail("WALRUS_BLOB_MISMATCH", "encrypted offer or response differs from Walrus");
    }
    const response = JSON.parse(decryptSessionMessage(key, input.sessionId, `${input.sessionId}:seller:2`, replyCiphertext).toString()) as { capabilityId: string; amount: string; asset: string; accepted: boolean };
    if (response.capabilityId !== input.capabilityId || response.asset !== entry.manifest.asset || response.amount !== entry.manifest.priceBand.minimum || response.accepted !== true) fail("NEGOTIATION_RESPONSE_INVALID", "seller response changed the approved price or capability");
    if (!existing?.replyJson) this.app.store.db.prepare("UPDATE remote_buyer_negotiations SET reply_json=? WHERE session_id=?").run(JSON.stringify(result), input.sessionId);
    return { sessionId: input.sessionId, capabilityId: input.capabilityId, sellerId: entry.manifest.sellerId, opening: input.opening, amount: response.amount, asset: response.asset, accepted: true, transcriptHash, requestBlobId: result.requestBlobId, replyBlobId: result.replyBlobId };
  }

  async quote(input: { capabilityId: string; operationId: string; requestId: string; runId: string; task: string; briefHash?: string }): Promise<Record<string, unknown>> {
    const catalog = await this.catalog(), entry = catalog.capabilities.find((item) => item.manifest.capabilityId === input.capabilityId) ?? fail("SELLER_CAPABILITY_UNKNOWN", "capability is not in the verified catalog");
    if (!entry.manifest.supportedRails.includes("x402")) fail("SELLER_RAIL_UNSUPPORTED", "capability does not support public settlement");
    const quote = await this.request("/v1/quote", { method: "POST", body: JSON.stringify(input) });
    if (quote.capabilityId !== entry.manifest.capabilityId || quote.sellerId !== entry.manifest.sellerId || quote.asset !== entry.manifest.asset || quote.amount !== entry.manifest.priceBand.minimum || quote.requestId !== input.requestId || quote.operationId !== input.operationId) fail("SELLER_QUOTE_INVALID", "seller quote differs from its manifest or request");
    const endpoint = new URL(entry.manifest.endpoint), resource = new URL(String(quote.resourceUrl));
    if (resource.origin !== endpoint.origin || resource.pathname !== `${endpoint.pathname.replace(/\/$/, "")}/${encodeURIComponent(input.requestId)}` || resource.search || resource.hash) fail("SELLER_QUOTE_INVALID", "seller resource URL is outside its capability endpoint");
    return quote;
  }

  async purchaseBrief(input: { capabilityId: string; operationId: string; requestId: string; runId: string; task: string; budget: string }): Promise<Record<string, unknown>> {
    if (!/^[1-9][0-9]*$/.test(input.budget)) fail("BUYER_BUDGET_INVALID", "budget must be positive MIST");
    const catalog = await this.catalog(), entry = catalog.capabilities.find((item) => item.manifest.capabilityId === input.capabilityId) ?? fail("SELLER_CAPABILITY_UNKNOWN", "capability is not in the verified catalog");
    if (entry.manifest.capability !== "sui.market-brief") fail("BUYER_CAPABILITY_INVALID", "selected capability is not a market brief");
    const briefHash = (entry.preview.artifactHashes as Record<string, string> | undefined)?.default;
    const analysis = catalog.capabilities.find((item) => item.manifest.capability === "sui.competitor-analysis" && typeof (item.preview.artifactHashes as Record<string, string> | undefined)?.[String(briefHash)] === "string") ?? fail("ANALYSIS_UNAVAILABLE", "analysis seller has no matching prepared variant");
    if (BigInt(entry.manifest.priceBand.minimum) + BigInt(analysis.manifest.priceBand.minimum) > BigInt(input.budget)) fail("BUYER_BUDGET_EXCEEDED", "brief and analysis exceed the total task budget");
    const minimum = BigInt(entry.manifest.priceBand.minimum), opening = minimum > 1n ? minimum - (minimum / 10n || 1n) : minimum;
    const negotiated = await this.negotiate({ capabilityId: input.capabilityId, sessionId: input.requestId, runId: input.runId, task: input.task, opening: opening.toString(), maximum: (BigInt(input.budget) - BigInt(analysis.manifest.priceBand.minimum) < BigInt(entry.manifest.priceBand.maximum) ? BigInt(input.budget) - BigInt(analysis.manifest.priceBand.minimum) : BigInt(entry.manifest.priceBand.maximum)).toString() });
    const quote = await this.quote(input);
    if (BigInt(String(quote.amount)) > BigInt(input.budget)) fail("BUYER_BUDGET_EXCEEDED", "seller quote exceeds the budget");
    const plan = await executeMandated(this.app, this.mandate, "settlement.plan", { "operation-id": input.operationId, manifest: entry.manifest, "requested-amount": String(quote.amount) });
    if (plan.status !== "approved" || plan.rail !== "x402") fail("BUYER_RAIL_DENIED", "public brief settlement plan was not approved for x402");
    const paid = await executeMandated(this.app, this.mandate, "pay.x402", { "operation-id": input.operationId, "resource-url": String(quote.resourceUrl), amount: String(quote.amount), "plan-hash": String(plan.planHash) });
    const artifact = Buffer.from(String(paid.response), "base64");
    if (sha256(artifact) !== quote.artifactSha256 || sha256(artifact) !== paid.responseSha256) fail("DELIVERY_HASH_MISMATCH", "delivered brief differs from the seller quote or payment receipt");
    let report: Record<string, unknown>; try { report = JSON.parse(artifact.toString()) as Record<string, unknown>; } catch (error) { return fail("BRIEF_INVALID", "paid brief is not JSON", error); }
    if (typeof report.title !== "string" || typeof report.body !== "string" || !Array.isArray(report.citations) || report.citations.length < 2 || report.citations.some((value) => typeof value !== "string" || !/^https:\/\//.test(value))) fail("BRIEF_INVALID", "paid brief needs a title, body, and at least two HTTPS citations");
    const recorded = (await this.app.execute("resource.fetch", { "request-id": input.requestId, "operation-id": input.operationId, response: artifact.toString("base64url") })).data;
    this.app.store.db.exec("CREATE TABLE IF NOT EXISTS remote_purchases(run_id TEXT PRIMARY KEY,brief_hash TEXT NOT NULL,brief_amount TEXT NOT NULL,budget TEXT NOT NULL,capability_id TEXT NOT NULL,operation_id TEXT NOT NULL)");
    const prior = this.app.store.db.prepare("SELECT brief_hash AS briefHash,brief_amount AS briefAmount,budget,capability_id AS capabilityId,operation_id AS operationId FROM remote_purchases WHERE run_id=?").get(input.runId) as Record<string, unknown> | undefined;
    const purchase = { briefHash: sha256(artifact), briefAmount: String(paid.amount), budget: input.budget, capabilityId: input.capabilityId, operationId: input.operationId };
    if (prior && JSON.stringify(prior) !== JSON.stringify(purchase)) fail("BUYER_RUN_CONFLICT", "run ID identifies a different purchased brief or budget");
    if (!prior) this.app.store.db.prepare("INSERT INTO remote_purchases(run_id,brief_hash,brief_amount,budget,capability_id,operation_id) VALUES(?,?,?,?,?,?)").run(input.runId, purchase.briefHash, purchase.briefAmount, purchase.budget, purchase.capabilityId, purchase.operationId);
    return { capabilityId: input.capabilityId, sellerId: entry.manifest.sellerId, negotiation: negotiated, artifact: report, artifactSha256: sha256(artifact), deliveryStatus: recorded.deliveryStatus, transactionDigest: paid.transactionDigest, checkpoint: paid.checkpoint, rail: "x402", amount: paid.amount, payee: paid.counterparty, planHash: plan.planHash };
  }

  async agreement(input: { capabilityId: string; operationId: string; sessionId: string; runId: string; briefHash: string }): Promise<Record<string, unknown>> {
    if (!/^[0-9a-f]{64}$/.test(input.briefHash)) fail("BUYER_BRIEF_HASH_INVALID", "brief hash is invalid");
    const catalog = await this.catalog(), entry = catalog.capabilities.find((item) => item.manifest.capabilityId === input.capabilityId) ?? fail("SELLER_CAPABILITY_UNKNOWN", "capability is not in the verified catalog");
    this.app.store.db.exec("CREATE TABLE IF NOT EXISTS remote_purchases(run_id TEXT PRIMARY KEY,brief_hash TEXT NOT NULL,brief_amount TEXT NOT NULL,budget TEXT NOT NULL,capability_id TEXT NOT NULL,operation_id TEXT NOT NULL)");
    const purchased = this.app.store.db.prepare("SELECT brief_hash AS briefHash,brief_amount AS briefAmount,budget FROM remote_purchases WHERE run_id=?").get(input.runId) as { briefHash: string; briefAmount: string; budget: string } | undefined;
    if (!purchased || purchased.briefHash !== input.briefHash || BigInt(purchased.briefAmount) + BigInt(entry.manifest.priceBand.minimum) > BigInt(purchased.budget)) fail("BUYER_PURCHASE_REQUIRED", "analysis requires the matching paid brief within the total budget");
    const hashes = entry.preview.artifactHashes as Record<string, string> | undefined, artifactSha256 = hashes?.[input.briefHash];
    if (!artifactSha256 || !/^[0-9a-f]{64}$/.test(artifactSha256)) fail("SELLER_ARTIFACT_MISSING", "seller has no prepared analysis for the purchased brief");
    const analysisMinimum = BigInt(entry.manifest.priceBand.minimum), analysisOpening = analysisMinimum > 1n ? analysisMinimum - (analysisMinimum / 10n || 1n) : analysisMinimum;
    const negotiated = await this.negotiate({ capabilityId: input.capabilityId, sessionId: input.sessionId, runId: input.runId, task: "Confidential competitor analysis of the purchased Sui brief", opening: analysisOpening.toString(), maximum: entry.manifest.priceBand.minimum, briefHash: input.briefHash });
    const plan = await executeMandated(this.app, this.mandate, "settlement.plan", { "operation-id": input.operationId, manifest: entry.manifest, "requested-amount": entry.manifest.priceBand.minimum });
    if (plan.status !== "approved" || plan.rail !== "shielded" || !Array.isArray(plan.reasonCodes) || !plan.reasonCodes.includes("MEMORY_PRIVACY_APPLIED")) fail("BUYER_PRIVACY_REQUIRED", "saved owner privacy rule did not select shielded settlement");
    const publicKey = this.app.store.getSecret("identity:x25519-public")?.toString("base64url") ?? fail("IDENTITY_MISSING", "buyer delivery key is missing");
    const identity = (await this.app.execute("doctor", {})).data as { babyJubPublicKey: string[] };
    const [transcriptRootLo, transcriptRootHi] = [BigInt(`0x${String(negotiated.transcriptHash).slice(0, 32)}`).toString(), BigInt(`0x${String(negotiated.transcriptHash).slice(32)}`).toString()];
    const [serviceDigestLo, serviceDigestHi] = halves(JSON.stringify({ capabilityId: input.capabilityId, briefHash: input.briefHash, artifactSha256, deliveryPublicKey: publicKey }));
    const scalar = () => BigInt(`0x${randomBytes(16).toString("hex")}`).toString();
    const draft = { dealId: scalar(), revision: "1", transcriptRootLo, transcriptRootHi, serviceDigestLo, serviceDigestHi, settlementNonceLo: scalar(), settlementNonceHi: scalar(), paymentAmount: entry.manifest.priceBand.minimum, blinding: scalar(), expiry: String(Date.now() + 30 * 60_000), buyerPublicKey: identity.babyJubPublicKey, counterparty: entry.manifest.sellerId, capabilityId: entry.manifest.capabilityId, manifestHash: entry.manifest.manifestHash };
    const signed = await this.request("/v1/agreement", { method: "POST", body: JSON.stringify({ capabilityId: input.capabilityId, sessionId: input.sessionId, runId: input.runId, briefHash: input.briefHash, deliveryPublicKey: publicKey, agreement: Buffer.from(JSON.stringify(draft)).toString("base64url") }) });
    if (signed.artifactSha256 !== artifactSha256 || signed.capabilityId !== input.capabilityId || signed.sessionId !== input.sessionId) fail("AGREEMENT_BINDING_MISMATCH", "seller response changed the prepared artifact or session");
    const accepted = await executeMandated(this.app, this.mandate, "offer.accept", { "operation-id": `accept-${input.sessionId}`, session: input.sessionId, agreement: signed.agreement, "plan-hash": String(plan.planHash) });
    return { plan, accepted, negotiation: negotiated, sessionId: input.sessionId, artifactSha256, memoryCitationCount: Array.isArray(plan.citations) ? plan.citations.length : 0 };
  }

  async settleAnalysis(input: { sessionId: string; operationId: string }): Promise<Record<string, unknown>> {
    const agreement = this.app.store.db.prepare("SELECT agreement FROM live_agreements WHERE session_id=?").get(input.sessionId) as { agreement: string } | undefined ?? fail("AGREEMENT_NOT_ACCEPTED", "analysis session has no accepted seller agreement");
    const accepted = JSON.parse(agreement.agreement) as { paymentAmount: string; counterparty: string };
    const binding = this.app.store.db.prepare("SELECT plan_hash FROM settlement_agreement_bindings WHERE session_id=?").get(input.sessionId) as { plan_hash: string } | undefined ?? fail("SETTLEMENT_PLAN_REQUIRED", "analysis agreement is not bound to an approved plan");
    const receipt = await executeMandated(this.app, this.mandate, "pay.shielded", { "operation-id": input.operationId, session: input.sessionId, amount: accepted.paymentAmount, counterparty: accepted.counterparty, "plan-hash": binding.plan_hash });
    return { sessionId: input.sessionId, rail: "shielded", transactionDigest: receipt.transactionDigest, checkpoint: receipt.checkpoint, finalized: receipt.finalized, tatumVerified: receipt.tatumVerified, dealCommitment: receipt.dealCommitment, planHash: binding.plan_hash, visibility: "pool transaction and gas sender visible; direct amount and counterparty absent" };
  }

  async delivery(input: { sessionId: string; operationId: string }): Promise<Record<string, unknown>> {
    const response = await this.request(`/v1/delivery/${encodeURIComponent(input.sessionId)}`);
    if (response.status === "payment-pending") return response;
    if (response.status !== "delivered" || response.sessionId !== input.sessionId || !/^[0-9a-f]{64}$/.test(String(response.artifactSha256))) fail("DELIVERY_INVALID", "seller delivery is invalid");
    const privateDer = this.app.store.getSecret("identity:x25519-private") ?? fail("IDENTITY_MISSING", "buyer delivery key is missing");
    const privateKey = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" }), ephemeral = createPublicKey({ key: Buffer.from(response.ephemeralPublicKey, "base64url"), format: "der", type: "spki" });
    const shared = diffieHellman({ privateKey, publicKey: ephemeral }), key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(input.sessionId), Buffer.from("supercuts-delivery-v1"), 32));
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(response.nonce, "base64url"));
    decipher.setAAD(Buffer.from(`${input.sessionId}:${String(response.capabilityId)}:${String(response.artifactSha256)}`));
    decipher.setAuthTag(Buffer.from(response.tag, "base64url"));
    const artifact = Buffer.concat([decipher.update(Buffer.from(response.ciphertext, "base64url")), decipher.final()]);
    if (sha256(artifact) !== response.artifactSha256) fail("DELIVERY_HASH_MISMATCH", "seller artifact differs from its accepted hash");
    const recorded = (await this.app.execute("resource.fetch", { "request-id": input.sessionId, "operation-id": input.operationId, response: artifact.toString("base64url") })).data;
    return { status: "delivered", sessionId: input.sessionId, artifactSha256: response.artifactSha256, body: artifact.toString("utf8"), record: { deliveryStatus: recorded.deliveryStatus, responseHash: recorded.responseHash } };
  }

  async events(runId: string): Promise<Record<string, unknown>> { return this.request(`/v1/events?runId=${encodeURIComponent(runId)}`); }
}
