#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifySignedCapability, validateCapabilityPayload, type SignedCapabilityRegistration } from "./capability.js";
import { fail } from "./errors.js";
import { SellerDatabase } from "./seller-database.js";
import { captureSellerHome, decryptSellerSnapshot, encryptSellerSnapshot, restoreSellerHome } from "./seller-state.js";

interface Item { registrationFile: string; artifactFile: string; outputMetadata: Record<string, unknown>; contentType?: string; }
interface Seller { sellerId: string; capabilities: Item[]; }
async function main(): Promise<void> {
  const configPath = resolve(process.argv[2] ?? fail("ARGUMENT_REQUIRED", "usage: supercuts-seller-v2-provision <owner-only-config.json>"));
  if ((statSync(configPath).mode & 0o077) !== 0) fail("SELLER_CONFIG_PERMISSIONS", "provision config must be owner-only");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { sellers: Seller[] };
  if (!Array.isArray(config.sellers) || !config.sellers.length) fail("SELLER_CONFIG_INVALID", "at least one seller is required");
  const required = (key: string) => process.env[key] ?? fail("SELLER_CONFIG_MISSING", `${key} is required`);
  const db = new SellerDatabase(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"));
  const stateKey = required("SELLER_STATE_KEY"), origin = new URL(required("SELLER_ORIGIN")).origin;
  for (const seller of config.sellers) {
    const stored = await db.getSnapshot(seller.sellerId) ?? fail("SELLER_STATE_MISSING", "seller must have an encrypted hosted snapshot before v2 provisioning");
    const snapshot = decryptSellerSnapshot(stored.payload, stateKey);
    const registrations: Array<{ registration: SignedCapabilityRegistration; item: Item }> = [];
    for (const item of seller.capabilities) {
      const path = resolve(item.registrationFile);
      if ((statSync(path).mode & 0o077) !== 0) fail("SELLER_CONFIG_PERMISSIONS", "registration file must be owner-only");
      const registration = JSON.parse(readFileSync(path, "utf8")) as SignedCapabilityRegistration;
      await verifySignedCapability(registration);
      if (registration.manifest.sellerId !== seller.sellerId || new URL(registration.manifest.endpoint).origin !== origin || !new URL(registration.manifest.endpoint).pathname.startsWith("/v2/resource/")) fail("SELLER_CONFIG_INVALID", "v2 registration seller or endpoint differs from the hosted service");
      validateCapabilityPayload(registration.manifest, "output", item.outputMetadata);
      const artifact = readFileSync(resolve(item.artifactFile));
      if (!artifact.length || artifact.length > 10 * 1024 * 1024) fail("SELLER_ARTIFACT_INVALID", "v2 artifact must be 1 byte to 10 MiB");
      snapshot.artifacts[registration.manifest.capabilityId] = artifact.toString("base64url");
      registrations.push({ registration, item });
    }
    const temporary = mkdtempSync(join(tmpdir(), "supercuts-seller-v2-"));
    try {
      restoreSellerHome(join(temporary, "seller"), snapshot);
      const updated = await captureSellerHome(join(temporary, "seller"), seller.sellerId, snapshot.artifacts);
      await db.putSnapshot(encryptSellerSnapshot(updated, stateKey), stored.revision);
      for (const { registration, item } of registrations) await db.putCatalog({ seller_id: seller.sellerId, capability_id: registration.manifest.capabilityId, manifest: registration.manifest, blob_id: registration.manifestBlobId, signature: registration.sellerSignature, transport_public_key: registration.transportPublicKey, preview: { genericV2: true, outputMetadata: item.outputMetadata, contentType: item.contentType ?? "application/octet-stream" } });
      process.stdout.write(`${JSON.stringify({ ok: true, sellerId: seller.sellerId, capabilities: registrations.map(({ registration }) => registration.manifest.capabilityId), restartRequired: true })}\n`);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "v2 provisioning failed"}\n`); process.exitCode = 1; });
