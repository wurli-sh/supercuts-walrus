#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fail } from "./errors.js";
import { HostedSellerRepository } from "./hosted-seller-repository.js";
import { Phase3App } from "./phase3.js";
import { SellerDatabase } from "./seller-database.js";
import { decryptSellerSnapshot, restoreSellerHome } from "./seller-state.js";

const required = (name: string): string => process.env[name] ?? fail("SELLER_CONFIG_MISSING", `${name} is required`);

async function main(): Promise<void> {
  if (process.argv[2] !== "--writes-paused") fail("SELLER_IMPORT_MAINTENANCE_REQUIRED", "pause hosted seller writes and pass --writes-paused");
  const legacy = new SellerDatabase(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"));
  const repo = new HostedSellerRepository(required("SUPABASE_DB_URL"), required("SELLER_STATE_KEY"));
  try {
    const catalog = await legacy.listCatalog();
    const sellerIds = [...new Set(catalog.map((row) => String(row.seller_id)))].sort();
    if (!sellerIds.length) fail("SELLER_STATE_MISSING", "catalog contains no hosted sellers");
    const claimsBefore = await legacy.listPaymentClaims();
    await repo.verifyLegacyCollections(catalog, claimsBefore);
    const results: Array<Record<string, unknown>> = [];
    const revisions = new Map<string, number>();
    for (const sellerId of sellerIds) {
      const stored = await legacy.getSnapshot(sellerId) ?? fail("SELLER_STATE_MISSING", `snapshot is missing for ${sellerId}`);
      revisions.set(sellerId, stored.revision);
      const snapshot = decryptSellerSnapshot(stored.payload, required("SELLER_STATE_KEY"));
      const root = mkdtempSync(join(tmpdir(), "supercuts-seller-verify-")), home = join(root, "seller");
      let app: Phase3App | undefined;
      try {
        restoreSellerHome(home, snapshot);
        app = new Phase3App(home);
        if (app.profile.mock || app.profile.role !== "seller") fail("LIVE_PROFILE_REQUIRED", "import requires a live seller profile");
        const encoded = app.store.getSecret("live:sui-private-key")?.toString() ?? fail("LIVE_CREDENTIAL_MISSING", "seller signer is missing");
        const decoded = decodeSuiPrivateKey(encoded);
        if (decoded.scheme !== "ED25519" || Ed25519Keypair.fromSecretKey(decoded.secretKey).toSuiAddress().toLowerCase() !== sellerId.toLowerCase()) fail("SELLER_IDENTITY_MISMATCH", "snapshot signer differs from catalog seller");
      } finally { app?.close(); rmSync(root, { recursive: true, force: true }); }
      const imported = await repo.importSnapshot(snapshot, stored.revision);
      const verified = await repo.verifyImport(sellerId);
      if (verified.sourceHash !== imported.sourceHash || Object.values(verified.records).reduce((sum, count) => sum + count, 0) !== imported.records || verified.artifacts !== imported.artifacts) fail("SELLER_IMPORT_MISMATCH", "seller readback differs from source snapshot");
      results.push({ sellerId, capabilities: catalog.filter((row) => row.seller_id === sellerId).length, records: imported.records, artifacts: imported.artifacts, rowTypes: verified.records });
    }
    const claimsAfter = await legacy.listPaymentClaims();
    if (JSON.stringify(claimsBefore) !== JSON.stringify(claimsAfter)) fail("SELLER_IMPORT_MISMATCH", "payment claims changed during migration");
    if (JSON.stringify(catalog) !== JSON.stringify(await legacy.listCatalog())) fail("SELLER_IMPORT_MISMATCH", "catalog changed during migration");
    await repo.verifyLegacyCollections(catalog, claimsAfter);
    for (const sellerId of sellerIds) {
      const current = await legacy.getSnapshot(sellerId);
      if (!current || current.revision !== revisions.get(sellerId)) fail("SELLER_IMPORT_MISMATCH", "seller snapshot changed during migration");
    }
    process.stdout.write(`${JSON.stringify({ ok: true, sellers: results, paymentClaims: claimsAfter.length, serviceCutoverReady: false })}\n`);
  } finally { await repo.close(); }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "seller import failed"}\n`); process.exitCode = 1; });
