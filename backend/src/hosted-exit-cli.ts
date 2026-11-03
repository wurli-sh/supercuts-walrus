#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DemoEventLog, readDemoEvents } from "./events.js";
import { fail } from "./errors.js";
import { queueHostedExit } from "./hosted-exit.js";
import { errorOutput, parseArgs } from "./phase3.js";
import { SellerDatabase } from "./seller-database.js";

async function main(): Promise<Record<string, unknown>> {
  const args = parseArgs(process.argv.slice(2));
  const required = (name: string): string => typeof args[name] === "string" ? args[name] : fail("ARGUMENT_REQUIRED", `--${name} is required`);
  const secret = (name: string): string => process.env[name] ?? fail("SELLER_CONFIG_MISSING", `${name} is required in the owner environment`);
  const runPath = resolve(required("run-json"));
  if ((statSync(runPath).mode & 0o077) !== 0) fail("DEMO_PERMISSIONS", "run.json must be owner-only");
  const run = JSON.parse(readFileSync(runPath, "utf8")) as { runId?: string; eventPath?: string; addresses?: { confidentialSeller?: string } };
  const runId = run.runId || fail("DEMO_RUN_INVALID", "run.json is missing runId"), eventPath = run.eventPath || fail("DEMO_RUN_INVALID", "run.json is missing the event path"), sellerId = run.addresses?.confidentialSeller || fail("DEMO_RUN_INVALID", "run.json is missing the confidential seller");
  const path = resolve(eventPath);
  if (!existsSync(path) || (statSync(path).mode & 0o077) !== 0) fail("DEMO_EVENTS_MISSING", "owner-only buyer event stream must exist before seller exit");
  const events = readDemoEvents(path);
  if (!events.length || events.some((event) => event.runId !== runId)) fail("DEMO_EVENTS_INVALID", "event stream belongs to another run");
  const sessionId = required("session-id");
  if (!events.some((event) => event.stage === "artifact-delivery" && event.status === "complete" && event.publicDetails.kind === "competitor-analysis" && event.publicDetails.sessionId === sessionId)) fail("DEMO_DELIVERY_MISSING", "buyer has not recorded the confidential artifact delivery for this session");
  const windowStart = Number(required("window-start")), windowEnd = Number(required("window-end"));
  if (!Number.isSafeInteger(windowStart) || !Number.isSafeInteger(windowEnd) || windowEnd <= windowStart || windowEnd - windowStart > 7 * 24 * 60 * 60_000) fail("EXIT_WINDOW_INVALID", "owner exit window must be valid and last no more than seven days");
  const db = new SellerDatabase(secret("SUPABASE_URL"), secret("SUPABASE_SERVICE_ROLE_KEY"));
  const queued = await queueHostedExit(db, secret("SELLER_STATE_KEY"), { sellerId, runId, sessionId, windowStart, windowEnd });
  if (!events.some((event) => event.actor === "confidential-seller" && event.stage === "delayed-exit" && event.publicDetails.operationId === queued.operationId)) {
    new DemoEventLog(path, runId).append({ actor: "confidential-seller", stage: "delayed-exit", status: "complete", publicDetails: { state: "queued", sessionId, operationId: queued.operationId, amount: queued.amount, executeAt: queued.executeAt, windowEnd: queued.windowEnd }, evidenceHashes: [], explorerLinks: [] });
  }
  return { runId, eventPath: path, sessionId, sellerId: queued.sellerId, operationId: queued.operationId, status: queued.status, amount: queued.amount, executeAt: queued.executeAt, windowEnd: queued.windowEnd };
}

main().then((data) => process.stdout.write(`${JSON.stringify({ schemaVersion: "supercuts.demo.v1", ok: true, command: "hosted-exit", data })}\n`)).catch((error) => { process.stdout.write(`${JSON.stringify(errorOutput(error))}\n`); process.exitCode = 1; });
