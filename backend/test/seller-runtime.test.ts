import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { createCapabilityManifest } from "../src/capability.js";
import { SellerRuntime, type SellerRuntimePorts, type ServiceRequest } from "../src/seller-runtime.js";
import { serveSellerStdio } from "../src/seller-stdio.js";
import { RoleStore } from "../src/store.js";

test("seller handler runs only after exact finalized payment and caches one delivery", async () => {
  const signer = Ed25519Keypair.generate();
  const manifest = createCapabilityManifest({ capabilityId: "service-one", sellerId: signer.toSuiAddress(), capability: "artifact.generation", description: "service", inputSchema: { type: "object", required: ["task"], properties: { task: { type: "string" } }, additionalProperties: false }, outputSchema: { type: "object", required: ["format"], properties: { format: { const: "text" } }, additionalProperties: false }, supportedRails: ["shielded"], priceBand: { minimum: "10", maximum: "20" }, asset: "0x2::sui::SUI", endpoint: "https://seller.example/service", expiresAt: Date.now() + 60_000 });
  const registration = { manifest, manifestBlobId: "manifest-blob", transportPublicKey: "seller-transport", sellerSignature: (await signer.signPersonalMessage(Buffer.from(`${manifest.manifestHash}:seller-transport`))).signature };
  const blobs = new Map<string, Uint8Array>([[registration.manifestBlobId, Buffer.from(JSON.stringify(manifest))]]);
  const home = mkdtempSync(join(tmpdir(), "supercuts-seller-runtime-"));
  const store = new RoleStore(join(home, "state.sqlite"), randomBytes(32));
  let paid = false, handled = 0;
  const ports: SellerRuntimePorts = {
    readBlob: async (id) => blobs.get(id) ?? new Uint8Array(),
    verifyPayment: async (request) => {
      if (!paid) throw Object.assign(new Error("payment pending"), { code: "SELLER_PAYMENT_UNVERIFIED" });
      return { finalized: true, tatumVerified: true, digest: request.paymentDigest, agreementHash: request.agreementHash, sellerId: manifest.sellerId, asset: manifest.asset, amount: request.agreedAmount, rail: request.rail };
    },
    encryptAndPublish: async () => { const ciphertext = Buffer.from("encrypted-artifact"); blobs.set("delivery-blob", ciphertext); return { blobId: "delivery-blob", ciphertext }; },
    serve: async () => {},
  };
  const runtime = new SellerRuntime(store, ports);
  const request: ServiceRequest = { dealId: "deal-one", capabilityId: manifest.capabilityId, input: { task: "private" }, requestId: "request-one", paymentDigest: "digest-one", agreementHash: "a".repeat(64), agreedAmount: "10", rail: "shielded" };
  try {
    await runtime.registerCapability(registration, async () => { handled++; return { artifact: Buffer.from("result"), contentType: "text/plain", metadata: { format: "text" } }; });
    await assert.rejects(() => runtime.fulfill(request), { code: "SELLER_PAYMENT_UNVERIFIED" });
    assert.equal(handled, 0);
    paid = true;
    const first = await runtime.fulfill(request);
    const replay = await runtime.fulfill(request);
    assert.deepEqual(replay, first);
    assert.equal(first.blobId, "delivery-blob");
    assert.equal(handled, 1);
    await assert.rejects(() => runtime.fulfill({ ...request, input: { task: "changed" } }), { code: "SELLER_REQUEST_CONFLICT" });
    const inputStream = new PassThrough(), outputStream = new PassThrough();
    let output = ""; outputStream.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const serving = serveSellerStdio(runtime, inputStream, outputStream);
    inputStream.end(`${JSON.stringify({ id: "catalog-1", method: "catalog" })}\n${JSON.stringify({ id: "fulfill-1", method: "fulfill", params: request })}\n`);
    await serving;
    const responses = output.trim().split("\n").map((line) => JSON.parse(line) as { ok: boolean; result: Record<string, unknown> });
    assert.equal((responses[0]!.result.capabilities as unknown[]).length, 1);
    assert.equal(responses[1]!.result.blobId, "delivery-blob");
    assert.equal(handled, 1);
    const renewedManifest = createCapabilityManifest({ capabilityId: manifest.capabilityId, sellerId: manifest.sellerId, capability: manifest.capability, description: "renewed service", inputSchema: manifest.inputSchema, outputSchema: manifest.outputSchema, supportedRails: manifest.supportedRails, priceBand: manifest.priceBand, asset: manifest.asset, endpoint: manifest.endpoint, expiresAt: manifest.expiresAt + 120_000 });
    blobs.set("renewed-blob", Buffer.from(JSON.stringify(renewedManifest)));
    const renewed = { manifest: renewedManifest, manifestBlobId: "renewed-blob", transportPublicKey: registration.transportPublicKey, sellerSignature: (await signer.signPersonalMessage(Buffer.from(`${renewedManifest.manifestHash}:${registration.transportPublicKey}`))).signature };
    await assert.rejects(() => runtime.registerCapability(renewed, async () => ({ artifact: Buffer.from("new"), contentType: "text/plain", metadata: { format: "text" } })), { code: "SELLER_CAPABILITY_CONFLICT" });
    const realNow = Date.now;
    Date.now = () => manifest.expiresAt + 1;
    try { await runtime.registerCapability(renewed, async () => ({ artifact: Buffer.from("new"), contentType: "text/plain", metadata: { format: "text" } })); }
    finally { Date.now = realNow; }
    assert.equal(runtime.catalog()[0]?.manifest.manifestHash, renewedManifest.manifestHash);
  } finally { store.close(); }
});
