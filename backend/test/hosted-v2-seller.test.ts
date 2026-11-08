import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { createCapabilityManifest } from "../src/capability.js";
import { initialize, Phase3App } from "../src/phase3.js";
import { SellerService } from "../src/seller-service.js";
import { captureSellerHome, encryptSellerSnapshot } from "../src/seller-state.js";
import type { SellerDatabase } from "../src/seller-database.js";

test("hosted seller exposes signed v2 catalog while preserving v1 routes", async () => {
  const root = mkdtempSync(join(tmpdir(), "supercuts-hosted-v2-")), home = join(root, "seller"), keyPath = join(root, "seller.key"), tatum = join(root, "tatum.key");
  const signer = Ed25519Keypair.generate();
  writeFileSync(keyPath, signer.getSecretKey(), { mode: 0o600 }); writeFileSync(tatum, "test-key", { mode: 0o600 });
  const manifestServer = createServer();
  await new Promise<void>((done) => manifestServer.listen(0, "127.0.0.1", done));
  const walrusAddress = manifestServer.address(); assert(walrusAddress && typeof walrusAddress === "object");
  const walrusUrl = `http://127.0.0.1:${walrusAddress.port}`;
  const reservation = createServer(); await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
  const sellerAddress = reservation.address(); assert(sellerAddress && typeof sellerAddress === "object");
  const origin = `http://127.0.0.1:${sellerAddress.port}`;
  await new Promise<void>((done) => reservation.close(() => done()));
  const deployment = resolve(fileURLToPath(import.meta.url), "../../../config/phase1.testnet.json");
  initialize(home, { role: "seller", "deployment-config": deployment, "sui-key-file": keyPath, "tatum-key-file": tatum, "write-grpc": "https://fullnode.testnet.sui.io:443", "tatum-grpc": "https://example.invalid:443", "walrus-publisher": walrusUrl, "walrus-aggregator": walrusUrl });
  const app = new Phase3App(home), transportPublicKey = app.store.getSecret("identity:x25519-public")!.toString("base64url");
  const manifest = createCapabilityManifest({ capabilityId: "hosted-report", sellerId: signer.toSuiAddress(), capability: "report", description: "Hosted report", inputSchema: { type: "object", required: ["task"], properties: { task: { type: "string" } }, additionalProperties: false }, outputSchema: { type: "object", required: ["kind"], properties: { kind: { const: "report" } }, additionalProperties: false }, supportedRails: ["shielded"], priceBand: { minimum: "10", maximum: "10" }, asset: "0x2::sui::SUI", endpoint: `${origin}/v2/resource/hosted-report`, expiresAt: Date.now() + 600_000 });
  manifestServer.removeAllListeners("request");
  manifestServer.on("request", (_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(manifest)); });
  const registration = { manifest, manifestBlobId: "manifest", transportPublicKey, sellerSignature: (await signer.signPersonalMessage(Buffer.from(`${manifest.manifestHash}:${transportPublicKey}`))).signature };
  const snapshot = await captureSellerHome(home, signer.toSuiAddress(), { "hosted-report": Buffer.from("paid report").toString("base64url") });
  app.close();
  const stateKey = Buffer.alloc(32, 7).toString("base64url"), encrypted = encryptSellerSnapshot(snapshot, stateKey);
  const db = { listCatalog: async () => [{ seller_id: signer.toSuiAddress(), capability_id: manifest.capabilityId, manifest, blob_id: registration.manifestBlobId, signature: registration.sellerSignature, transport_public_key: transportPublicKey, preview: { genericV2: true, outputMetadata: { kind: "report" }, contentType: "text/plain" } }], getSnapshot: async () => ({ payload: encrypted, revision: 0 }), putSnapshot: async () => 1, claimPayment: async () => undefined } as unknown as SellerDatabase;
  const service = await SellerService.create({ db, snapshotKey: stateKey, origin, facilitatorUrl: origin, facilitatorKey: "local-test-key", allowedBuyers: new Set(), claudeKey: "local-test-key" });
  const server = service.createServer(); await new Promise<void>((done) => server.listen(sellerAddress.port, "127.0.0.1", done));
  try {
    const v2 = await (await fetch(`${origin}/v2/catalog`)).json() as { capabilities: Array<{ manifest: { capabilityId: string } }> };
    const v1 = await (await fetch(`${origin}/v1/catalog`)).json() as { capabilities: unknown[] };
    assert.equal(v2.capabilities[0]?.manifest.capabilityId, "hosted-report");
    assert.deepEqual(v1.capabilities, []);
  } finally { await new Promise<void>((done) => server.close(() => done())); service.close(); await new Promise<void>((done) => manifestServer.close(() => done())); }
  const oldProfile = { ...JSON.parse(Buffer.from(snapshot.files["profile.json"], "base64url").toString()) as Record<string, unknown>, verifierVersion: 1 };
  const wrongPool = { ...snapshot, files: { ...snapshot.files, "profile.json": Buffer.from(JSON.stringify(oldProfile)).toString("base64url") } };
  const v1Db = { ...db, getSnapshot: async () => ({ payload: encryptSellerSnapshot(wrongPool, stateKey), revision: 0 }) } as unknown as SellerDatabase;
  await assert.rejects(() => SellerService.create({ db: v1Db, snapshotKey: stateKey, origin, facilitatorUrl: origin, facilitatorKey: "local-test-key", allowedBuyers: new Set(), claudeKey: "local-test-key" }), /separate v2 seller role home/);
});

test("hosted directory serves bounded catalog pages independently of seller state", async () => {
  const offsets: number[] = [];
  const db = { listCatalog: async () => [], listDirectory: async (_now: number, offset = 0) => { offsets.push(offset); return []; } } as unknown as SellerDatabase;
  const service = await SellerService.create({ db, snapshotKey: Buffer.alloc(32, 9).toString("base64url"), origin: "http://127.0.0.1:8788", facilitatorUrl: "http://127.0.0.1:8788", facilitatorKey: "test", allowedBuyers: new Set(), claudeKey: "test", directoryAggregator: "https://aggregator.example" });
  const server = service.createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert(address && typeof address === "object");
  try {
    const origin = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${origin}/v2/directory/catalog?offset=100`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { capabilities: [] });
    assert.deepEqual(offsets, [100]);
    assert.equal((await fetch(`${origin}/v2/directory/catalog?offset=-1`)).status, 400);
  } finally { await new Promise<void>((done) => server.close(() => done())); service.close(); }
});

test("hosted health names expired v2 capabilities instead of silently serving an empty catalog", async () => {
  const expired = { seller_id: "0xseller", capability_id: "stale-brief", manifest: { capabilityId: "stale-brief", expiresAt: Date.now() - 1 }, preview: { genericV2: true } };
  const db = { listCatalog: async () => [expired], listDirectory: async () => [] } as unknown as SellerDatabase;
  const service = await SellerService.create({ db, snapshotKey: Buffer.alloc(32, 9).toString("base64url"), origin: "http://127.0.0.1:8788", facilitatorUrl: "http://127.0.0.1:8788", facilitatorKey: "test", allowedBuyers: new Set(), claudeKey: "test" });
  const server = service.createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert(address && typeof address === "object");
  try {
    const health = await (await fetch(`http://127.0.0.1:${address.port}/health`)).json() as { ok: boolean; capabilities: { active: number; expired: string[] } };
    assert.deepEqual(health.capabilities, { active: 0, expired: ["stale-brief"] });
  } finally { await new Promise<void>((done) => server.close(() => done())); service.close(); }
});
