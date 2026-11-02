import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCapabilityManifest } from "../src/capability.js";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMandate } from "../src/mandate.js";
import { Phase3App, initialize } from "../src/phase3.js";
import { RemoteBuyer } from "../src/remote-buyer.js";
import { captureSellerHome, decryptSellerSnapshot, encryptSellerSnapshot, restoreSellerHome } from "../src/seller-state.js";
import { SellerService } from "../src/seller-service.js";
import type { SellerDatabase } from "../src/seller-database.js";
import { SellerDatabase as SupabaseSellerDatabase } from "../src/seller-database.js";
import { ProtocolEngine } from "../src/protocol-engine.js";

test("encrypted seller snapshots restore role state after a restart and reject tampering", async () => {
  const root = mkdtempSync(join(tmpdir(), "supercuts-snapshot-")), home = join(root, "seller"), restored = join(root, "restored");
  initialize(home, { role: "seller", mock: true });
  const app = new Phase3App(home);
  app.store.putSecretOnce("test:private", Buffer.from("role-only-secret"));
  const key = randomBytes(32).toString("base64url"), snapshot = await captureSellerHome(home, "seller-one", { report: Buffer.from("prepared report").toString("base64url") });
  const sealed = encryptSellerSnapshot(snapshot, key);
  assert.doesNotMatch(JSON.stringify(sealed), /role-only-secret|prepared report/);
  assert.throws(() => decryptSellerSnapshot({ ...sealed, sellerId: "seller-two" }, key), { code: "SELLER_STATE_DECRYPT_FAILED" });
  restoreSellerHome(restored, decryptSellerSnapshot(sealed, key));
  const copy = new Phase3App(restored);
  try { assert.equal(copy.store.getSecret("test:private")?.toString(), "role-only-secret"); assert.equal(snapshot.artifacts.report, Buffer.from("prepared report").toString("base64url")); }
  finally { copy.close(); app.close(); }
});

test("Supabase writes accept empty successful PostgREST responses", async () => {
  const calls: string[] = [], db = new SupabaseSellerDatabase("https://project.supabase.co", "test-service-key", async (url) => { calls.push(String(url)); return new Response(null, { status: 201 }); });
  await db.addEvent({ run_id: "run", seller_id: "seller", stage: "quote", status: "complete", details: {} });
  assert.equal(calls.length, 1);
});

test("buyer ranks only affordable briefs with a visible quality and price rubric", async () => {
  const root = mkdtempSync(join(tmpdir(), "supercuts-rank-")); initialize(root, { role: "buyer", mock: true });
  const app = new Phase3App(root), buyer = new RemoteBuyer(app, loadMandate(root), "http://127.0.0.1:9999");
  const briefHashes = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
  const make = (id: string, price: string, relevance: number, briefHash: string) => ({ manifest: createCapabilityManifest({ capabilityId: id, sellerId: "seller-a", capability: "sui.market-brief", description: id, inputSchema: {}, outputSchema: {}, supportedRails: ["x402"], priceBand: { minimum: price, maximum: price }, asset: "0x2::sui::SUI", endpoint: `https://seller.example/resource/${id}`, expiresAt: Date.now() + 600_000 }), blobId: id, signature: "signed", transportPublicKey: "key", preview: { title: id, summary: id, citations: [], relevance, sourceQuality: 0.8, freshnessDays: 2, artifactHashes: { default: briefHash } } });
  const analysis = { manifest: createCapabilityManifest({ capabilityId: "analysis", sellerId: "seller-b", capability: "sui.competitor-analysis", description: "analysis", inputSchema: {}, outputSchema: {}, supportedRails: ["x402", "shielded"], priceBand: { minimum: "5", maximum: "5" }, asset: "0x2::sui::SUI", endpoint: "https://seller.example/resource/analysis", expiresAt: Date.now() + 600_000 }), blobId: "analysis", signature: "signed", transportPublicKey: "key", preview: { artifactHashes: Object.fromEntries(briefHashes.map((hash) => [hash, hash])) } };
  (buyer as unknown as { catalog: () => Promise<unknown> }).catalog = async () => ({ capabilities: [make("brief-a", "20", 0.9, briefHashes[0]!), make("brief-b", "10", 0.6, briefHashes[1]!), make("brief-c", "30", 1, briefHashes[2]!), analysis] });
  try {
    const ranked = await buyer.rankBriefs({ budget: "25", topic: "Sui" });
    const rows = ranked.rankings as Array<{ capabilityId: string; score: number }>;
    assert.equal(rows.length, 2); assert.equal(rows[0]!.capabilityId, "brief-a"); assert.ok(rows[0]!.score > rows[1]!.score);
    assert.equal((ranked.rubric as Record<string, number>).relevance, 0.35);
  } finally { app.close(); }
});

