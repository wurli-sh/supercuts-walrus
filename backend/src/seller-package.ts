import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { createCapabilityManifest, validateCapabilityPayload, type CapabilityManifest } from "./capability.js";
import { fail } from "./errors.js";
import { executeMandated, loadMandate } from "./mandate.js";
import { Phase3App } from "./phase3.js";

const ownerFile = (path: string): string => {
  const value = resolve(path);
  if ((statSync(value).mode & 0o077) !== 0) fail("SELLER_CONFIG_PERMISSIONS", `${value} must be owner-only`);
  return value;
};

export async function packageHostedSeller(input: { home: string; spec: string; artifact: string; metadata: string; registration: string; bundle: string; contentType?: string }): Promise<Record<string, unknown>> {
  if (![input.home, input.spec, input.artifact, input.metadata, input.registration, input.bundle].every((value) => typeof value === "string" && value.length > 0)) fail("ARGUMENT_REQUIRED", "seller package requires --home, --spec, --artifact, --metadata, --registration, and --bundle");
  const specPath = ownerFile(input.spec), artifactPath = ownerFile(input.artifact), metadataPath = ownerFile(input.metadata);
  const artifact = readFileSync(artifactPath);
  if (!artifact.length || artifact.length > 10 * 1024 * 1024) fail("SELLER_ARTIFACT_INVALID", "hosted artifact must contain 1 byte to 10 MiB");
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as Omit<CapabilityManifest, "protocol" | "manifestHash" | "sellerId">;
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  const home = resolve(input.home), app = new Phase3App(home);
  try {
    if (app.profile.role !== "seller" || app.profile.mock || app.profile.verifierVersion !== 2) fail("SELLER_POOL_VERSION_MISMATCH", "hosted packaging requires a separate live v2 seller role home");
    const encoded = app.store.getSecret("live:sui-private-key")?.toString() ?? fail("LIVE_CREDENTIAL_MISSING", "seller signer is missing");
    const decoded = decodeSuiPrivateKey(encoded); if (decoded.scheme !== "ED25519") fail("SIGNER_UNSUPPORTED", "seller requires an ED25519 signer");
    const signer = Ed25519Keypair.fromSecretKey(decoded.secretKey), manifest = createCapabilityManifest({ ...spec, sellerId: signer.toSuiAddress() });
    validateCapabilityPayload(manifest, "output", metadata);
    const published = await executeMandated(app, loadMandate(home), "capability.publish", { "operation-id": `publish-${manifest.manifestHash}`, manifest });
    const manifestBlobId = String(published.blobId ?? ""); if (!manifestBlobId) fail("WALRUS_PUBLISH_FAILED", "capability publication omitted a Walrus blob ID");
    const transportPublicKey = app.store.getSecret("identity:x25519-public")?.toString("base64url") ?? fail("IDENTITY_MISSING", "seller transport key is missing");
    const sellerSignature = (await signer.signPersonalMessage(Buffer.from(`${manifest.manifestHash}:${transportPublicKey}`))).signature;
    const registration = { manifest, manifestBlobId, transportPublicKey, sellerSignature };
    const registrationPath = resolve(input.registration), bundlePath = resolve(input.bundle);
    writeFileSync(registrationPath, `${JSON.stringify(registration, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const bundle = { sellers: [{ sellerId: manifest.sellerId, home, capabilities: [{ registrationFile: registrationPath, artifactFile: artifactPath, outputMetadata: metadata, contentType: input.contentType ?? "application/octet-stream" }] }] };
    writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    return { sellerId: manifest.sellerId, capabilityId: manifest.capabilityId, manifestHash: manifest.manifestHash, manifestBlobId, registrationFile: registrationPath, provisioningBundle: bundlePath, nextCommand: `supercuts-seller-v2-provision ${JSON.stringify(bundlePath)}` };
  } finally { app.close(); }
}
