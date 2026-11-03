import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DealEngine, type DealPorts } from "./deal-engine.js";
import { DealJournal } from "./deal.js";
import { fail } from "./errors.js";
import { loadMandate, type AgentMandate } from "./mandate.js";
import type { Phase3App } from "./phase3.js";
import { LiveDealPorts } from "./live-deal-ports.js";

export async function createConfiguredDealEngine(app: Phase3App): Promise<DealEngine> {
  if (app.profile.role !== "buyer" || app.profile.mock) fail("DEAL_LIVE_REQUIRED", "composite deals require a live buyer role home");
  const mandate = loadMandate(app.home);
  if (mandate.version !== "supercuts.mandate.v2") fail("DEAL_MANDATE_VERSION", "composite deals require an owner-issued v2 mandate");
  if (!mandate.allowedCommands.includes("deal.execute")) fail("MANDATE_COMMAND_FORBIDDEN", "owner mandate does not allow composite deal execution");
  const path = join(app.home, "deal-ports.mjs");
  if (!existsSync(path)) {
    if (!app.store.getSecret("live:memory-config")) fail("LIVE_MEMORY_CONFIG_MISSING", "live composite deals require an owner-only Walrus Memory configuration");
    return new DealEngine(new DealJournal(app.store), new LiveDealPorts(app, mandate), mandate);
  }
  if ((statSync(path).mode & 0o077) !== 0) fail("DEAL_PORTS_PERMISSIONS", "deal ports adapter must be owner-only");
  let loaded: { createDealPorts?: (app: Phase3App, mandate: AgentMandate) => Promise<DealPorts> | DealPorts };
  try { loaded = await import(pathToFileURL(path).href) as typeof loaded; }
  catch (error) { return fail("DEAL_PORTS_LOAD_FAILED", "owner deal ports adapter could not load", error); }
  if (typeof loaded.createDealPorts !== "function") return fail("DEAL_PORTS_INVALID", "owner adapter must export createDealPorts");
  const ports = await loaded.createDealPorts(app, mandate);
  for (const method of ["readBlob", "discover", "plan", "negotiate", "pay", "deliver", "rememberOutcome", "inventory"] as const) if (typeof ports?.[method] !== "function") fail("DEAL_PORTS_INVALID", `owner adapter is missing ${method}`);
  return new DealEngine(new DealJournal(app.store), ports, mandate);
}
