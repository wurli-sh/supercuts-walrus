#!/usr/bin/env node
import { fail } from "./errors.js";
import { parseArgs } from "./phase3.js";

const args = parseArgs(process.argv.slice(2));
const required = (name: string): string => typeof args[name] === "string" ? args[name] : fail("ARGUMENT_REQUIRED", `--${name} is required`);
const origin = new URL(required("seller-url")), sellerId = required("seller-id"), runId = required("run-id");
if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(origin.hostname))) fail("SELLER_ORIGIN_INVALID", "seller URL must use HTTPS except on loopback");
let stopped = false, seen = 0;
process.on("SIGINT", () => { stopped = true; }); process.on("SIGTERM", () => { stopped = true; });
const line = (value: string) => process.stdout.write(`${value}\n`);
try {
  const catalogResponse = await fetch(new URL("/v1/catalog", origin), { signal: AbortSignal.timeout(90_000) });
  if (!catalogResponse.ok) fail("SELLER_SERVICE_UNAVAILABLE", `catalog returned ${catalogResponse.status}`);
  const catalog = await catalogResponse.json() as { capabilities?: Array<{ manifest: { sellerId: string; capabilityId: string; description: string } }> };
  const offered = catalog.capabilities?.filter((item) => item.manifest.sellerId === sellerId).map((item) => item.manifest.capabilityId) ?? [];
  if (!offered.length) fail("SELLER_ID_UNKNOWN", "seller does not appear in the remote catalog");
  line(`[${sellerId.slice(0, 10)}] online · ${offered.join(", ")}`);
  while (!stopped) {
    try {
      const response = await fetch(new URL(`/v1/events?runId=${encodeURIComponent(runId)}`, origin), { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`events returned ${response.status}`);
      const body = await response.json() as { events?: Array<{ seller_id: string; stage: string; status: string; details: Record<string, unknown>; created_at: string }> };
      const events = body.events ?? [];
      for (const event of events.slice(seen)) if (event.seller_id === sellerId) {
        const details = event.details ?? {}, summary = [details.capabilityId, details.sessionId, details.transcriptHash, details.artifactSha256].filter((item): item is string => typeof item === "string").map((item) => item.length > 18 ? `${item.slice(0, 18)}…` : item).join(" · ");
        line(`${event.created_at}  ${event.stage}  ${event.status}${summary ? `  ${summary}` : ""}`);
      }
      seen = events.length;
    } catch (error) { line(`waiting for seller events: ${error instanceof Error ? error.message : "connection failed"}`); }
    await new Promise((done) => setTimeout(done, 2000));
  }
} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "seller watch failed"}\n`); process.exitCode = 1; }
