#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { DemoEventLog, readDemoEvents, recordedReplay } from "./events.js";
import { Phase3App, errorOutput, initialize, parseArgs } from "./phase3.js";
import { serveEventDashboard } from "./dashboard.js";
import { fail } from "./errors.js";
import { validateCapabilityManifest, type CapabilityManifest } from "./capability.js";
import { deterministicCounteroffer } from "./procurement.js";
import { BoundedClaude } from "./claude.js";
import { loadMandate } from "./mandate.js";
import { LiveDealPorts } from "./live-deal-ports.js";
import { DealJournal } from "./deal.js";
import { V2ExitQueue } from "./v2-exits.js";

const [command = "", ...words] = process.argv.slice(2), args = parseArgs(words);
const value = (name: string, fallback?: string): string => typeof args[name] === "string" ? args[name] : fallback ?? fail("ARGUMENT_REQUIRED", `--${name} is required`);
const stateDir = (): string => resolve(value("state-dir", ".supercuts-demo"));
const homes = (root: string) => ({ buyer: join(root, "buyer"), publicSeller: join(root, "public-seller"), secondPublicSeller: join(root, "second-public-seller"), confidentialSeller: join(root, "confidential-seller"), auditor: join(root, "auditor") });
const send = (data: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ schemaVersion: "supercuts.demo.v1", ok: true, command, data })}\n`);

function keyAddress(path: string): string { const decoded = decodeSuiPrivateKey(readFileSync(path, "utf8").trim()); if (decoded.scheme !== "ED25519") fail("SIGNER_UNSUPPORTED", "demo requires ED25519 Sui keys"); return Ed25519Keypair.fromSecretKey(decoded.secretKey).toSuiAddress(); }
function createKey(path: string): void { if (!existsSync(path)) writeFileSync(path, Ed25519Keypair.generate().getSecretKey(), { mode: 0o600 }); chmodSync(path, 0o600); }

async function setup(): Promise<Record<string, unknown>> {
  const root = stateDir(), roles = homes(root); mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
  const mock = args.mock === true, secrets = join(root, "secrets"); mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const keys = { buyer: join(secrets, "buyer.sui.key"), publicSeller: join(secrets, "public-seller.sui.key"), secondPublicSeller: join(secrets, "second-public-seller.sui.key"), confidentialSeller: join(secrets, "confidential-seller.sui.key"), auditor: join(secrets, "auditor.sui.key") };
  for (const path of Object.values(keys)) createKey(path);
  const addresses = Object.fromEntries(Object.entries(keys).map(([name, path]) => [name, keyAddress(path)]));
  const common: Record<string, string | boolean> = mock ? { mock: true } : { "deployment-config": resolve(value("deployment-config")), "tatum-key-file": resolve(value("tatum-key-file")), "write-grpc": value("write-grpc"), "tatum-grpc": value("tatum-grpc"), "walrus-publisher": value("walrus-publisher"), "walrus-aggregator": value("walrus-aggregator"), ...(typeof args.rapidsnark === "string" ? { rapidsnark: resolve(args.rapidsnark) } : {}) };
  const roleInputs: Array<[keyof typeof roles, "buyer" | "seller" | "auditor", string]> = [["buyer", "buyer", keys.buyer], ["publicSeller", "seller", keys.publicSeller], ["secondPublicSeller", "seller", keys.secondPublicSeller], ["confidentialSeller", "seller", keys.confidentialSeller], ["auditor", "auditor", keys.auditor]];
  for (const [name, role, key] of roleInputs) {
    if (existsSync(join(roles[name], "profile.json"))) continue;
    initialize(roles[name], { role, ...common, ...(!mock ? { "sui-key-file": key } : {}), ...(role === "buyer" ? { "allow-counterparty": `${addresses.publicSeller},${addresses.secondPublicSeller},${addresses.confidentialSeller}`, ...(typeof args["memory-config-file"] === "string" ? { "memory-config-file": resolve(args["memory-config-file"]) } : {}), ...(typeof args["max-memory-distance"] === "string" ? { "max-memory-distance": args["max-memory-distance"] } : {}) } : {}) });
  }
  const workflowPath = typeof args.workflow === "string" ? resolve(args.workflow) : !mock && typeof args["seller-url"] !== "string" ? resolve(value("workflow")) : undefined;
  if (workflowPath) {
    const workflow = JSON.parse(readFileSync(workflowPath, "utf8")) as { capabilities?: CapabilityManifest[] }, capabilities = workflow.capabilities ?? [];
    if (!capabilities.length) fail("DEMO_CAPABILITIES_REQUIRED", "live workflow must provide capability manifests for the buyer mandate"); for (const manifest of capabilities) validateCapabilityManifest(manifest);
    const mandatePath = join(roles.buyer, "mandate.json"), mandate = JSON.parse(readFileSync(mandatePath, "utf8")) as Record<string, unknown>;
    mandate.requireSettlementPlan = true; mandate.allowedCommands = [...new Set([...(Array.isArray(mandate.allowedCommands) ? mandate.allowedCommands as string[] : []), "settlement.plan"])]; mandate.allowedCapabilityIds = [...new Set(capabilities.map((item) => item.capabilityId))]; mandate.allowedCapabilityClasses = [...new Set(capabilities.map((item) => item.capability))]; mandate.allowedRails = [...new Set(capabilities.flatMap((item) => item.supportedRails))];
    writeFileSync(mandatePath, `${JSON.stringify(mandate, null, 2)}\n`, { mode: 0o600 }); chmodSync(mandatePath, 0o600);
  }
  const mcpScript = join(dirname(fileURLToPath(import.meta.url)), "mcp.js");
  const mcp = { mcpServers: Object.fromEntries(Object.entries(roles).map(([name, home]) => [`supercuts-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, { command: process.execPath, args: [mcpScript], env: { SUPERCUTS_HOME: home } }])) };
  writeFileSync(join(root, "mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`, { mode: 0o600 });
  const runId = randomUUID(), eventPath = join(root, `events-${runId}.jsonl`);
  if (typeof args["seller-url"] === "string") {
    const sellerUrl = new URL(args["seller-url"]);
    if (sellerUrl.protocol !== "https:" && !(sellerUrl.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(sellerUrl.hostname))) fail("SELLER_ORIGIN_INVALID", "seller URL must use HTTPS except on loopback");
    const codex = `[mcp_servers.supercuts-buyer]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([mcpScript])}\n[mcp_servers.supercuts-buyer.env]\nSUPERCUTS_HOME = ${JSON.stringify(roles.buyer)}\nSUPERCUTS_SELLER_URL = ${JSON.stringify(sellerUrl.toString())}\nSUPERCUTS_RUN_ID = ${JSON.stringify(runId)}\nSUPERCUTS_EVENT_PATH = ${JSON.stringify(eventPath)}\n`;
    writeFileSync(join(root, "buyer-codex.toml"), codex, { mode: 0o600 });
  }
  const remote = typeof args["seller-url"] === "string";
  writeFileSync(join(root, "run.json"), `${JSON.stringify({ schema: "supercuts.demo.run.v1", createdAt: new Date().toISOString(), runId, ...(remote ? { eventPath } : {}), mock, homes: roles, addresses }, null, 2)}\n`, { mode: 0o600 });
  return { stateDir: root, mock, funding: mock ? [] : [{ address: addresses.buyer, needs: ["Testnet SUI gas", "configured x402 asset", "shielded deposit value"] }], sellerPayTo: addresses.publicSeller, sellerAddresses: { publicA: addresses.publicSeller, publicB: addresses.secondPublicSeller, analysis: addresses.confidentialSeller }, files: { mcp: join(root, "mcp.json"), run: join(root, "run.json"), events: remote ? eventPath : join(root, "events.jsonl"), ...(remote ? { codex: join(root, "buyer-codex.toml") } : {}) } };
}

async function doctor(): Promise<Record<string, unknown>> {
  if (typeof args["buyer-home"] === "string") {
    const home = resolve(args["buyer-home"]), app = new Phase3App(home);
    try {
      if (app.profile.role !== "buyer" || app.profile.mock || app.profile.verifierVersion !== 2) fail("LIVE_PROFILE_REQUIRED", "generic Codex doctor requires a live v2 buyer");
      const mandate = loadMandate(home), buyer = (await app.execute("doctor", {})).data;
      const catalog = await new LiveDealPorts(app, mandate).catalog();
      if (!catalog.length) fail("SELLER_CATALOG_EMPTY", "configured seller origins have no allowed signed v2 capability");
      return { healthy: true, buyer, sellerCapabilities: catalog.map(({ registration }) => registration.manifest.capabilityId) };
    } finally { app.close(); }
  }
  const roles = homes(stateDir()), reports: Record<string, unknown> = {};
  for (const [name, home] of Object.entries(roles)) { const app = new Phase3App(home); try { reports[name] = (await app.execute("doctor", {})).data; } finally { app.close(); } }
  let remote: Record<string, unknown> | undefined;
  if (typeof args["seller-url"] === "string") {
    const base = new URL(args["seller-url"]), health = await fetch(new URL("/health", base), { signal: AbortSignal.timeout(90_000) }), catalog = await fetch(new URL("/v1/catalog", base), { signal: AbortSignal.timeout(30_000) });
    if (!health.ok || !catalog.ok) fail("SELLER_SERVICE_UNAVAILABLE", "remote seller health or catalog check failed");
    const body = await catalog.json() as { capabilities?: Array<{ manifest?: CapabilityManifest }> }, capabilities = body.capabilities ?? [];
    if (capabilities.filter((item) => item.manifest?.capability === "sui.market-brief").length < 2 || !capabilities.some((item) => item.manifest?.capability === "sui.competitor-analysis")) fail("SELLER_CATALOG_INVALID", "remote catalog needs two briefs and one competitor analysis");
    remote = { healthy: true, origin: base.origin, capabilities: capabilities.length };
  }
  return { healthy: true, roles: reports, isolation: new Set(Object.values(roles)).size === 5, ...(remote ? { remote } : {}) };
}

async function seedPolicy(): Promise<Record<string, unknown>> {
  const source = JSON.parse(readFileSync(resolve(value("workflow")), "utf8")) as { capabilities?: CapabilityManifest[] };
  const manifest = source.capabilities?.find((item) => item.capability === "sui.competitor-analysis") ?? fail("DEMO_POLICY_SCOPE_INVALID", "workflow has no competitor analysis capability");
  validateCapabilityManifest(manifest);
  if (manifest.capability !== "sui.competitor-analysis") fail("DEMO_POLICY_SCOPE_INVALID", "privacy policy must target the competitor analysis capability");
  const app = new Phase3App(homes(stateDir()).buyer);
  try {
    if (app.profile.mock) fail("LIVE_PROFILE_REQUIRED", "saved demo privacy policy requires a live buyer profile");
    const memory = { version: "supercuts.settlement-memory.v1", kind: "privacy_rule", scope: { capabilityId: manifest.capabilityId, counterparty: manifest.sellerId, network: "sui:testnet", asset: manifest.asset }, createdAt: Date.now(), signal: { requiresShielded: true } };
    const parameters = { "operation-id": value("operation-id", `privacy-${manifest.capabilityId}`), memory: Buffer.from(JSON.stringify(memory)).toString("base64url") };
    const token = app.approve(app.preview("memory.policy", parameters).challengeId);
    const result = (await app.execute("memory.policy", { ...parameters, "approval-token": token.token })).data;
    return { capabilityId: manifest.capabilityId, sellerId: manifest.sellerId, blobId: result.blobId, kind: result.kind, provenance: result.provenance };
  } finally { app.close(); }
}

function check(): Record<string, unknown> {
  if (typeof args["buyer-home"] === "string") {
    const home = resolve(args["buyer-home"]), sellerHome = resolve(value("seller-home")), path = resolve(value("events"));
    if (!existsSync(home) || (statSync(home).mode & 0o077) !== 0 || !existsSync(sellerHome) || (statSync(sellerHome).mode & 0o077) !== 0 || !existsSync(path) || (statSync(path).mode & 0o077) !== 0) fail("DEMO_PERMISSIONS", "generic role homes and event stream must be owner-only");
    const profile = JSON.parse(readFileSync(join(home, "profile.json"), "utf8")) as { role?: string; mock?: boolean; verifierVersion?: number };
    if (profile.role !== "buyer" || profile.mock || profile.verifierVersion !== 2) fail("LIVE_PROFILE_REQUIRED", "generic Codex demo requires a live v2 buyer home");
    const raw = readFileSync(path, "utf8");
    if (/(?:suiprivkey|BEGIN [A-Z ]*PRIVATE KEY|approval.?token|note.?opening|full.?prompt)/i.test(raw)) fail("SECRET_SCAN_FAILED", "event bundle contains forbidden secret material");
    const events = readDemoEvents(path), deals = events.filter((event) => event.stage === "deal-lifecycle" && event.status === "complete" && event.publicDetails.state === "complete");
    const rails = new Map(deals.map((event) => [event.publicDetails.rail, event]));
    const memories = events.filter((event) => event.stage === "memory" && event.status === "complete" && typeof event.publicDetails.blobId === "string");
    const recall = events.find((event) => event.stage === "memory-recall" && Array.isArray(event.publicDetails.citations) && event.publicDetails.citations.some((citation) => citation.kind === "privacy_rule" && citation.provenance === "owner_policy"));
    const privacyPlan = events.find((event) => event.stage === "settlement-plan" && event.publicDetails.rail === "shielded" && Array.isArray(event.publicDetails.reasonCodes) && event.publicDetails.reasonCodes.includes("MEMORY_PRIVACY_APPLIED") && (!recall || event.sequence > recall.sequence));
    const prefund = events.find((event) => event.stage === "prefunding" && event.status === "complete" && typeof event.publicDetails.transactionDigest === "string");
    const exit = events.find((event) => event.actor === "confidential-seller" && event.stage === "delayed-exit" && event.status === "complete" && event.publicDetails.state === "queued");
    if (!prefund || !exit || !recall || !privacyPlan || memories.length < 10 || new Set(memories.map((event) => event.publicDetails.blobId)).size < 10 || memories.some((event) => String(event.publicDetails.blobId).startsWith("mockwalrus_")) || !rails.has("x402") || !rails.has("shielded") || [...rails.values()].some((event) => event.publicDetails.payment !== "finalized" || event.publicDetails.agreement !== "verified" || event.publicDetails.delivery !== "verified" || event.publicDetails.outcomeMemory !== "indexed" || typeof event.publicDetails.paymentDigest !== "string") || prefund.sequence >= Math.min(...deals.map((event) => event.sequence)) || exit.sequence <= rails.get("shielded")!.sequence) fail("DEMO_ACCEPTANCE_INCOMPLETE", "generic Codex stream needs prefunding, ten memories, recalled privacy, both live paid deliveries and indexed outcomes, then a queued seller exit");
    const buyer = new Phase3App(home), seller = new Phase3App(sellerHome);
    try {
      if (seller.profile.role !== "seller" || seller.profile.mock || seller.profile.verifierVersion !== 2) fail("LIVE_PROFILE_REQUIRED", "queued exit must belong to a separate live v2 seller");
      const journal = new DealJournal(buyer.store);
      for (const event of rails.values()) {
        const dealId = String(event.publicDetails.dealId ?? ""), row = buyer.store.db.prepare("SELECT operation_id FROM deal_operations WHERE deal_id=?").get(dealId) as { operation_id: string } | undefined;
        if (!row) fail("DEMO_EVIDENCE_MISMATCH", "logged deal is absent from buyer journal");
        const view = journal.get(row!.operation_id), evidence = journal.evidence(dealId);
        if (view.state !== "complete" || view.rail !== event.publicDetails.rail || view.paymentDigest !== event.publicDetails.paymentDigest || evidence.inventory !== "indexed" || !evidence.paymentFinalized || evidence.ciphertextReadback !== "verified") fail("DEMO_EVIDENCE_MISMATCH", "logged deal differs from verified buyer journal");
      }
      const funded = buyer.store.db.prepare("SELECT 1 FROM live_signed_transactions WHERE digest=? AND status='finalized'").get(String(prefund!.publicDetails.transactionDigest));
      const queued = new V2ExitQueue(seller.store).get(String(exit!.publicDetails.operationId ?? ""));
      const recovered = queued ? seller.store.db.prepare("SELECT 1 FROM notes WHERE commitment=? AND role='payment'").get(queued.commitment) : undefined;
      if (!funded || !queued || queued.status !== "queued" || !recovered) fail("DEMO_EVIDENCE_MISMATCH", "prefunding or recovered seller exit is absent from its role journal");
      return { healthy: true, checked: [home, sellerHome, path], secretScan: "pass", deals: deals.length };
    } finally { buyer.close(); seller.close(); }
  }
  const root = stateDir(), roles = homes(root), checked: string[] = [];
  for (const path of [root, ...Object.values(roles)]) { if (!existsSync(path) || (statSync(path).mode & 0o077) !== 0) fail("DEMO_PERMISSIONS", `${path} is missing or not owner-only`); checked.push(path); }
  const runPath = join(root, "run.json"), run = existsSync(runPath) ? JSON.parse(readFileSync(runPath, "utf8")) as { eventPath?: string } : {};
  const eventPath = typeof args.events === "string" ? resolve(args.events) : run.eventPath ?? join(root, "events.jsonl");
  if (!existsSync(eventPath) && (run.eventPath || typeof args.events === "string")) fail("DEMO_EVENTS_MISSING", "demo event stream is missing");
  if (existsSync(eventPath)) {
    const text = readFileSync(eventPath, "utf8"); if (/(?:suiprivkey|BEGIN [A-Z ]*PRIVATE KEY|approval.?token|note.?opening|full.?prompt)/i.test(text)) fail("SECRET_SCAN_FAILED", "event bundle contains forbidden secret material"); const events = readDemoEvents(eventPath); checked.push(eventPath);
    const remoteFlow = events.some((event) => event.stage === "run" && event.publicDetails.flow === "codex-remote");
    if (args["require-claude"] === true && !remoteFlow && !["buyer", "public-seller", "confidential-seller"].every((actor) => events.some((event) => event.actor === actor && event.stage === "agent-decision" && event.status === "complete" && typeof event.publicDetails.model === "string" && Number(event.publicDetails.outputTokens) > 0))) fail("DEMO_CLAUDE_EVIDENCE_MISSING", "event stream is missing live Claude decisions from a buyer or seller agent");
    const decisionKeys: Record<string, Set<string>> = { "settlement-plan": new Set(["phase", "planHash", "capabilityId", "rail", "openingAmount", "maximumAmount", "riskLevel", "reasonCodes", "blobIds"]), "memory-recall": new Set(["restarted", "citations", "policyBlobId"]) };
    for (const event of events) { const allowed = decisionKeys[event.stage]; if (allowed && Object.keys(event.publicDetails).some((key) => !allowed.has(key))) fail("DEMO_DECISION_EVENT_INVALID", `${event.stage} contains a non-allowlisted public field`); }
    if (remoteFlow) {
      const memories = events.filter((event) => event.stage === "memory" && event.status === "complete" && event.publicDetails.kind !== undefined);
      const deliveries = events.filter((event) => event.stage === "artifact-delivery" && event.status === "complete");
      if (memories.length < 10 || new Set(memories.map((event) => event.publicDetails.blobId)).size < 10 || memories.some((event) => String(event.publicDetails.blobId).startsWith("mockwalrus_")) || !events.some((event) => event.stage === "memory-recall" && Array.isArray(event.publicDetails.citations) && event.publicDetails.citations.some((citation) => citation.kind === "privacy_rule" && citation.provenance === "owner_policy")) || !events.some((event) => event.stage === "settlement-plan" && event.publicDetails.rail === "shielded" && Array.isArray(event.publicDetails.reasonCodes) && event.publicDetails.reasonCodes.includes("MEMORY_PRIVACY_APPLIED")) || !events.some((event) => event.stage === "public-settlement" && typeof event.publicDetails.transactionDigest === "string") || !events.some((event) => event.stage === "private-settlement" && typeof event.publicDetails.transactionDigest === "string" && event.evidenceHashes.length > 0) || deliveries.length < 2 || new Set(deliveries.map((event) => event.publicDetails.artifactSha256)).size < 2) fail("DEMO_ACCEPTANCE_INCOMPLETE", "remote event stream lacks ten memories, recalled privacy, both funded payments, or both deliveries");
    } else if (events.some((event) => event.stage === "settlement-plan")) {
      const memoryBlobIds = events.filter((event) => event.stage === "memory" && event.status === "complete").map((event) => String(event.publicDetails.blobId ?? ""));
      if (memoryBlobIds.length < 10 || new Set(memoryBlobIds).size < 10 || memoryBlobIds.some((id) => !id || id.startsWith("mockwalrus_")) || !events.some((event) => event.stage === "memory-recall" && event.publicDetails.restarted === true && Array.isArray(event.publicDetails.citations) && event.publicDetails.citations.some((citation) => citation.kind === "privacy_rule" && citation.provenance === "owner_policy")) || !events.some((event) => event.stage === "settlement-plan" && event.publicDetails.phase === "after-memory" && event.publicDetails.rail === "shielded" && Array.isArray(event.publicDetails.reasonCodes) && event.publicDetails.reasonCodes.includes("MEMORY_PRIVACY_APPLIED")) || !events.some((event) => event.stage === "public-settlement" && event.status === "complete") || !events.some((event) => event.stage === "artifact-delivery" && event.status === "complete") || !events.some((event) => event.stage === "private-settlement" && event.status === "complete" && event.evidenceHashes.length > 0)) fail("DEMO_ACCEPTANCE_INCOMPLETE", "event stream does not contain the required memory-native funded settlement sequence");
    }
    if (events.some((event) => event.stage === "private-settlement" && event.publicDetails.poolVersion === 2)) {
      const prefund = events.find((event) => event.stage === "prefunding" && event.status === "complete" && typeof event.publicDetails.transactionDigest === "string");
      const negotiation = events.find((event) => event.stage === "negotiation" && event.status === "complete");
      const privatePayment = events.find((event) => event.stage === "private-settlement" && event.status === "complete");
      const delayed = events.find((event) => event.stage === "delayed-exit" && event.status === "complete" && event.publicDetails.state === "queued");
      if (!prefund || !negotiation || !privatePayment || !delayed || prefund.sequence >= negotiation.sequence || privatePayment.sequence >= delayed.sequence) fail("DEMO_V2_SEQUENCE_INVALID", "v2 demo needs finalized prefunding before negotiation and a queued seller exit after settlement");
    }
  }
  return { healthy: true, checked, secretScan: "pass" };
}

async function live(): Promise<Record<string, unknown>> {
  const root = stateDir(), workflow = JSON.parse(readFileSync(resolve(value("workflow")), "utf8")) as { publicResourceUrl: string; publicOperationId: string; shieldedSession: string; buyerDepositAmount: string; memories: string[]; capabilities: CapabilityManifest[]; publicTask: string; confidentialTask: string; buyerOpeningAmount: string; buyerMaximum: string; exitWindow?: { startOffsetMs: number; endOffsetMs: number } }, eventPath = typeof args.events === "string" ? resolve(args.events) : join(root, "events.jsonl"), log = new DemoEventLog(eventPath, randomUUID(), "live"), roleHomes = homes(root); let buyer = new Phase3App(roleHomes.buyer); const publicSeller = new Phase3App(roleHomes.publicSeller), confidentialSeller = new Phase3App(roleHomes.confidentialSeller);
  if (buyer.profile.mock) fail("LIVE_PROFILE_REQUIRED", "supercuts-demo live refuses mock profiles");
  const claudeKeyPath = typeof args["claude-key-file"] === "string" ? resolve(args["claude-key-file"]) : undefined;
  if (claudeKeyPath && (statSync(claudeKeyPath).mode & 0o077) !== 0) fail("CREDENTIAL_PERMISSIONS", "Claude key file must be owner-only");
  const claudeKey = (claudeKeyPath ? readFileSync(claudeKeyPath, "utf8") : process.env.CLAUDE_API_KEY ?? "").trim();
  if (!claudeKey) fail("CLAUDE_CREDENTIAL_MISSING", "export CLAUDE_API_KEY or provide --claude-key-file");
  const claude = (actor: "buyer" | "public-seller" | "confidential-seller") => new BoundedClaude({ apiKey: claudeKey, onDecision: (entry) => log.append({ actor, stage: "agent-decision", status: "complete", publicDetails: { model: entry.model, action: entry.action, inputTokens: entry.usage.inputTokens, outputTokens: entry.usage.outputTokens }, evidenceHashes: [], explorerLinks: [] }) });
  const mutate = async (app: Phase3App, name: string, parameters: Record<string, string | boolean>) => { const intent = app.preview(name, parameters), approval = app.approve(intent.challengeId); return (await app.execute(name, { ...parameters, "approval-token": approval.token })).data; };
  try {
    log.append({ actor: "operator", stage: "run", status: "started", publicDetails: { label: "fresh funded run" }, evidenceHashes: [], explorerLinks: [] });
    for (const manifest of workflow.capabilities) validateCapabilityManifest(manifest);
    const publicCapabilities = workflow.capabilities.filter((item) => item.supportedRails.includes("x402") && item.endpoint === workflow.publicResourceUrl), confidentialCapabilities = workflow.capabilities.filter((item) => item.supportedRails.includes("shielded"));
    if (!publicCapabilities.length || !confidentialCapabilities.length) fail("DEMO_CAPABILITIES_REQUIRED", "workflow must contain matching public x402 and confidential shielded capabilities");
    const confidential = confidentialCapabilities[0]!, depositAmount = BigInt(workflow.buyerDepositAmount ?? "0");
    if (depositAmount <= BigInt(confidential.priceBand.minimum)) fail("DEMO_DEPOSIT_INSUFFICIENT", "buyerDepositAmount must exceed the confidential payment to leave a change note");
    if (buyer.profile.verifierVersion === 2 && (!workflow.exitWindow || !Number.isSafeInteger(workflow.exitWindow.startOffsetMs) || !Number.isSafeInteger(workflow.exitWindow.endOffsetMs) || workflow.exitWindow.startOffsetMs < 60_000 || workflow.exitWindow.endOffsetMs <= workflow.exitWindow.startOffsetMs || workflow.exitWindow.endOffsetMs - workflow.exitWindow.startOffsetMs > 7 * 24 * 60 * 60_000)) fail("DEMO_EXIT_WINDOW_REQUIRED", "v2 workflow needs an owner-selected delayed exit window");
    const prefund = await mutate(buyer, "wallet.deposit", { "operation-id": `prefund-${log.runId}`, amount: depositAmount.toString() });
    log.append({ actor: "buyer", stage: "prefunding", status: "complete", publicDetails: { amount: depositAmount.toString(), transactionDigest: prefund.transactionDigest, visibility: "deposit amount, sender, gas, and timing are public" }, evidenceHashes: [], explorerLinks: [] });
    const buyerChoice = await claude("buyer").decide<{ choice: string }>({ system: "You are the buyer agent. Select one listed public capability. Amounts and payment authority are enforced by Supercuts.", task: workflow.publicTask, candidates: publicCapabilities.map((item) => ({ capabilityId: item.capabilityId, description: item.description, priceBand: item.priceBand })), schema: { name: "select_public_capability", description: "Select one policy-approved public capability.", properties: { choice: { type: "string", enum: publicCapabilities.map((item) => item.capabilityId) } }, required: ["choice"] } });
    const selectedPublic = publicCapabilities.find((item) => item.capabilityId === buyerChoice.action.choice) ?? fail("CLAUDE_OUTPUT_INVALID", "buyer selected an unknown capability");
    if (!workflow.publicOperationId || workflow.publicOperationId.length > 256) fail("DEMO_PUBLIC_OPERATION_REQUIRED", "workflow must bind the seller resource to a fixed publicOperationId");
    const publicOperation = workflow.publicOperationId, publicPlan = await mutate(buyer, "settlement.plan", { "operation-id": publicOperation, manifest: Buffer.from(JSON.stringify(selectedPublic)).toString("base64url"), alternatives: Buffer.from(JSON.stringify(publicCapabilities.filter((item) => item !== selectedPublic))).toString("base64url"), "requested-amount": workflow.buyerOpeningAmount });
    log.append({ actor: "buyer", stage: "settlement-plan", status: "complete", publicDetails: { phase: "before-memory", planHash: publicPlan.planHash, capabilityId: publicPlan.capabilityId, rail: publicPlan.rail, openingAmount: publicPlan.openingAmount, maximumAmount: publicPlan.maximumAmount, riskLevel: publicPlan.riskLevel, reasonCodes: publicPlan.reasonCodes, blobIds: [] }, evidenceHashes: [String(publicPlan.manifestHash)], explorerLinks: [] });
    const challengeResponse = await fetch(workflow.publicResourceUrl, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (challengeResponse.status !== 402) fail("X402_CHALLENGE_REQUIRED", "public seller did not return an x402 challenge");
    const challengeHeader = challengeResponse.headers.get("payment-required") ?? fail("X402_CHALLENGE_INVALID", "public seller challenge omitted PAYMENT-REQUIRED"), challenge = JSON.parse(Buffer.from(challengeHeader, "base64").toString()) as { accepts?: Array<{ amount?: string }> }, sellerMinimum = BigInt(String(challenge.accepts?.[0]?.amount ?? "0")); await challengeResponse.arrayBuffer();
    const agreed = deterministicCounteroffer({ buyerOffer: BigInt(workflow.buyerOpeningAmount), buyerMaximum: BigInt(workflow.buyerMaximum), sellerMinimum });
    if (agreed !== sellerMinimum) fail("NEGOTIATION_PAYMENT_MISMATCH", "deterministic agreement must equal the seller's exact x402 requirement");
    await claude("public-seller").decide<{ action: string }>({ system: "You are the public seller agent. The exact price is fixed by the signed x402 challenge. You may only present the approved counteroffer.", task: `Respond to the buyer offer for capability ${selectedPublic.capabilityId}.`, candidates: [{ action: "present_counteroffer", amount: agreed.toString(), asset: selectedPublic.asset }], schema: { name: "respond_to_offer", description: "Present the backend-approved exact amount.", properties: { action: { type: "string", enum: ["present_counteroffer"] } }, required: ["action"] } });
    const session = `public-${log.runId}`;
    await mutate(buyer, "offer.open", { "operation-id": `${session}-open`, session });
    await mutate(buyer, "offer.propose", { "operation-id": `${session}-propose`, session, revision: "1", terms: JSON.stringify({ amount: workflow.buyerOpeningAmount, rail: "x402" }) });
    await mutate(publicSeller, "offer.counter", { "operation-id": `${session}-counter`, session, revision: "2", terms: JSON.stringify({ amount: agreed.toString(), rail: "x402" }) });
    await mutate(buyer, "offer.accept", { "operation-id": `${session}-accept`, session, revision: "3", terms: JSON.stringify({ amount: agreed.toString(), rail: "x402" }) });
    log.append({ actor: "supercuts", stage: "negotiation", status: "complete", publicDetails: { session, agreedAmount: agreed.toString(), rail: "x402", pricing: "deterministic" }, evidenceHashes: [], explorerLinks: [] });
    const publicPayment = await mutate(buyer, "pay.x402", { "operation-id": publicOperation, "resource-url": workflow.publicResourceUrl, "plan-hash": String(publicPlan.planHash) });
    const { response: _artifactBytes, ...publicEvidence } = publicPayment;
    log.append({ actor: "buyer", stage: "public-settlement", status: "complete", publicDetails: { rail: "x402", visibility: "public amount and payee", ...publicEvidence }, evidenceHashes: [String(publicPayment.responseSha256 ?? "")].filter(Boolean), explorerLinks: [] });
    log.append({ actor: "buyer", stage: "artifact-delivery", status: "complete", publicDetails: { capabilityId: publicPlan.capabilityId, requestId: publicPayment.requestId, artifactSha256: publicPayment.responseSha256 }, evidenceHashes: [String(publicPayment.responseSha256 ?? "")].filter(Boolean), explorerLinks: [] });
    const memories = workflow.memories; if (!Array.isArray(memories) || memories.length !== 10 || memories.some((item) => typeof item !== "string" || !item.trim() || item.length > 512)) fail("DEMO_MEMORY_COUNT", "live workflow must provide exactly ten short meaningful first-purchase memories");
    const reuseRunId = typeof args["reuse-memory-run-id"] === "string" ? args["reuse-memory-run-id"] : undefined;
    if (reuseRunId && !/^[0-9a-f-]{36}$/i.test(reuseRunId)) fail("DEMO_MEMORY_RUN_INVALID", "reuse-memory-run-id must identify a prior run");
    const reusedMemory = (operationId: string, expectedKind: string, expectedObservation?: string): { blobId: string; kind: string; provenance: string } => {
      const row = buyer.store.db.prepare("SELECT blob_id,status FROM memory_jobs WHERE operation_id=?").get(operationId) as { blob_id: string | null; status: string } | undefined;
      if (!row || row.status !== "complete" || !row.blob_id) fail("DEMO_MEMORY_REUSE_MISSING", "prior memory is not complete");
      const stored = buyer.store.getSecret(`memory:${row!.blob_id!}`) ?? fail("DEMO_MEMORY_REUSE_MISSING", "prior memory opening is unavailable locally");
      const memory = JSON.parse(stored.toString()) as { kind?: string; provenance?: string; observation?: string; scope?: { capabilityId?: string; counterparty?: string } };
      if (memory.kind !== expectedKind || (expectedObservation !== undefined && memory.observation !== expectedObservation) || (expectedKind === "privacy_rule" && (memory.scope?.capabilityId !== confidential.capabilityId || memory.scope?.counterparty !== confidential.sellerId))) fail("DEMO_MEMORY_REUSE_MISMATCH", "prior memory does not match this workflow");
      return { blobId: row!.blob_id!, kind: memory.kind!, provenance: memory.provenance ?? "agent_observation" };
    };
    for (let index = 0; index < memories.length; index++) { const envelope = { version: "supercuts.settlement-memory.v1", kind: index % 2 ? "quality" : "reliability", observation: memories[index], scope: { capabilityId: String(publicPlan.capabilityId), counterparty: String(publicPlan.sellerId), network: "sui:testnet", asset: String(publicPlan.asset) }, createdAt: Date.now() + index, signal: index % 2 ? { quality: Math.min(1, 0.8 + index / 100) } : { reliability: Math.min(1, 0.8 + index / 100) } }; const operationId = reuseRunId ? `memory-${reuseRunId}-${index}` : `memory-${log.runId}-${index}`; const remembered = reuseRunId ? reusedMemory(operationId, envelope.kind, memories[index]) : await mutate(buyer, "memory.remember", { "operation-id": operationId, memory: Buffer.from(JSON.stringify(envelope)).toString("base64url") }); log.append({ actor: "buyer", stage: "memory", status: "complete", publicDetails: { index: index + 1, blobId: remembered.blobId, kind: remembered.kind, provenance: remembered.provenance, ...(reuseRunId ? { reusedFromRun: reuseRunId } : {}) }, evidenceHashes: [], explorerLinks: [] }); }
    const policyEnvelope = { version: "supercuts.settlement-memory.v1", kind: "privacy_rule", scope: { capabilityId: confidential.capabilityId, counterparty: confidential.sellerId, network: "sui:testnet", asset: confidential.asset }, createdAt: Date.now() + 20, signal: { requiresShielded: true } };
    const privacyOperation = `privacy-${reuseRunId ?? log.runId}`;
    const privacy = reuseRunId ? reusedMemory(privacyOperation, "privacy_rule") : await mutate(buyer, "memory.policy", { "operation-id": privacyOperation, memory: Buffer.from(JSON.stringify(policyEnvelope)).toString("base64url") });
    buyer.close(); buyer = new Phase3App(roleHomes.buyer);
    const recalled = (await buyer.execute("memory.recall", { query: `${confidential.capabilityId} privacy settlement` })).data;
    log.append({ actor: "supercuts", stage: "memory-recall", status: "complete", publicDetails: { restarted: true, citations: recalled.citations, policyBlobId: privacy.blobId }, evidenceHashes: [], explorerLinks: [] });
    if (!confidential.supportedRails.includes("x402")) fail("DEMO_PRIVACY_ALTERNATIVE_REQUIRED", "confidential capability must offer x402 and shielded rails to demonstrate memory-driven selection");
    if (!(recalled.citations as Array<{ blobId: string; kind: string }>).some((item) => item.blobId === privacy.blobId && item.kind === "privacy_rule")) fail("DEMO_PRIVACY_RECALL_MISSING", "owner privacy rule was not cited by Walrus Memory recall");
    const privateOperation = `private-${log.runId}`, privatePlan = await mutate(buyer, "settlement.plan", { "operation-id": privateOperation, manifest: Buffer.from(JSON.stringify(confidential)).toString("base64url"), alternatives: Buffer.from(JSON.stringify(confidentialCapabilities.slice(1))).toString("base64url"), "requested-amount": confidential.priceBand.minimum });
    if (privatePlan.rail !== "shielded" || !(privatePlan.reasonCodes as string[]).includes("MEMORY_PRIVACY_APPLIED")) fail("DEMO_PRIVACY_PLAN_MISSING", "the recalled owner policy did not select shielded settlement");
    await claude("buyer").decide<{ action: string }>({ system: "You are the buyer agent. The owner privacy rule and approved settlement plan require the shielded rail. You may only choose the approved next action.", task: workflow.confidentialTask, candidates: [{ action: "proceed_shielded", capabilityId: privatePlan.capabilityId, rail: privatePlan.rail }], schema: { name: "choose_private_action", description: "Choose the policy-approved action.", properties: { action: { type: "string", enum: ["proceed_shielded"] } }, required: ["action"] } });
    log.append({ actor: "buyer", stage: "settlement-plan", status: "complete", publicDetails: { phase: "after-memory", planHash: privatePlan.planHash, capabilityId: privatePlan.capabilityId, rail: privatePlan.rail, openingAmount: privatePlan.openingAmount, maximumAmount: privatePlan.maximumAmount, riskLevel: privatePlan.riskLevel, reasonCodes: privatePlan.reasonCodes, blobIds: (privatePlan.citations as Array<{ blobId: string }>).map((item) => item.blobId) }, evidenceHashes: [String(privatePlan.manifestHash)], explorerLinks: [] });
    const buyerIdentity = (await buyer.execute("doctor", {})).data as { babyJubPublicKey: string[] };
    const scalar = () => BigInt(`0x${randomBytes(16).toString("hex")}`).toString();
    const sessionId = workflow.shieldedSession || `confidential-${log.runId}`;
    const halves = (content: string): [string, string] => { const digest = createHash("sha256").update(content).digest("hex"); return [BigInt(`0x${digest.slice(0, 32)}`).toString(), BigInt(`0x${digest.slice(32)}`).toString()]; };
    const [transcriptRootLo, transcriptRootHi] = halves(JSON.stringify({ publicTransaction: publicPayment.transactionDigest, artifactSha256: publicPayment.responseSha256, confidentialTask: workflow.confidentialTask }));
    const [serviceDigestLo, serviceDigestHi] = halves(JSON.stringify({ capabilityId: confidential.capabilityId, manifestHash: confidential.manifestHash, task: workflow.confidentialTask }));
    const draft = { dealId: scalar(), revision: "1", transcriptRootLo, transcriptRootHi, serviceDigestLo, serviceDigestHi, settlementNonceLo: scalar(), settlementNonceHi: scalar(), paymentAmount: confidential.priceBand.minimum, blinding: scalar(), expiry: String(Date.now() + 30 * 60_000), buyerPublicKey: buyerIdentity.babyJubPublicKey, counterparty: confidential.sellerId, capabilityId: confidential.capabilityId, manifestHash: confidential.manifestHash };
    await claude("confidential-seller").decide<{ action: string }>({ system: "You are the confidential seller agent. The backend validates and signs the exact cryptographic agreement. You may only proceed with the approved service offer.", task: `Accept the approved confidential capability ${confidential.capabilityId}.`, candidates: [{ action: "sign_approved_agreement", capabilityId: confidential.capabilityId, rail: "shielded" }], schema: { name: "respond_to_private_offer", description: "Accept the backend-approved confidential agreement.", properties: { action: { type: "string", enum: ["sign_approved_agreement"] } }, required: ["action"] } });
    const signed = await mutate(confidentialSeller, "offer.counter", { "operation-id": `confidential-counter-${log.runId}`, session: sessionId, agreement: Buffer.from(JSON.stringify(draft)).toString("base64url") });
    await mutate(buyer, "offer.accept", { "operation-id": `confidential-accept-${log.runId}`, session: sessionId, agreement: String(signed.agreement), manifest: Buffer.from(JSON.stringify(confidential)).toString("base64url"), "plan-hash": String(privatePlan.planHash) });
    const privatePayment = await mutate(buyer, "pay.shielded", { "operation-id": privateOperation, session: sessionId, "plan-hash": String(privatePlan.planHash) });
    log.append({ actor: "buyer", stage: "private-settlement", status: "complete", publicDetails: { rail: "shielded", poolVersion: buyer.profile.verifierVersion, visibility: "no direct public payment reveals the deal amount or counterparty; funding, deposits, withdrawals, gas, and pool activity remain visible", transactionDigest: privatePayment.transactionDigest, tatumVerified: privatePayment.tatumVerified, prover: privatePayment.prover }, evidenceHashes: [String(privatePayment.dealCommitment ?? "")].filter(Boolean), explorerLinks: [] });
    if (buyer.profile.verifierVersion === 2) {
      await mutate(confidentialSeller, "wallet.recover", { "operation-id": `recover-${log.runId}` });
      const now = Date.now(), window = workflow.exitWindow!;
      const queued = await mutate(confidentialSeller, "wallet.exit.queue", { "operation-id": `exit-${log.runId}`, commitment: String(privatePayment.paymentCommitment), amount: "1000000", "window-start": String(now + window.startOffsetMs), "window-end": String(now + window.endOffsetMs) });
      log.append({ actor: "confidential-seller", stage: "delayed-exit", status: "complete", publicDetails: { state: "queued", operationId: queued.operationId, executeAt: queued.executeAt, windowEnd: queued.windowEnd, amount: "1000000", visibility: "standard exit and payout address are public when executed; sparse pool use reduces privacy" }, evidenceHashes: [], explorerLinks: [] });
    }
    return { runId: log.runId, events: eventPath, publicTransaction: publicPayment.transactionDigest, shieldedTransaction: privatePayment.transactionDigest };
  } finally { buyer.close(); publicSeller.close(); confidentialSeller.close(); }
}

async function replay(): Promise<Record<string, unknown>> {
  const path = resolve(value("events", join(stateDir(), "events.jsonl"))), events = recordedReplay(readDemoEvents(path));
  if (args.serve === true) { const port = Number(value("port", "4173")); const dashboard = await serveEventDashboard(path, port, true); process.stderr.write(`recorded funded run: ${dashboard.url}\n`); await new Promise<void>((done) => { process.on("SIGINT", () => { dashboard.server.close(); done(); }); process.on("SIGTERM", () => { dashboard.server.close(); done(); }); }); return { label: "recorded funded run", events: events.length, url: dashboard.url }; }
  return { label: "recorded funded run", freshTransaction: false, events };
}

try { const data = command === "setup" ? await setup() : command === "doctor" ? await doctor() : command === "seed-policy" ? await seedPolicy() : command === "check" ? check() : command === "live" ? await live() : command === "replay" ? await replay() : fail("COMMAND_UNKNOWN", "use setup, doctor, seed-policy, live, replay, or check"); send(data); }
catch (error) { process.stdout.write(`${JSON.stringify(errorOutput(error))}\n`); process.exitCode = 1; }
