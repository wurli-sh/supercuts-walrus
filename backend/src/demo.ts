#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { readDemoEvents, recordedReplay } from "./events.js";
import { Phase3App, errorOutput, initialize, parseArgs } from "./phase3.js";
import { serveEventDashboard } from "./dashboard.js";
import { fail } from "./errors.js";
import { validateCapabilityManifest, type CapabilityManifest } from "./capability.js";
import { loadMandate } from "./mandate.js";
import { LiveDealPorts } from "./live-deal-ports.js";
import { V2ExitQueue } from "./v2-exits.js";
import { inspectHostedExit } from "./hosted-exit.js";
import { SellerDatabase } from "./seller-database.js";
import { verifyDealRun } from "./demo-check.js";

const [command = "", ...words] = process.argv.slice(2), args = parseArgs(words);
const value = (name: string, fallback?: string): string => typeof args[name] === "string" ? args[name] : fallback ?? fail("ARGUMENT_REQUIRED", `--${name} is required`);
const stateDir = (): string => resolve(value("state-dir", ".supercuts-demo"));
const homes = (root: string) => ({ buyer: join(root, "buyer"), publicSeller: join(root, "public-seller"), secondPublicSeller: join(root, "second-public-seller"), confidentialSeller: join(root, "confidential-seller"), auditor: join(root, "auditor") });
const send = (data: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ schemaVersion: "supercuts.demo.v1", ok: true, command, data })}\n`);
const help = (): Record<string, unknown> => ({ commands: ["setup", "doctor", "seed-policy", "replay", "check"], setup: "Run supercuts-demo setup --state-dir <owner-only-directory> with the pinned live configuration. Fund only the buyer address in funding[0].address.", live: "The live demo uses Sui Testnet and Mainnet-backed Walrus services; mock receipts are never settlement evidence." });

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
    const profilePath = join(roles[name], "profile.json");
    if (!existsSync(profilePath)) initialize(roles[name], { role, ...common, ...(!mock ? { "sui-key-file": key } : {}), ...(role === "buyer" ? { "allow-counterparty": `${addresses.publicSeller},${addresses.secondPublicSeller},${addresses.confidentialSeller}`, ...(typeof args["memory-config-file"] === "string" ? { "memory-config-file": resolve(args["memory-config-file"]) } : {}), ...(typeof args["max-memory-distance"] === "string" ? { "max-memory-distance": args["max-memory-distance"] } : {}) } : {}) });
    const profile = JSON.parse(readFileSync(profilePath, "utf8")) as { role?: string; mock?: boolean; verifierVersion?: number };
    if (profile.role !== role || profile.mock !== mock || !mock && profile.verifierVersion !== 2) fail("DEMO_ROLE_PROFILE_MISMATCH", "demo setup needs fresh isolated live v2 role homes; choose a new --state-dir instead of reusing v1 or mock profiles");
  }
  const workflowPath = typeof args.workflow === "string" ? resolve(args.workflow) : !mock && typeof args["seller-url"] !== "string" ? resolve(value("workflow")) : undefined;
  let activeCapabilities: CapabilityManifest[] = [];
  if (workflowPath) {
    const workflow = JSON.parse(readFileSync(workflowPath, "utf8")) as { capabilities?: CapabilityManifest[] }, configured = workflow.capabilities ?? [];
    if (!configured.length) fail("DEMO_CAPABILITIES_REQUIRED", "live workflow must provide capability manifests for the buyer mandate"); for (const manifest of configured) validateCapabilityManifest(manifest);
    let capabilities = configured;
    if (!mock && typeof args["seller-url"] === "string") {
      const response = await fetch(new URL("/v1/catalog", new URL(args["seller-url"])), { signal: AbortSignal.timeout(90_000) });
      if (!response.ok) fail("SELLER_SERVICE_UNAVAILABLE", `remote seller catalog returned ${response.status}`);
      const served = await response.json() as { capabilities?: Array<{ manifest?: CapabilityManifest; blobId?: string }> };
      const allowedIds = new Set(configured.map((item) => item.capabilityId)), entries = (served.capabilities ?? []).filter((item) => item.manifest && allowedIds.has(item.manifest.capabilityId));
      if (!entries.length || entries.some((item) => !item.manifest || typeof item.blobId !== "string")) fail("SELLER_CATALOG_INVALID", "remote seller catalog has no configured capabilities with Walrus identities");
      const app = new Phase3App(roles.buyer);
      try {
        const discovered = (await app.execute("capability.discover", { "blob-ids": Buffer.from(JSON.stringify(entries.map((item) => item.blobId))).toString("base64url") })).data.capabilities as Array<CapabilityManifest & { blobId?: string }>;
        const verified = new Map(discovered.map((item) => [`${item.capabilityId}:${item.blobId}`, item.manifestHash]));
        if (entries.some((item) => verified.get(`${item.manifest!.capabilityId}:${item.blobId}`) !== item.manifest!.manifestHash)) fail("SELLER_CATALOG_INVALID", "remote seller catalog differs from its Walrus manifests");
      } finally { app.close(); }
      capabilities = entries.map((item) => item.manifest!);
    }
    activeCapabilities = capabilities;
    const mandatePath = join(roles.buyer, "mandate.json"), mandate = JSON.parse(readFileSync(mandatePath, "utf8")) as Record<string, unknown>;
    mandate.requireSettlementPlan = true; mandate.allowedCommands = [...new Set([...(Array.isArray(mandate.allowedCommands) ? mandate.allowedCommands as string[] : []), "settlement.plan"])]; mandate.allowedCounterparties = [...new Set(capabilities.map((item) => item.sellerId))]; mandate.allowedCapabilityIds = [...new Set(capabilities.map((item) => item.capabilityId))]; mandate.allowedCapabilityClasses = [...new Set(capabilities.map((item) => item.capability))]; mandate.allowedRails = [...new Set(capabilities.flatMap((item) => item.supportedRails))];
    writeFileSync(mandatePath, `${JSON.stringify(mandate, null, 2)}\n`, { mode: 0o600 }); chmodSync(mandatePath, 0o600);
    const buyerProfilePath = join(roles.buyer, "profile.json"), buyerProfile = JSON.parse(readFileSync(buyerProfilePath, "utf8")) as { policy?: { allowedCounterparties?: string[] } };
    if (!buyerProfile.policy) fail("DEMO_ROLE_PROFILE_MISMATCH", "buyer profile has no payment policy");
    const buyerPolicy = buyerProfile.policy as { allowedCounterparties?: string[] };
    buyerPolicy.allowedCounterparties = [...new Set(capabilities.map((item) => item.sellerId))];
    writeFileSync(buyerProfilePath, `${JSON.stringify(buyerProfile, null, 2)}\n`, { mode: 0o600 }); chmodSync(buyerProfilePath, 0o600);
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
  writeFileSync(join(root, "run.json"), `${JSON.stringify({ schema: "supercuts.demo.run.v1", createdAt: new Date().toISOString(), runId, ...(remote ? { eventPath, sellerUrl: new URL(String(args["seller-url"])).toString() } : {}), mock, homes: roles, addresses }, null, 2)}\n`, { mode: 0o600 });
  const publicSellers = activeCapabilities.filter((item) => item.capability === "sui.market-brief"), analysisSeller = activeCapabilities.find((item) => item.capability === "sui.competitor-analysis");
  const settlementSellers = activeCapabilities.length ? { publicA: publicSellers[0]?.sellerId, publicB: publicSellers[1]?.sellerId, analysis: analysisSeller?.sellerId } : { publicA: addresses.publicSeller, publicB: addresses.secondPublicSeller, analysis: addresses.confidentialSeller };
  return { stateDir: root, mock, funding: mock ? [] : [{ address: addresses.buyer, needs: ["Testnet SUI gas", "configured x402 asset", "shielded deposit value"] }], sellerPayTo: settlementSellers.publicA, sellerAddresses: settlementSellers, localRoleAddresses: { publicA: addresses.publicSeller, publicB: addresses.secondPublicSeller, analysis: addresses.confidentialSeller, auditor: addresses.auditor }, files: { mcp: join(root, "mcp.json"), run: join(root, "run.json"), events: remote ? eventPath : join(root, "events.jsonl"), ...(remote ? { codex: join(root, "buyer-codex.toml") } : {}) } };
}

async function doctor(): Promise<Record<string, unknown>> {
  if (typeof args["buyer-home"] === "string") {
    const home = resolve(args["buyer-home"]), app = new Phase3App(home);
    try {
      if (app.profile.role !== "buyer" || app.profile.mock || app.profile.verifierVersion !== 2) fail("LIVE_PROFILE_REQUIRED", "generic Codex doctor requires a live v2 buyer");
      const mandate = loadMandate(home), buyer = (await app.execute("doctor", {})).data;
      if (buyer.readyForDemo === false) fail("DEMO_PREREQUISITES_MISSING", (buyer.fixes as string[]).join(" "));
      const catalog = await new LiveDealPorts(app, mandate).catalog();
      if (!catalog.length) fail("SELLER_CATALOG_EMPTY", "configured seller origins have no allowed signed v2 capability");
      return { healthy: true, buyer, sellerCapabilities: catalog.map(({ registration }) => registration.manifest.capabilityId) };
    } finally { app.close(); }
  }
  const roles = homes(stateDir()), reports: Record<string, unknown> = {};
  for (const [name, home] of Object.entries(roles)) { const app = new Phase3App(home); try { const report = (await app.execute("doctor", {})).data; if (report.readyForDemo === false) fail("DEMO_PREREQUISITES_MISSING", `${name}: ${(report.fixes as string[]).join(" ")}`); if (name === "buyer") { const mandate = loadMandate(home), profileSellers = [...app.profile.policy.allowedCounterparties].sort(), mandateSellers = [...mandate.allowedCounterparties].sort(); if (JSON.stringify(profileSellers) !== JSON.stringify(mandateSellers)) fail("POLICY_COUNTERPARTY_MISMATCH", "buyer mandate and payment profile allow different sellers; rerun setup refresh before funding"); } reports[name] = report; } finally { app.close(); } }
  let remote: Record<string, unknown> | undefined;
  if (typeof args["seller-url"] === "string") {
    const base = new URL(args["seller-url"]), health = await fetch(new URL("/health", base), { signal: AbortSignal.timeout(90_000) }), catalog = await fetch(new URL("/v1/catalog", base), { signal: AbortSignal.timeout(30_000) });
    if (!health.ok || !catalog.ok) fail("SELLER_SERVICE_UNAVAILABLE", "remote seller health or catalog check failed");
    const healthBody = await health.json() as { buyerAccess?: string }, buyerSigner = String((reports.buyer as { signer?: string } | undefined)?.signer ?? ""), accessUrl = new URL("/v1/access", base); accessUrl.searchParams.set("buyerAddress", buyerSigner);
    const access = await fetch(accessUrl, { signal: AbortSignal.timeout(30_000) });
    if (!access.ok) fail("SELLER_SERVICE_UNAVAILABLE", "remote seller access preflight failed");
    const accessBody = await access.json() as { allowed?: boolean; mode?: string };
    if (accessBody.allowed !== true) fail("SELLER_BUYER_FORBIDDEN", "remote seller does not currently accept this buyer; use open access or complete owner enrollment before funding");
    const body = await catalog.json() as { capabilities?: Array<{ manifest?: CapabilityManifest }> }, capabilities = body.capabilities ?? [];
    if (capabilities.filter((item) => item.manifest?.capability === "sui.market-brief").length < 2 || !capabilities.some((item) => item.manifest?.capability === "sui.competitor-analysis")) fail("SELLER_CATALOG_INVALID", "remote catalog needs two briefs and one competitor analysis");
    remote = { healthy: true, origin: base.origin, capabilities: capabilities.length, buyerAccess: accessBody.mode ?? healthBody.buyerAccess ?? "unknown", buyerAllowed: true };
  }
  return { healthy: true, roles: reports, isolation: new Set(Object.values(roles)).size === 5, ...(remote ? { remote } : {}) };
}

async function seedPolicy(): Promise<Record<string, unknown>> {
  const source = JSON.parse(readFileSync(resolve(value("workflow")), "utf8")) as { capabilities?: CapabilityManifest[] };
  let manifest = source.capabilities?.find((item) => item.capability === "sui.competitor-analysis") ?? fail("DEMO_POLICY_SCOPE_INVALID", "workflow has no competitor analysis capability");
  validateCapabilityManifest(manifest);
  if (manifest.capability !== "sui.competitor-analysis") fail("DEMO_POLICY_SCOPE_INVALID", "privacy policy must target the competitor analysis capability");
  const app = new Phase3App(homes(stateDir()).buyer);
  try {
    if (app.profile.mock) fail("LIVE_PROFILE_REQUIRED", "saved demo privacy policy requires a live buyer profile");
    const runPath = join(stateDir(), "run.json"), run = existsSync(runPath) ? JSON.parse(readFileSync(runPath, "utf8")) as { sellerUrl?: string } : {};
    if (run.sellerUrl) {
      const response = await fetch(new URL("/v1/catalog", run.sellerUrl), { signal: AbortSignal.timeout(90_000) });
      if (!response.ok) fail("SELLER_SERVICE_UNAVAILABLE", `remote seller catalog returned ${response.status}`);
      const body = await response.json() as { capabilities?: Array<{ manifest?: CapabilityManifest; blobId?: string }> };
      const entry = body.capabilities?.find((item) => item.manifest?.capabilityId === manifest.capabilityId && item.manifest.capability === "sui.competitor-analysis") ?? fail("DEMO_POLICY_SCOPE_INVALID", "remote catalog has no matching competitor analysis capability");
      if (!entry.manifest || typeof entry.blobId !== "string") fail("SELLER_CATALOG_INVALID", "remote analysis capability has no Walrus identity");
      const liveManifest = entry.manifest as CapabilityManifest, liveBlobId = entry.blobId as string;
      const discovered = (await app.execute("capability.discover", { "blob-ids": Buffer.from(JSON.stringify([liveBlobId])).toString("base64url") })).data.capabilities as Array<CapabilityManifest & { blobId?: string }>;
      if (discovered.length !== 1 || discovered[0]!.blobId !== liveBlobId || discovered[0]!.manifestHash !== liveManifest.manifestHash) fail("SELLER_CATALOG_INVALID", "remote analysis capability differs from its Walrus manifest");
      manifest = liveManifest;
    }
    const memory = { version: "supercuts.settlement-memory.v1", kind: "privacy_rule", scope: { capabilityId: manifest.capabilityId, counterparty: manifest.sellerId, network: "sui:testnet", asset: manifest.asset }, createdAt: Date.now(), signal: { requiresShielded: true } };
    const parameters = { "operation-id": value("operation-id", `privacy-${manifest.capabilityId}`), memory: Buffer.from(JSON.stringify(memory)).toString("base64url") };
    const token = app.approve(app.preview("memory.policy", parameters).challengeId);
    const result = (await app.execute("memory.policy", { ...parameters, "approval-token": token.token })).data;
    return { capabilityId: manifest.capabilityId, sellerId: manifest.sellerId, blobId: result.blobId, kind: result.kind, provenance: result.provenance };
  } finally { app.close(); }
}

async function check(): Promise<Record<string, unknown>> {
  if (typeof args["buyer-home"] === "string") {
    // The canonical recording: Codex drives deal.execute; private deal first, then public, then the seller exit.
    const seller = typeof args["seller-home"] === "string" ? { home: resolve(args["seller-home"]) } : (() => {
      const env = (name: string) => process.env[name] ?? fail("SELLER_CONFIG_MISSING", `${name} is required to verify a hosted seller exit, or pass --seller-home`);
      return { hosted: { db: new SellerDatabase(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")), stateKey: env("SELLER_STATE_KEY"), sellerId: value("seller-id") } };
    })();
    return verifyDealRun({ buyerHome: resolve(args["buyer-home"]), eventPath: resolve(value("events")), seller });
  }
  const root = stateDir(), roles = homes(root), checked: string[] = [];
  for (const path of [root, ...Object.values(roles)]) { if (!existsSync(path) || (statSync(path).mode & 0o077) !== 0) fail("DEMO_PERMISSIONS", `${path} is missing or not owner-only`); checked.push(path); }
  const runPath = join(root, "run.json"), run = existsSync(runPath) ? JSON.parse(readFileSync(runPath, "utf8")) as { eventPath?: string; runId?: string; addresses?: { confidentialSeller?: string } } : {};
  const eventPath = typeof args.events === "string" ? resolve(args.events) : run.eventPath ?? join(root, "events.jsonl");
  if (!existsSync(eventPath)) fail("DEMO_EVENTS_MISSING", "demo event stream is missing");
  if (existsSync(eventPath)) {
    const text = readFileSync(eventPath, "utf8"); if (/(?:suiprivkey|BEGIN [A-Z ]*PRIVATE KEY|approval.?token|note.?opening|full.?prompt)/i.test(text)) fail("SECRET_SCAN_FAILED", "event bundle contains forbidden secret material"); const events = readDemoEvents(eventPath); checked.push(eventPath);
    if (!events.length || events.some((event) => event.mode !== "live" || event.runId !== events[0]!.runId)) fail("DEMO_EVENTS_INVALID", "recording needs one nonempty live event stream for a single run");
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
    const required = (stage: string) => events.find((event) => event.stage === stage && event.status === "complete")?.sequence;
    const lastMemory = Math.max(...events.filter((event) => event.stage === "memory" && event.status === "complete").map((event) => event.sequence));
    const recallAfterMemories = events.find((event) => event.stage === "memory-recall" && event.status === "complete" && event.sequence > lastMemory)?.sequence;
    const sequence = [required("prefunding"), required("negotiation"), required("public-settlement"), required("artifact-delivery"), required("memory"), recallAfterMemories, events.find((event) => event.stage === "settlement-plan" && event.status === "complete" && event.publicDetails.rail === "shielded" && event.sequence > (recallAfterMemories ?? 0))?.sequence, required("private-settlement"), events.find((event) => event.actor === "confidential-seller" && event.stage === "delayed-exit" && event.status === "complete" && event.publicDetails.state === "queued")?.sequence];
    if (sequence.some((step) => step === undefined) || sequence.some((step, index) => index > 0 && step! <= sequence[index - 1]!)) fail("DEMO_SEQUENCE_INVALID", "live recording must show prefunding, public purchase, memories, privacy recall, shielded payment, and seller exit in order");
    const completedMemories = events.filter((event) => event.stage === "memory" && event.status === "complete" && typeof event.publicDetails.blobId === "string" && !event.publicDetails.blobId.startsWith("mockwalrus_"));
    if (new Set(completedMemories.map((event) => event.publicDetails.blobId)).size < 10 || completedMemories.some((event) => event.sequence <= sequence[3]! || event.sequence >= sequence[5]!)) fail("DEMO_MEMORY_SEQUENCE_INVALID", "ten distinct completed live memories must appear after public delivery and before privacy recall");
    const cited = events.find((event) => event.stage === "memory-recall" && event.sequence === sequence[5])?.publicDetails.citations;
    const policyBlobId = Array.isArray(cited) ? (cited as Array<{ blobId?: string; kind?: string; provenance?: string }>).find((item) => item.kind === "privacy_rule" && item.provenance === "owner_policy")?.blobId : undefined;
    const plan = events.find((event) => event.stage === "settlement-plan" && event.sequence === sequence[6]);
    if (!policyBlobId || !Array.isArray(plan?.publicDetails.blobIds) || !plan.publicDetails.blobIds.includes(policyBlobId) || !Array.isArray(plan.publicDetails.reasonCodes) || !plan.publicDetails.reasonCodes.includes("MEMORY_PRIVACY_APPLIED")) fail("DEMO_PRIVACY_EVIDENCE_MISSING", "shielded plan must cite the recalled owner privacy rule");
    if (remoteFlow) {
      const exitEvent = events.find((event) => event.actor === "confidential-seller" && event.stage === "delayed-exit" && event.sequence === sequence[8])!;
      const requiredEnv = (name: string) => process.env[name] ?? fail("SELLER_CONFIG_MISSING", `${name} is required to verify the hosted seller exit`);
      const runId = run.runId || fail("DEMO_RUN_INVALID", "run.json is missing the run ID"), sellerId = run.addresses?.confidentialSeller || fail("DEMO_RUN_INVALID", "run.json is missing the confidential seller");
      if (runId !== events[0]!.runId) fail("DEMO_RUN_INVALID", "remote event stream does not match run.json");
      const queued = await inspectHostedExit(new SellerDatabase(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY")), requiredEnv("SELLER_STATE_KEY"), { sellerId, runId, sessionId: String(exitEvent.publicDetails.sessionId ?? "") });
      if (queued.operationId !== exitEvent.publicDetails.operationId || queued.amount !== exitEvent.publicDetails.amount || queued.executeAt !== exitEvent.publicDetails.executeAt || queued.windowEnd !== exitEvent.publicDetails.windowEnd) fail("DEMO_EVIDENCE_MISMATCH", "recorded hosted seller exit differs from its encrypted state snapshot");
    } else {
      const buyer = new Phase3App(roles.buyer), seller = new Phase3App(roles.confidentialSeller);
      try {
        if (buyer.profile.mock || seller.profile.mock || buyer.profile.verifierVersion !== 2 || seller.profile.verifierVersion !== 2) fail("LIVE_PROFILE_REQUIRED", "recorded payment evidence needs separate live v2 buyer and seller roles");
        for (const [stage, kind] of [["prefunding", "deposit"], ["public-settlement", "x402"], ["private-settlement", "shielded"]] as const) {
          const digest = events.find((event) => event.stage === stage && event.status === "complete")?.publicDetails.transactionDigest;
          const row = typeof digest === "string" && buyer.store.db.prepare("SELECT 1 FROM live_signed_transactions AS tx JOIN live_operation_context AS context ON context.operation_id=tx.operation_id WHERE tx.digest=? AND tx.status='finalized' AND context.kind=?").get(digest, kind);
          if (!row) fail("DEMO_EVIDENCE_MISMATCH", `${stage} digest is not a finalized ${kind} transaction in the buyer journal`);
        }
        for (const event of completedMemories) if (!buyer.store.db.prepare("SELECT 1 FROM memory_jobs WHERE blob_id=? AND status='complete'").get(String(event.publicDetails.blobId))) fail("DEMO_EVIDENCE_MISMATCH", "recorded memory is not a completed buyer write");
        const exitEvent = events.find((event) => event.stage === "delayed-exit" && event.sequence === sequence[8])!;
        const queued = new V2ExitQueue(seller.store).get(String(exitEvent.publicDetails.operationId ?? ""));
        if (!queued || queued.amount.toString() !== exitEvent.publicDetails.amount || !seller.store.db.prepare("SELECT 1 FROM notes WHERE commitment=? AND role='payment'").get(queued.commitment)) fail("DEMO_EVIDENCE_MISMATCH", "recorded exit is not queued against a recovered seller payment note");
      } finally { buyer.close(); seller.close(); }
    }
  }
  return { healthy: true, checked, secretScan: "pass" };
}

async function replay(): Promise<Record<string, unknown>> {
  const path = resolve(value("events", join(stateDir(), "events.jsonl"))), events = recordedReplay(readDemoEvents(path));
  if (args.serve === true) { const port = Number(value("port", "4173")); const dashboard = await serveEventDashboard(path, port, true); process.stderr.write(`recorded funded run: ${dashboard.url}\n`); await new Promise<void>((done) => { process.on("SIGINT", () => { dashboard.server.close(); done(); }); process.on("SIGTERM", () => { dashboard.server.close(); done(); }); }); return { label: "recorded funded run", events: events.length, url: dashboard.url }; }
  return { label: "recorded funded run", freshTransaction: false, events };
}

try { const data = ["help", "--help", "-h"].includes(command) ? help() : command === "setup" ? await setup() : command === "doctor" ? await doctor() : command === "seed-policy" ? await seedPolicy() : command === "check" ? await check() : command === "replay" ? await replay() : fail("COMMAND_UNKNOWN", "use setup, doctor, seed-policy, replay, or check; run deals through deal.execute in Codex"); send(data); }
catch (error) { process.stdout.write(`${JSON.stringify(errorOutput(error))}\n`); process.exitCode = 1; }
