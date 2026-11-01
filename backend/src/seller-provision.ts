#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { createHash } from "node:crypto";
import { validateCapabilityManifest, type CapabilityManifest } from "./capability.js";
import { fail } from "./errors.js";
import { executeMandated, loadMandate } from "./mandate.js";
import { Phase3App } from "./phase3.js";
import { SellerDatabase } from "./seller-database.js";
import { captureSellerHome, encryptSellerSnapshot } from "./seller-state.js";

interface CapabilityConfig { manifest: CapabilityManifest; preview: Record<string, unknown>; artifact?: string; variants?: Record<string, string>; }
interface SellerConfig { sellerId: string; home: string; capabilities: CapabilityConfig[]; }

async function main(): Promise<void> {
  const path = process.argv[2] ? resolve(process.argv[2]) : fail("ARGUMENT_REQUIRED", "usage: supercuts-seller-provision <owner-only-config.json>");
  if ((statSync(path).mode & 0o077) !== 0) fail("CREDENTIAL_PERMISSIONS", "seller provision config must be owner-only");
  const config = JSON.parse(readFileSync(path, "utf8")) as { sellers: SellerConfig[] };
  if (!Array.isArray(config.sellers) || config.sellers.length !== 3 || new Set(config.sellers.map((seller) => seller.sellerId)).size !== 3) fail("SELLER_CONFIG_INVALID", "exactly three distinct sellers are required");
  const required = (key: string) => process.env[key] ?? fail("SELLER_CONFIG_MISSING", `${key} is required`);
  const db = new SellerDatabase(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"));
  const key = required("SELLER_STATE_KEY");
  for (const seller of config.sellers) {
    const app = new Phase3App(resolve(seller.home));
    try {
      if (app.profile.mock || app.profile.role !== "seller") fail("LIVE_PROFILE_REQUIRED", "provision only live seller role homes");
      const encoded = app.store.getSecret("live:sui-private-key")?.toString() ?? fail("LIVE_CREDENTIAL_MISSING", "seller Sui key is missing");
      const decoded = decodeSuiPrivateKey(encoded);
      if (decoded.scheme !== "ED25519") fail("SELLER_IDENTITY_MISMATCH", "seller requires an ED25519 signer");
      const signer = Ed25519Keypair.fromSecretKey(decoded.secretKey);
      if (signer.toSuiAddress() !== seller.sellerId) fail("SELLER_IDENTITY_MISMATCH", "seller ID must equal its Sui signer address");
      const artifacts: Record<string, string> = {};
      for (const capability of seller.capabilities) {
        const manifest = capability.manifest; validateCapabilityManifest(manifest);
        if (manifest.sellerId !== seller.sellerId) fail("SELLER_IDENTITY_MISMATCH", "manifest seller ID differs from its role home");
        if (capability.artifact) {
          const body = readFileSync(resolve(capability.artifact));
          if (manifest.capability === "sui.market-brief") {
            let report: Record<string, unknown>; try { report = JSON.parse(body.toString()) as Record<string, unknown>; } catch (error) { return fail("BRIEF_INVALID", "market brief must be JSON", error); }
            if (typeof report.title !== "string" || typeof report.body !== "string" || !Array.isArray(report.citations) || report.citations.length < 2 || report.citations.some((value) => typeof value !== "string" || !/^https:\/\//.test(value))) fail("BRIEF_INVALID", "market brief needs a title, body, and at least two HTTPS citations");
          }
          artifacts[manifest.capabilityId] = body.toString("base64url");
        }
        for (const [briefHash, artifactPath] of Object.entries(capability.variants ?? {})) {
          if (!/^[0-9a-f]{64}$/.test(briefHash)) fail("SELLER_CONFIG_INVALID", "variant brief hash is invalid");
          artifacts[`${manifest.capabilityId}:${briefHash}`] = readFileSync(resolve(artifactPath)).toString("base64url");
        }
        if (!capability.artifact && !Object.keys(capability.variants ?? {}).length) fail("SELLER_ARTIFACT_MISSING", "capability needs a prepared artifact or brief variants");
        const published = await executeMandated(app, loadMandate(seller.home), "capability.publish", { "operation-id": `publish-${manifest.manifestHash}`, manifest });
        const blobId = String(published.blobId ?? "");
        if (!blobId) fail("WALRUS_PUBLISH_FAILED", "capability publish returned no blob ID");
        const hashes: Record<string, string> = {};
        for (const [artifactKey, value] of Object.entries(artifacts)) if (artifactKey === manifest.capabilityId || artifactKey.startsWith(`${manifest.capabilityId}:`)) hashes[artifactKey.slice(manifest.capabilityId.length).replace(/^:/, "") || "default"] = createHash("sha256").update(Buffer.from(value, "base64url")).digest("hex");
        const preview = { ...capability.preview, artifactHashes: hashes };
        const transportPublicKey = app.store.getSecret("identity:x25519-public")?.toString("base64url") ?? fail("IDENTITY_MISSING", "seller transport key is missing");
        const signature = (await signer.signPersonalMessage(Buffer.from(`${manifest.manifestHash}:${transportPublicKey}`))).signature;
        await db.putCatalog({ seller_id: seller.sellerId, capability_id: manifest.capabilityId, manifest, blob_id: blobId, signature, transport_public_key: transportPublicKey, preview });
      }
      await db.putSnapshot(encryptSellerSnapshot(await captureSellerHome(seller.home, seller.sellerId, artifacts), key));
      process.stdout.write(`${JSON.stringify({ sellerId: seller.sellerId, capabilities: seller.capabilities.map((item) => item.manifest.capabilityId), status: "provisioned" })}\n`);
    } finally { app.close(); }
  }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "provision failed"}\n`); process.exitCode = 1; });