test("signed encrypted negotiation and quote survive a remote seller restart", async () => {
  const originalFetch = globalThis.fetch, root = mkdtempSync(join(tmpdir(), "supercuts-remote-integration-"));
  const blobs = new Map<string, Buffer>();
  const walrus = createServer(async (request, response) => {
    if (request.method === "PUT") {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks), blobId = `blob-${blobs.size + 1}`; blobs.set(blobId, body);
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ alreadyCertified: { blobId } })); return;
    }
    const blobId = request.url?.split("/").at(-1) ?? "", body = blobs.get(blobId);
    if (!body) { response.writeHead(404); response.end(); return; }
    response.end(body);
  });
  await new Promise<void>((done) => walrus.listen(0, "127.0.0.1", done));
  const walrusAddress = walrus.address(); assert(walrusAddress && typeof walrusAddress === "object");
  const walrusUrl = `http://127.0.0.1:${walrusAddress.port}`;
  const reservation = createServer(); await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
  const sellerAddress = reservation.address(); assert(sellerAddress && typeof sellerAddress === "object");
  const origin = `http://127.0.0.1:${sellerAddress.port}`; await new Promise<void>((done) => reservation.close(() => done()));
  const deployment = resolve(fileURLToPath(import.meta.url), "../../../config/pool-v1.testnet.json");
  const buyerSigner = Ed25519Keypair.generate(), sellerSigner = Ed25519Keypair.generate();
  const buyerKeyPath = join(root, "buyer.key"), sellerKeyPath = join(root, "seller.key"), tatumKeyPath = join(root, "tatum.key");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(buyerKeyPath, buyerSigner.getSecretKey(), { mode: 0o600 }); writeFileSync(sellerKeyPath, sellerSigner.getSecretKey(), { mode: 0o600 }); writeFileSync(tatumKeyPath, "unused-test-key", { mode: 0o600 });
  const buyerHome = join(root, "buyer"), sellerHome = join(root, "seller");
  const common = { "deployment-config": deployment, "tatum-key-file": tatumKeyPath, "write-grpc": "https://fullnode.testnet.sui.io:443", "tatum-grpc": "https://example.invalid:443", "walrus-publisher": walrusUrl, "walrus-aggregator": walrusUrl };
  initialize(buyerHome, { ...common, role: "buyer", "sui-key-file": buyerKeyPath, "allow-counterparty": sellerSigner.toSuiAddress() });
  initialize(sellerHome, { ...common, role: "seller", "sui-key-file": sellerKeyPath });
  const manifest = createCapabilityManifest({ capabilityId: "brief-remote", sellerId: sellerSigner.toSuiAddress(), capability: "sui.market-brief", description: "Prepared Sui brief", inputSchema: {}, outputSchema: {}, supportedRails: ["x402"], priceBand: { minimum: "10", maximum: "20" }, asset: "0x2::sui::SUI", endpoint: `${origin}/resource/brief-remote`, expiresAt: Date.now() + 600_000 });
  const analysisManifest = createCapabilityManifest({ capabilityId: "analysis-remote", sellerId: sellerSigner.toSuiAddress(), capability: "sui.competitor-analysis", description: "Prepared analysis", inputSchema: {}, outputSchema: {}, supportedRails: ["x402", "shielded"], priceBand: { minimum: "15", maximum: "15" }, asset: "0x2::sui::SUI", endpoint: `${origin}/resource/analysis-remote`, expiresAt: Date.now() + 600_000 });
  const manifestBlob = "manifest-brief", analysisBlob = "manifest-analysis", briefHash = "a".repeat(64), analysisBody = Buffer.from("confidential analysis");
  blobs.set(manifestBlob, Buffer.from(JSON.stringify(manifest))); blobs.set(analysisBlob, Buffer.from(JSON.stringify(analysisManifest)));
  const seller = new Phase3App(sellerHome), buyerApp = new Phase3App(buyerHome);
  const transportPublicKey = seller.store.getSecret("identity:x25519-public")!.toString("base64url"), signature = (await sellerSigner.signPersonalMessage(Buffer.from(`${manifest.manifestHash}:${transportPublicKey}`))).signature;
  const analysisSignature = (await sellerSigner.signPersonalMessage(Buffer.from(`${analysisManifest.manifestHash}:${transportPublicKey}`))).signature;
  const catalog = [
    { seller_id: sellerSigner.toSuiAddress(), capability_id: manifest.capabilityId, manifest, blob_id: manifestBlob, signature, transport_public_key: transportPublicKey, preview: { title: "Sui brief", relevance: 0.8, sourceQuality: 0.8, freshnessDays: 1 } },
    { seller_id: sellerSigner.toSuiAddress(), capability_id: analysisManifest.capabilityId, manifest: analysisManifest, blob_id: analysisBlob, signature: analysisSignature, transport_public_key: transportPublicKey, preview: { title: "Analysis", artifactHashes: { [briefHash]: "analysis-hash" } } },
  ];
  const key = randomBytes(32).toString("base64url"), snapshots = new Map<string, unknown>();
  snapshots.set(sellerSigner.toSuiAddress(), { payload: encryptSellerSnapshot(await captureSellerHome(sellerHome, sellerSigner.toSuiAddress(), { "brief-remote": Buffer.from("prepared report").toString("base64url"), [`analysis-remote:${briefHash}`]: analysisBody.toString("base64url") }), key), revision: 0 });
  seller.close();
  const db = { listCatalog: async () => catalog, getSnapshot: async (id: string) => snapshots.get(id), putSnapshot: async (snapshot: { sellerId: string }, expectedRevision: number) => { const current = snapshots.get(snapshot.sellerId) as { revision: number }; assert.equal(current.revision, expectedRevision); snapshots.set(snapshot.sellerId, { payload: snapshot, revision: expectedRevision + 1 }); return expectedRevision + 1; }, addEvent: async () => {}, listEvents: async () => [], claimPayment: async () => {} } as unknown as SellerDatabase;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("https://api.anthropic.com/")) {
      const body = JSON.parse(String(init?.body)), name = body.tools[0].name, candidate = JSON.parse(body.messages[0].content).policyApprovedCandidates[0];
      return new Response(JSON.stringify({ content: [{ type: "tool_use", name, input: { action: candidate.action } }], usage: { input_tokens: 5, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  let service: SellerService | undefined; let server: ReturnType<SellerService["createServer"]> | undefined;
  try {
    service = await SellerService.create({ db, snapshotKey: key, origin, facilitatorUrl: "http://127.0.0.1:9999", facilitatorKey: "f".repeat(32), allowedBuyers: new Set([buyerSigner.toSuiAddress()]), claudeKey: "test" });
    server = service.createServer(); await new Promise<void>((done) => server!.listen(sellerAddress.port, "127.0.0.1", done));
    const remote = new RemoteBuyer(buyerApp, loadMandate(buyerHome), origin);
    const negotiated = await remote.negotiate({ capabilityId: manifest.capabilityId, sessionId: "request-1", runId: "run-1", task: "Sui market brief", opening: "10", maximum: "20" });
    assert.equal(negotiated.amount, "10"); assert.equal(blobs.size, 4);
    const quote = await remote.quote({ capabilityId: manifest.capabilityId, requestId: "request-1", operationId: "pay-1", runId: "run-1", task: "Sui market brief" });
    assert.equal(quote.amount, "10"); assert.equal(quote.resourceUrl, `${origin}/resource/brief-remote/request-1`);
    const privateOffer = await remote.negotiate({ capabilityId: analysisManifest.capabilityId, sessionId: "analysis-1", runId: "run-1", task: "private analysis", opening: "14", maximum: "15", briefHash });
    assert.equal(privateOffer.amount, "15");
    const hash = (value: string): [string, string] => { const digest = createHash("sha256").update(value).digest("hex"); return [BigInt(`0x${digest.slice(0, 32)}`).toString(), BigInt(`0x${digest.slice(32)}`).toString()]; };
    const engine = await ProtocolEngine.create(JSON.parse(readFileSync(deployment, "utf8")));
    const buyerPublicKey = engine.identity(buyerApp.store.getSecret("identity:babyjub-seed")!).publicKey.map(String);
    const deliveryPublicKey = buyerApp.store.getSecret("identity:x25519-public")!.toString("base64url"), artifactSha256 = createHash("sha256").update(analysisBody).digest("hex");
    const [transcriptRootLo, transcriptRootHi] = [BigInt(`0x${String(privateOffer.transcriptHash).slice(0, 32)}`).toString(), BigInt(`0x${String(privateOffer.transcriptHash).slice(32)}`).toString()];
    const [serviceDigestLo, serviceDigestHi] = hash(JSON.stringify({ capabilityId: analysisManifest.capabilityId, briefHash, artifactSha256, deliveryPublicKey }));
    const draft = { dealId: "1", revision: "1", transcriptRootLo, transcriptRootHi, serviceDigestLo, serviceDigestHi, settlementNonceLo: "2", settlementNonceHi: "3", paymentAmount: "15", blinding: "4", expiry: String(Date.now() + 600_000), buyerPublicKey, counterparty: sellerSigner.toSuiAddress(), capabilityId: analysisManifest.capabilityId, manifestHash: analysisManifest.manifestHash };
    const agreementRequest = { capabilityId: analysisManifest.capabilityId, sessionId: "analysis-1", runId: "run-1", briefHash, deliveryPublicKey, agreement: Buffer.from(JSON.stringify(draft)).toString("base64url") };
    const rejected = await originalFetch(`${origin}/v1/agreement`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...agreementRequest, agreement: Buffer.from(JSON.stringify({ ...draft, transcriptRootLo: "99" })).toString("base64url") }) });
    assert.equal(rejected.status, 400);
    const accepted = await originalFetch(`${origin}/v1/agreement`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(agreementRequest) });
    assert.equal(accepted.status, 200); const signed = await accepted.json() as { agreement: string; artifactSha256: string }; assert.equal(signed.artifactSha256, artifactSha256); assert.ok(signed.agreement);
    await new Promise<void>((done) => server!.close(() => done())); service.close(); server = undefined; service = undefined;
    service = await SellerService.create({ db, snapshotKey: key, origin, facilitatorUrl: "http://127.0.0.1:9999", facilitatorKey: "f".repeat(32), allowedBuyers: new Set([buyerSigner.toSuiAddress()]), claudeKey: "test" });
    server = service.createServer(); await new Promise<void>((done) => server!.listen(sellerAddress.port, "127.0.0.1", done));
    const challenged = await originalFetch(String(quote.resourceUrl)).catch(() => originalFetch(String(quote.resourceUrl))); assert.equal(challenged.status, 402);
    const row = buyerApp.store.db.prepare("SELECT request_ciphertext AS ciphertext,buyer_signature AS signature FROM remote_buyer_negotiations WHERE session_id='request-1'").get() as { ciphertext: string; signature: string };
    const replay = await originalFetch(`${origin}/v1/negotiate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ capabilityId: manifest.capabilityId, sessionId: "request-1", runId: "run-1", buyerAddress: buyerSigner.toSuiAddress(), buyerPublicKey: buyerApp.store.getSecret("identity:x25519-public")!.toString("base64url"), buyerSignature: row.signature, ciphertext: row.ciphertext }) });
    assert.equal(replay.status, 200); assert.equal((await replay.json()).transcriptHash, negotiated.transcriptHash);
    const agreementReplay = await originalFetch(`${origin}/v1/agreement`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(agreementRequest) });
    assert.equal(agreementReplay.status, 200); assert.equal((await agreementReplay.json()).agreement, signed.agreement);
  } finally {
    if (server) await new Promise<void>((done) => server!.close(() => done()));
    service?.close(); buyerApp.close(); globalThis.fetch = originalFetch;
    await new Promise<void>((done) => walrus.close(() => done()));
  }
});
