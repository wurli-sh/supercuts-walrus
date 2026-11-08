#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { verifySignedCapability, validateCapabilityPayload, type SignedCapabilityRegistration } from "./capability.js";
import { fail } from "./errors.js";
import { SellerDatabase } from "./seller-database.js";
import { captureSellerHome, decryptSellerSnapshot, encryptSellerSnapshot, type SellerSnapshot } from "./seller-state.js";
import { Phase3App } from "./phase3.js";

interface Item { registrationFile: string; artifactFile: string; outputMetadata: Record<string, unknown>; contentType?: string; }
interface Seller { sellerId: string; home?: string; capabilities: Item[]; }
async function main(): Promise<void> {
  const configPath = resolve(process.argv[2] ?? fail("ARGUMENT_REQUIRED", "usage: supercuts-seller-v2-provision <owner-only-config.json>"));
  if ((statSync(configPath).mode & 0o077) !== 0) fail("SELLER_CONFIG_PERMISSIONS", "provision config must be owner-only");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { sellers: Seller[] };
  if (!Array.isArray(config.sellers) || !config.sellers.length) fail("SELLER_CONFIG_INVALID", "at least one seller is required");
  const required = (key: string) => process.env[key] ?? fail("SELLER_CONFIG_MISSING", `${key} is required`);
  const db = new SellerDatabase(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"));
  const stateKey = required("SELLER_STATE_KEY");
  // SELLER_ORIGIN pins the hosted origin; without it, the first signed registration sets it and every other one must match.
  let origin = process.env.SELLER_ORIGIN ? new URL(process.env.SELLER_ORIGIN).origin : undefined;
  for (const seller of config.sellers) {
    const stored = await db.getSnapshot(seller.sellerId);
    let snapshot: SellerSnapshot;
    if (stored) snapshot = decryptSellerSnapshot(stored.payload, stateKey);
    else {
      if (!seller.home) fail("SELLER_STATE_MISSING", "new hosted v2 seller requires its separate local role home");
      const home = resolve(seller.home!);
      if ((statSync(home).mode & 0o077) !== 0) fail("SELLER_CONFIG_PERMISSIONS", "seller role home must be owner-only");
      const app = new Phase3App(home);
      try {
        if (app.profile.role !== "seller" || app.profile.mock || app.profile.verifierVersion !== 2) fail("SELLER_POOL_VERSION_MISMATCH", "new hosted v2 seller requires a live v2 seller role home");
        const encoded = app.store.getSecret("live:sui-private-key")?.toString() ?? fail("LIVE_CREDENTIAL_MISSING", "seller signer is missing");
        const decoded = decodeSuiPrivateKey(encoded);
        if (decoded.scheme !== "ED25519" || Ed25519Keypair.fromSecretKey(decoded.secretKey).toSuiAddress() !== seller.sellerId) fail("SELLER_IDENTITY_MISMATCH", "v2 seller home signer differs from configured seller ID");
        snapshot = await captureSellerHome(home, seller.sellerId);
      } finally { app.close(); }
    }
    const profile = JSON.parse(Buffer.from(snapshot.files["profile.json"], "base64url").toString()) as { role?: string; mock?: boolean; verifierVersion?: number };
    if (profile.role !== "seller" || profile.mock || profile.verifierVersion !== 2) fail("SELLER_POOL_VERSION_MISMATCH", "v2 capability cannot use a v1 seller snapshot; create a separate v2 role home");
    const registrations: Array<{ registration: SignedCapabilityRegistration; item: Item }> = [];
    for (const item of seller.capabilities) {
      const path = resolve(item.registrationFile);
      if ((statSync(path).mode & 0o077) !== 0) fail("SELLER_CONFIG_PERMISSIONS", "registration file must be owner-only");
      const registration = JSON.parse(readFileSync(path, "utf8")) as SignedCapabilityRegistration;
      await verifySignedCapability(registration);
      origin ??= new URL(registration.manifest.endpoint).origin;
      if (registration.manifest.sellerId !== seller.sellerId || new URL(registration.manifest.endpoint).origin !== origin || !new URL(registration.manifest.endpoint).pathname.startsWith("/v2/resource/")) fail("SELLER_CONFIG_INVALID", "v2 registration seller or endpoint differs from the hosted service");
      validateCapabilityPayload(registration.manifest, "output", item.outputMetadata);
      const artifact = readFileSync(resolve(item.artifactFile));
      if (!artifact.length || artifact.length > 10 * 1024 * 1024) fail("SELLER_ARTIFACT_INVALID", "v2 artifact must be 1 byte to 10 MiB");
      snapshot.artifacts[registration.manifest.capabilityId] = artifact.toString("base64url");
      registrations.push({ registration, item });
    }
    await db.putSnapshot(encryptSellerSnapshot(snapshot, stateKey), stored?.revision);
    for (const { registration, item } of registrations) await db.putCatalog({ seller_id: seller.sellerId, capability_id: registration.manifest.capabilityId, manifest: registration.manifest, blob_id: registration.manifestBlobId, signature: registration.sellerSignature, transport_public_key: registration.transportPublicKey, preview: { genericV2: true, outputMetadata: item.outputMetadata, contentType: item.contentType ?? "application/octet-stream" } });
    process.stdout.write(`${JSON.stringify({ ok: true, sellerId: seller.sellerId, capabilities: registrations.map(({ registration }) => registration.manifest.capabilityId), restartRequired: true })}\n`);
  }
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "v2 provisioning failed"}\n`); process.exitCode = 1; });
