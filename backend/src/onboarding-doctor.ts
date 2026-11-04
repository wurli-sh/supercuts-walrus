import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { verifySignedCapability, type SignedCapabilityRegistration } from "./capability.js";
import { fail } from "./errors.js";
import { loadMandate } from "./mandate.js";
import { Phase3App } from "./phase3.js";
import { writeClient } from "./sui.js";

async function json(url: URL): Promise<Record<string, unknown>> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) fail("ONBOARDING_SERVICE_UNAVAILABLE", `${url.origin} returned HTTP ${response.status}`);
  const result = await response.json() as unknown;
  if (!result || typeof result !== "object" || Array.isArray(result)) fail("ONBOARDING_SERVICE_INVALID", `${url.origin} returned invalid JSON`);
  return result as Record<string, unknown>;
}

export async function onboardingDoctor(home: string, sellerConfig?: string): Promise<Record<string, unknown>> {
  const app = new Phase3App(home);
  try {
    if (app.profile.mock) fail("LIVE_PROFILE_REQUIRED", "onboarding doctor requires a live Testnet role home");
    const runtime = await app.execute("doctor", {});
    if (runtime.data.readyForDemo === false) fail("ONBOARDING_RUNTIME_NOT_READY", "live runtime doctor reports missing prerequisites");
    if (app.profile.role === "buyer") {
      const mandate = loadMandate(home);
      if (mandate.version !== "supercuts.mandate.v2") fail("DEAL_MANDATE_VERSION", "buyer needs a v2 standing mandate");
      if (JSON.stringify([...mandate.allowedCounterparties].sort()) !== JSON.stringify([...app.profile.policy.allowedCounterparties].sort())) fail("POLICY_COUNTERPARTY_MISMATCH", "buyer mandate and payment profile allow different sellers");
      const path = join(home, "deal-sellers.json");
      if ((statSync(path).mode & 0o077) !== 0) fail("DEAL_SELLERS_PERMISSIONS", "buyer catalog config must be owner-only");
      const source = JSON.parse(readFileSync(path, "utf8")) as string[] | { directoryUrl?: string; origins?: string[] };
      const directoryUrl = Array.isArray(source) ? undefined : source.directoryUrl;
      let directoryListings: number | undefined;
      if (directoryUrl) {
        const health = await json(new URL("/v2/directory/health", directoryUrl!));
        if (health.ok !== true) fail("SELLER_DIRECTORY_UNAVAILABLE", "directory health check failed");
        directoryListings = Number(health.listings);
      }
      const endpoint = app.profile.live?.writeGrpcEndpoint ?? fail("LIVE_PROFILE_INVALID", "buyer write RPC is missing");
      const signer = String(runtime.data.signer ?? "");
      const { balance } = await writeClient(endpoint).getBalance({ owner: signer, coinType: "0x2::sui::SUI" });
      return { role: "buyer", healthy: true, runtime: runtime.data, approvedSellers: mandate.allowedCounterparties.length, nativeSuiMist: String(balance.balance), funded: BigInt(balance.balance) > 0n, ...(directoryListings !== undefined ? { directoryListings } : {}) };
    }
    if (app.profile.role === "seller") {
      if (!sellerConfig) fail("ARGUMENT_REQUIRED", "seller doctor requires --config <owner-only-seller-config.json>");
      const path = resolve(sellerConfig!);
      if ((statSync(path).mode & 0o077) !== 0) fail("SELLER_CONFIG_PERMISSIONS", "seller config must be owner-only");
      const config = JSON.parse(readFileSync(path, "utf8")) as { origin: string; capabilities: Array<{ registrationFile: string }> };
      if (!Array.isArray(config.capabilities) || !config.capabilities.length) fail("SELLER_CONFIG_INVALID", "seller has no registered capabilities");
      const served = await json(new URL("/v2/catalog", config.origin));
      if (!Array.isArray(served.capabilities)) fail("SELLER_CATALOG_INVALID", "seller endpoint has no valid catalog");
      for (const item of config.capabilities) {
        const registrationPath = resolve(item.registrationFile);
        if ((statSync(registrationPath).mode & 0o077) !== 0) fail("SELLER_CONFIG_PERMISSIONS", "registration file must be owner-only");
        const registration = JSON.parse(readFileSync(registrationPath, "utf8")) as SignedCapabilityRegistration;
        await verifySignedCapability(registration);
        if (!(served.capabilities as unknown[]).some((entry: unknown) => JSON.stringify(entry) === JSON.stringify(registration))) fail("SELLER_CATALOG_INVALID", "seller endpoint does not serve its configured registration");
      }
      return { role: "seller", healthy: true, runtime: runtime.data, capabilities: config.capabilities.length, origin: config.origin };
    }
    return fail("ROLE_FORBIDDEN", "onboarding doctor supports buyer and seller homes");
  } finally { app.close(); }
}
