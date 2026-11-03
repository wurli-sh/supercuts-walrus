#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { createCapabilityManifest, type CapabilityManifest } from "./capability.js";
import { fail } from "./errors.js";
import { Phase3App, errorOutput } from "./phase3.js";
import { executeMandated, loadMandate } from "./mandate.js";

async function main(): Promise<void> {
  const home = process.argv[2], specPath = process.argv[3], outputPath = process.argv[4];
  if (!home || !specPath || !outputPath) return fail("ARGUMENT_REQUIRED", "usage: supercuts-seller-register <seller-home> <capability-spec.json> <registration.json>");
  if ((statSync(specPath).mode & 0o077) !== 0) fail("SELLER_CONFIG_PERMISSIONS", "capability spec must be owner-only");
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as Omit<CapabilityManifest, "protocol" | "manifestHash" | "sellerId">;
  const app = new Phase3App(home);
  try {
    if (app.profile.role !== "seller" || app.profile.mock) fail("SELLER_LIVE_REQUIRED", "registration requires a live seller role home");
    const encoded = app.store.getSecret("live:sui-private-key")?.toString() ?? fail("LIVE_CREDENTIAL_MISSING", "seller signer is missing");
    const decoded = decodeSuiPrivateKey(encoded);
    if (decoded.scheme !== "ED25519") fail("SIGNER_UNSUPPORTED", "seller requires an ED25519 signer");
    const signer = Ed25519Keypair.fromSecretKey(decoded.secretKey), manifest = createCapabilityManifest({ ...spec, sellerId: signer.toSuiAddress() });
    const published = await executeMandated(app, loadMandate(home), "capability.publish", { "operation-id": `publish-${manifest.manifestHash}`, manifest });
    const blobId = String(published.blobId ?? "");
    if (!blobId) fail("WALRUS_PUBLISH_FAILED", "capability publication omitted a Walrus blob ID");
    const transportPublicKey = app.store.getSecret("identity:x25519-public")?.toString("base64url") ?? fail("IDENTITY_MISSING", "seller transport key is missing");
    const sellerSignature = (await signer.signPersonalMessage(Buffer.from(`${manifest.manifestHash}:${transportPublicKey}`))).signature;
    const registration = { manifest, manifestBlobId: blobId, transportPublicKey, sellerSignature };
    writeFileSync(resolve(outputPath), `${JSON.stringify(registration, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    process.stdout.write(`${JSON.stringify({ ok: true, capabilityId: manifest.capabilityId, manifestBlobId: blobId, registrationFile: resolve(outputPath) })}\n`);
  } finally { app.close(); }
}
main().catch((error) => { process.stdout.write(`${JSON.stringify(errorOutput(error))}\n`); process.exitCode = 1; });
