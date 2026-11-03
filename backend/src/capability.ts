import { createHash } from "node:crypto";
import { isValidPersonalMessageSignature } from "@mysten/sui/verify";
import { Ajv, type ValidateFunction } from "ajv";
import { fail } from "./errors.js";

export type CapabilityRail = "x402" | "shielded";
export type JsonSchema = Readonly<Record<string, unknown>>;
const schemaCompiler = new Ajv({ strict: true, allErrors: false });
const compiledSchemas = new Map<string, { input: ValidateFunction; output: ValidateFunction }>();

export function validateCapabilityPayload(manifest: CapabilityManifest, direction: "input" | "output", value: unknown): void {
  validateCapabilityManifest(manifest);
  let compiled = compiledSchemas.get(manifest.manifestHash);
  if (!compiled) {
    try { compiled = { input: schemaCompiler.compile(manifest.inputSchema), output: schemaCompiler.compile(manifest.outputSchema) }; }
    catch (error) { return fail("CAPABILITY_SCHEMA_INVALID", "signed capability contains an invalid JSON Schema", error); }
    compiledSchemas.set(manifest.manifestHash, compiled);
  }
  if (!compiled[direction](value)) fail("CAPABILITY_PAYLOAD_INVALID", `${direction} does not match the signed capability schema`);
}
export interface SignedCapabilityRegistration {
  manifest: CapabilityManifest;
  manifestBlobId: string;
  transportPublicKey: string;
  sellerSignature: string;
}

export async function verifySignedCapability(registration: SignedCapabilityRegistration): Promise<void> {
  validateCapabilityManifest(registration.manifest);
  if (typeof registration.manifestBlobId !== "string" || !registration.manifestBlobId || typeof registration.transportPublicKey !== "string" || !registration.transportPublicKey || typeof registration.sellerSignature !== "string" || !registration.sellerSignature) fail("SELLER_SIGNATURE_INVALID", "signed capability registration is incomplete");
  const signed = Buffer.from(`${registration.manifest.manifestHash}:${registration.transportPublicKey}`);
  if (!(await isValidPersonalMessageSignature(signed, registration.sellerSignature, { address: registration.manifest.sellerId }))) fail("SELLER_SIGNATURE_INVALID", "seller did not sign the capability and transport key");
}

/** Framework-neutral service advertisement. This is not an A2A protocol claim. */
export interface CapabilityManifest {
  protocol: "supercuts.capability.v1";
  capabilityId: string;
  sellerId: string;
  capability: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  supportedRails: CapabilityRail[];
  priceBand: { minimum: string; maximum: string };
  asset: string;
  endpoint: string;
  expiresAt: number;
  manifestHash: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("CAPABILITY_INVALID", "capability manifests must be JSON-compatible");
  return encoded;
}

export function capabilityManifestHash(manifest: Omit<CapabilityManifest, "manifestHash">): string {
  return createHash("sha256").update(canonical({ domain: "supercuts-capability-v1", ...manifest })).digest("hex");
}

export function createCapabilityManifest(input: Omit<CapabilityManifest, "protocol" | "manifestHash">): CapabilityManifest {
  const unsigned = { protocol: "supercuts.capability.v1" as const, ...input };
  const manifest = { ...unsigned, manifestHash: capabilityManifestHash(unsigned) };
  validateCapabilityManifest(manifest);
  return manifest;
}

export function validateCapabilityManifest(value: unknown, now = Date.now()): asserts value is CapabilityManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CAPABILITY_INVALID", "capability manifest must be an object");
  const manifest = value as Partial<CapabilityManifest>;
  const allowed = new Set(["protocol", "capabilityId", "sellerId", "capability", "description", "inputSchema", "outputSchema", "supportedRails", "priceBand", "asset", "endpoint", "expiresAt", "manifestHash"]);
  if (Object.keys(manifest).some((key) => !allowed.has(key))) fail("CAPABILITY_INVALID", "capability manifest contains unknown fields");
  if (manifest.protocol !== "supercuts.capability.v1") fail("CAPABILITY_VERSION_UNSUPPORTED", "capability protocol must be supercuts.capability.v1");
  for (const field of ["capabilityId", "sellerId", "capability", "description", "asset", "endpoint", "manifestHash"] as const) {
    const item = manifest[field];
    if (typeof item !== "string" || !item || item.length > (field === "description" ? 4096 : 1024)) fail("CAPABILITY_INVALID", `${field} is missing or too long`);
  }
  if (!manifest.inputSchema || typeof manifest.inputSchema !== "object" || Array.isArray(manifest.inputSchema) || !manifest.outputSchema || typeof manifest.outputSchema !== "object" || Array.isArray(manifest.outputSchema)) fail("CAPABILITY_SCHEMA_INVALID", "inputSchema and outputSchema must be JSON Schema objects");
  if (Buffer.byteLength(canonical(manifest.inputSchema)) + Buffer.byteLength(canonical(manifest.outputSchema)) > 64 * 1024) fail("CAPABILITY_SCHEMA_INVALID", "capability schemas exceed 64 KiB");
  if (!Array.isArray(manifest.supportedRails) || !manifest.supportedRails.length || new Set(manifest.supportedRails).size !== manifest.supportedRails.length || manifest.supportedRails.some((rail) => rail !== "x402" && rail !== "shielded")) fail("CAPABILITY_RAIL_INVALID", "supportedRails must contain unique supported rails");
  if (!manifest.priceBand || !/^(?:0|[1-9][0-9]*)$/.test(manifest.priceBand.minimum) || !/^(?:0|[1-9][0-9]*)$/.test(manifest.priceBand.maximum) || BigInt(manifest.priceBand.minimum) > BigInt(manifest.priceBand.maximum)) fail("CAPABILITY_PRICE_INVALID", "priceBand must contain ordered unsigned integer strings");
  if (!Number.isSafeInteger(manifest.expiresAt) || manifest.expiresAt! <= now) fail("CAPABILITY_EXPIRED", "capability manifest is expired");
  let endpoint: URL; try { endpoint = new URL(manifest.endpoint!); } catch (error) { return fail("CAPABILITY_ENDPOINT_INVALID", "capability endpoint must be an absolute URL", error); }
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname))) fail("CAPABILITY_ENDPOINT_INVALID", "capability endpoint must use HTTPS except on loopback");
  if (endpoint.username || endpoint.password) fail("CAPABILITY_ENDPOINT_INVALID", "capability endpoint cannot contain credentials");
  const { manifestHash, ...unsigned } = manifest as CapabilityManifest;
  if (!/^[0-9a-f]{64}$/.test(manifestHash) || capabilityManifestHash(unsigned) !== manifestHash) fail("CAPABILITY_HASH_MISMATCH", "capability manifest hash does not match its canonical contents");
}
