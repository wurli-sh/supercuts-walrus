import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { verifySignedCapability, type SignedCapabilityRegistration } from "./capability.js";
import { fail } from "./errors.js";
import { canonicalJson } from "./settlement.js";
import type { SellerDatabase } from "./seller-database.js";

function publicAddress(address: string): boolean {
  if (address.includes(":")) return !/^(::|::1$|fc|fd|fe80:|2001:db8:)/i.test(address) && !address.startsWith("::ffff:");
  const octets = address.split(".").map(Number);
  return octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && octets[0] !== 0 && octets[0] !== 10 && octets[0] !== 127 && octets[0]! < 224
    && !(octets[0] === 169 && octets[1] === 254) && !(octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
    && !(octets[0] === 192 && octets[1] === 168) && !(octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127);
}

export async function validateDirectoryOrigin(endpoint: string, allowLoopback = false): Promise<URL> {
  const url = new URL(endpoint);
  if (url.username || url.password || url.hash || url.search || url.port && url.port !== "443" && !allowLoopback) fail("SELLER_ENDPOINT_UNSAFE", "directory endpoint has credentials, query, fragment, or nonstandard port");
  if (allowLoopback && url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return url;
  if (url.protocol !== "https:" || url.hostname === "localhost" || url.hostname.endsWith(".localhost")) fail("SELLER_ENDPOINT_UNSAFE", "directory endpoint must use a public HTTPS origin");
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) fail("SELLER_ENDPOINT_UNSAFE", "directory endpoint resolves to a nonpublic address");
  return url;
}

/** The directory stores signed public metadata, never a seller role home. */
export async function registerDirectoryCapability(db: Pick<SellerDatabase, "putDirectory">, registration: SignedCapabilityRegistration, aggregator: string, http: typeof fetch = fetch, allowLoopback = false): Promise<void> {
  await verifySignedCapability(registration);
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(registration.manifestBlobId)) fail("WALRUS_BLOB_INVALID", "directory registration has an invalid Walrus blob ID");
  const endpoint = await validateDirectoryOrigin(registration.manifest.endpoint, allowLoopback);
  const read = async (url: URL, limit: number) => {
    const response = await http(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) fail("SELLER_DIRECTORY_UNAVAILABLE", `registration verification returned HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > limit) fail("SELLER_DIRECTORY_INVALID", "registration verification response is too large");
    return JSON.parse(bytes.toString()) as unknown;
  };
  const blob = await read(new URL(`/v1/blobs/${encodeURIComponent(registration.manifestBlobId)}`, aggregator), 128 * 1024);
  if (canonicalJson(blob) !== canonicalJson(registration.manifest)) fail("CAPABILITY_BLOB_MISMATCH", "Walrus manifest differs from the signed registration");
  const catalog = await read(new URL("/v2/catalog", endpoint.origin), 512 * 1024) as { capabilities?: unknown[] };
  if (!Array.isArray(catalog.capabilities) || catalog.capabilities.length > 100 || !catalog.capabilities.some((item) => canonicalJson(item) === canonicalJson(registration)))
    fail("SELLER_DIRECTORY_UNAVAILABLE", "seller endpoint does not serve the exact signed registration");
  await db.putDirectory(registration);
}
