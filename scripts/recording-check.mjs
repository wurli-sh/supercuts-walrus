#!/usr/bin/env node
// Read-only acceptance gate. Never runs a deal, requests funds, or queues an exit.
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: {
  "buyer-home": { type: "string" }, events: { type: "string" },
  "seller-id": { type: "string" }, "seller-home": { type: "string" },
  "timeout-ms": { type: "string", default: "90000" },
} });
if (!values["buyer-home"] || !values.events || (!values["seller-id"] && !values["seller-home"])) {
  console.error("usage: node [--env-file=.env] scripts/recording-check.mjs --buyer-home <home> --events <path> (--seller-id <id> | --seller-home <home>)");
  process.exit(2);
}
const timeout = Number(values["timeout-ms"]);
if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 300000) throw new Error("timeout-ms must be 1000..300000");
const home = resolve(values["buyer-home"]), checks = [];
function report(check, ok, code) {
  checks.push({ check, ok, ...(code ? { code } : {}) });
  console.log(JSON.stringify(checks.at(-1)));
}
try {
  const mandate = JSON.parse(readFileSync(join(home, "mandate.json"), "utf8"));
  const profile = JSON.parse(readFileSync(join(home, "profile.json"), "utf8"));
  const privatePaths = [home, values.events, join(home, "state.sqlite"), join(home, "state.key"), join(home, "mandate.json"), join(home, "deal-sellers.json")];
  if (privatePaths.some(p => (statSync(p).mode & 0o077) !== 0)) throw new Error("OWNER_ONLY_PERMISSIONS_REQUIRED");
  if (profile.mock || profile.role !== "buyer" || profile.verifierVersion !== 2 || mandate.version !== "supercuts.mandate.v2" || !mandate.allowedCommands.includes("deal.execute") || mandate.expiresAt <= Date.now()) throw new Error("ACTIVE_LIVE_V2_MANDATE_REQUIRED");
  report("buyer-config", true);
  const db = new DatabaseSync(join(home, "state.sqlite"), { readOnly: true });
  try {
    const events = readFileSync(values.events, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const ids = [...new Set(events.filter(event => event.stage === "deal-lifecycle" && event.publicDetails.state === "complete").map(event => event.publicDetails.dealId))];
    const find = db.prepare("SELECT m.status FROM deal_memory_outbox m JOIN deal_operations d ON d.operation_id=m.operation_id WHERE m.event_kind='outcome' AND d.deal_id=?");
    const indexed = ids.length >= 2 && ids.every(id => find.get(id)?.status === "indexed");
    report("outcome-memory", indexed, indexed ? undefined : "ALL_RECORDED_OUTCOMES_MUST_BE_INDEXED");
  } finally { db.close(); }
} catch (error) { report("buyer-config", false, error.code ?? error.message); }

async function command(check, args) {
  await new Promise(done => {
    const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "ignore"] });
    let output = "", expired = false;
    const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, timeout);
    child.stdout.on("data", chunk => { if (output.length < 1048576) output += chunk; });
    child.on("error", () => { clearTimeout(timer); report(check, false, "CHECK_START_FAILED"); done(); });
    child.on("close", code => {
      clearTimeout(timer);
      if (expired) report(check, false, "CHECK_TIMEOUT");
      else {
        let result;
        try { result = JSON.parse(output.trim().split("\n").at(-1)); } catch { /* bounded, safe failure */ }
        const ready = code === 0 && result?.ok === true && (check !== "funding-and-directory" || result.data?.readyForPublicPayment === true && result.data?.readyForShieldedPayment === true && result.data?.checks?.every(item => item.status === "ready"));
        report(check, ready, result?.error?.code ?? (ready ? undefined : "CHECK_NOT_READY"));
      }
      done();
    });
  });
}
// Independent read-only checks run together; report only status and stable codes.
async function dependencies() {
  const { Phase3App } = await import("../backend/dist/phase3.js");
  let app;
  try {
    app = new Phase3App(home);
    const config = JSON.parse(app.store.getSecret("live:memory-config")?.toString() ?? "{}");
    const base = new URL(config.embeddingApiBase);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new Error("LOCAL_EMBEDDINGS_REQUIRED");
    const response = await fetch(`${base.href.replace(/\/$/, "")}/embeddings`, { method: "POST", signal: AbortSignal.timeout(15000), headers: { "content-type": "application/json", Authorization: `Bearer ${config.embeddingApiKey}` }, body: JSON.stringify({ model: config.embeddingModel, input: "Supercuts recording readiness probe" }) });
    const data = await response.json();
    const ok = response.ok && data.data?.[0]?.embedding?.length === 1536;
    report("local-embeddings", ok, ok ? undefined : "EMBEDDING_1536_REQUIRED");
  } catch (error) { report("local-embeddings", false, error.code ?? "EMBEDDING_CHECK_FAILED"); }
  finally { app?.close(); }
  try {
    const response = await fetch(new URL("/supported", process.env.X402_FACILITATOR_URL ?? "https://supercuts-x402-facilitator-testnet.onrender.com"), { signal: AbortSignal.timeout(15000) });
    const data = await response.json(), ok = response.ok && JSON.stringify(data).includes('"exact"') && JSON.stringify(data).includes("sui:testnet");
    report("x402-facilitator", ok, ok ? undefined : "TESTNET_X402_REQUIRED");
  } catch { report("x402-facilitator", false, "FACILITATOR_UNREACHABLE"); }
}
await Promise.all([
  command("live-doctor", ["backend/dist/demo.js", "doctor", "--buyer-home", home]),
  command("funding-and-directory", ["backend/dist/cli.js", "onboarding", "doctor", "--home", home]),
  command("recorded-e2e", ["backend/dist/demo.js", "check", "--buyer-home", home, "--events", resolve(values.events), ...(values["seller-home"] ? ["--seller-home", resolve(values["seller-home"])] : ["--seller-id", values["seller-id"]])]),
  dependencies(),
]);
const ready = checks.length === 7 && checks.every(check => check.ok);
console.log(JSON.stringify({ readyForRecording: ready, checkedAt: new Date().toISOString(), checks }));
process.exitCode = ready ? 0 : 1;
