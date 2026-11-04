import assert from "node:assert/strict";
import test from "node:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { createCapabilityManifest } from "../src/capability.js";
import { registerDirectoryCapability, validateDirectoryOrigin } from "../src/seller-directory.js";

test("directory accepts only a signed capability served by its seller and Walrus", async () => {
  const seller = Ed25519Keypair.generate();
  const manifest = createCapabilityManifest({ capabilityId: "directory-example", sellerId: seller.toSuiAddress(), capability: "artifact.generation", description: "example", inputSchema: { type: "object" }, outputSchema: { type: "object" }, supportedRails: ["shielded"], priceBand: { minimum: "1", maximum: "2" }, asset: "0x2::sui::SUI", endpoint: "http://127.0.0.1:8788/v2/resource/directory-example", expiresAt: Date.now() + 60_000 });
  const registration = { manifest, manifestBlobId: "blob-one", transportPublicKey: "transport-key", sellerSignature: (await seller.signPersonalMessage(Buffer.from(`${manifest.manifestHash}:transport-key`))).signature };
  const saved: unknown[] = [];
  const database = { async putDirectory(value: unknown) { saved.push(value); } };
  const http = async (input: string | URL | Request) => new Response(JSON.stringify(String(input).includes("/v1/blobs/") ? manifest : { capabilities: [registration] }), { status: 200 });
  await registerDirectoryCapability(database, registration, "https://aggregator.example", http as typeof fetch, true);
  assert.equal(saved.length, 1);
  await assert.rejects(() => registerDirectoryCapability(database, { ...registration, sellerSignature: "invalid" }, "https://aggregator.example", http as typeof fetch, true), { code: "SELLER_SIGNATURE_INVALID" });
  await assert.rejects(() => registerDirectoryCapability(database, registration, "https://aggregator.example", (async () => new Response(JSON.stringify({ capabilities: [] }))) as typeof fetch, true), { code: "CAPABILITY_BLOB_MISMATCH" });
  await assert.rejects(() => registerDirectoryCapability(database, registration, "https://aggregator.example", (async (input: string | URL | Request) => new Response(JSON.stringify(String(input).includes("/v1/blobs/") ? manifest : { capabilities: [] }))) as typeof fetch, true), { code: "SELLER_DIRECTORY_UNAVAILABLE" });
});

test("directory rejects private network seller origins", async () => {
  await assert.rejects(() => validateDirectoryOrigin("https://127.0.0.1/v2/resource/x"), { code: "SELLER_ENDPOINT_UNSAFE" });
  await assert.rejects(() => validateDirectoryOrigin("http://localhost:8788/v2/resource/x"), { code: "SELLER_ENDPOINT_UNSAFE" });
});
