#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { DemoEventLog, readDemoEvents, recordedReplay } from "./events.js";
import { Phase3App, errorOutput, initialize, parseArgs } from "./phase3.js";
import { serveEventDashboard } from "./dashboard.js";
import { fail } from "./errors.js";
import { BoundedClaude } from "./claude.js";
import { validateCapabilityManifest, type CapabilityManifest } from "./capability.js";
import { deterministicCounteroffer, settlementRailForPrivacy } from "./procurement.js";

const [command = "", ...words] = process.argv.slice(2), args = parseArgs(words);
const value = (name: string, fallback?: string): string => typeof args[name] === "string" ? args[name] : fallback ?? fail("ARGUMENT_REQUIRED", `--${name} is required`);
const stateDir = (): string => resolve(value("state-dir", ".supercuts-demo"));
const homes = (root: string) => ({ buyer: join(root, "buyer"), publicSeller: join(root, "public-seller"), confidentialSeller: join(root, "confidential-seller"), auditor: join(root, "auditor") });
const send = (data: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ schemaVersion: "supercuts.demo.v1", ok: true, command, data })}\n`);

function keyAddress(path: string): string { const decoded = decodeSuiPrivateKey(readFileSync(path, "utf8").trim()); if (decoded.scheme !== "ED25519") fail("SIGNER_UNSUPPORTED", "demo requires ED25519 Sui keys"); return Ed25519Keypair.fromSecretKey(decoded.secretKey).toSuiAddress(); }
function createKey(path: string): void { if (!existsSync(path)) writeFileSync(path, Ed25519Keypair.generate().getSecretKey(), { mode: 0o600 }); chmodSync(path, 0o600); }

async function setup(): Promise<Record<string, unknown>> {
  const root = stateDir(), roles = homes(root); mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
  const mock = args.mock === true, secrets = join(root, "secrets"); mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const keys = { buyer: join(secrets, "buyer.sui.key"), publicSeller: join(secrets, "public-seller.sui.key"), confidentialSeller: join(secrets, "confidential-seller.sui.key"), auditor: join(secrets, "auditor.sui.key") };
  for (const path of Object.values(keys)) createKey(path);
  const addresses = Object.fromEntries(Object.entries(keys).map(([name, path]) => [name, keyAddress(path)]));
  const common: Record<string, string | boolean> = mock ? { mock: true } : { "deployment-config": resolve(value("deployment-config")), "tatum-key-file": resolve(value("tatum-key-file")), "write-grpc": value("write-grpc"), "tatum-grpc": value("tatum-grpc"), "walrus-publisher": value("walrus-publisher"), "walrus-aggregator": value("walrus-aggregator"), ...(typeof args["memory-config-file"] === "string" ? { "memory-config-file": resolve(args["memory-config-file"]) } : {}), ...(typeof args.rapidsnark === "string" ? { rapidsnark: resolve(args.rapidsnark) } : {}) };
  const roleInputs: Array<[keyof typeof roles, "buyer" | "seller" | "auditor", string]> = [["buyer", "buyer", keys.buyer], ["publicSeller", "seller", keys.publicSeller], ["confidentialSeller", "seller", keys.confidentialSeller], ["auditor", "auditor", keys.auditor]];
  for (const [name, role, key] of roleInputs) {
    if (existsSync(join(roles[name], "profile.json"))) continue;
    initialize(roles[name], { role, ...common, ...(!mock ? { "sui-key-file": key } : {}), ...(role === "buyer" ? { "allow-counterparty": `${addresses.publicSeller},${addresses.confidentialSeller},public-seller,confidential-seller` } : {}) });
  }
  const mcp = { mcpServers: Object.fromEntries(Object.entries(roles).map(([name, home]) => [`supercuts-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, { command: "supercuts-mcp", env: { SUPERCUTS_HOME: home } }])) };
  writeFileSync(join(root, "mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(root, "run.json"), `${JSON.stringify({ schema: "supercuts.demo.run.v1", createdAt: new Date().toISOString(), mock, homes: roles, addresses }, null, 2)}\n`, { mode: 0o600 });
  return { stateDir: root, mock, funding: mock ? [] : [{ address: addresses.buyer, needs: ["Testnet SUI gas", "configured x402 asset", "shielded deposit value"] }], sellerPayTo: addresses.publicSeller, files: { mcp: join(root, "mcp.json"), run: join(root, "run.json") } };
}

async function doctor(): Promise<Record<string, unknown>> {
  const roles = homes(stateDir()), reports: Record<string, unknown> = {};
  for (const [name, home] of Object.entries(roles)) { const app = new Phase3App(home); try { reports[name] = (await app.execute("doctor", {})).data; } finally { app.close(); } }
  return { healthy: true, roles: reports, isolation: new Set(Object.values(roles)).size === 4 };
}

function check(): Record<string, unknown> {
  const root = stateDir(), roles = homes(root), checked: string[] = [];
  for (const path of [root, ...Object.values(roles)]) { if (!existsSync(path) || (statSync(path).mode & 0o077) !== 0) fail("DEMO_PERMISSIONS", `${path} is missing or not owner-only`); checked.push(path); }
  const eventPath = typeof args.events === "string" ? resolve(args.events) : join(root, "events.jsonl");
  if (existsSync(eventPath)) { const text = readFileSync(eventPath, "utf8"); if (/(?:suiprivkey|BEGIN [A-Z ]*PRIVATE KEY|approval.?token|note.?opening|full.?prompt)/i.test(text)) fail("SECRET_SCAN_FAILED", "event bundle contains forbidden secret material"); readDemoEvents(eventPath); checked.push(eventPath); }
  return { healthy: true, checked, secretScan: "pass" };
}

async function live(): Promise<Record<string, unknown>> {
  const root = stateDir(), workflow = JSON.parse(readFileSync(resolve(value("workflow")), "utf8")) as { publicResourceUrl: string; shieldedSession: string; memories: string[]; capabilities: CapabilityManifest[]; publicTask: string; confidentialTask: string; buyerOpeningAmount: string; buyerMaximum: string }, eventPath = typeof args.events === "string" ? resolve(args.events) : join(root, "events.jsonl"), log = new DemoEventLog(eventPath, randomUUID(), "live"), roleHomes = homes(root), buyer = new Phase3App(roleHomes.buyer), publicSeller = new Phase3App(roleHomes.publicSeller), confidentialSeller = new Phase3App(roleHomes.confidentialSeller), claude = new BoundedClaude();
  if (buyer.profile.mock) fail("LIVE_PROFILE_REQUIRED", "supercuts-demo live refuses mock profiles");
  const mutate = async (app: Phase3App, name: string, parameters: Record<string, string | boolean>) => { const intent = app.preview(name, parameters), approval = app.approve(intent.challengeId); return (await app.execute(name, { ...parameters, "approval-token": approval.token })).data; };
  try {
    log.append({ actor: "operator", stage: "run", status: "started", publicDetails: { label: "fresh funded run" }, evidenceHashes: [], explorerLinks: [] });
    for (const manifest of workflow.capabilities) validateCapabilityManifest(manifest);
    const choose = async (task: string, privacy: "public" | "confidential") => {
      const requiredRail = privacy === "confidential" ? "shielded" : "x402", allowed = workflow.capabilities.filter((manifest) => manifest.supportedRails.includes(requiredRail));
      settlementRailForPrivacy(privacy, allowed.flatMap((manifest) => manifest.supportedRails));
      const decision = await claude.decide<{ action: "select"; capabilityId: string; rationale: string }>({ system: "Choose exactly one suitable policy-approved capability. Never invent prices, rails, authorization, or success claims.", task, candidates: allowed.map(({ capabilityId, sellerId, capability, description, supportedRails }) => ({ capabilityId, sellerId, capability, description, supportedRails })), schema: { name: "select_capability", description: "Select one supplied capability.", properties: { action: { type: "string", enum: ["select"] }, capabilityId: { type: "string" }, rationale: { type: "string", maxLength: 300 } }, required: ["action", "capabilityId", "rationale"] } });
      const selected = allowed.find((manifest) => manifest.capabilityId === decision.action.capabilityId) ?? fail("CLAUDE_OUTPUT_INVALID", "Claude selected a capability outside the approved candidates");
      log.append({ actor: "buyer", stage: "capability-selection", status: "complete", publicDetails: { taskPrivacy: privacy, capabilityId: selected.capabilityId, sellerId: selected.sellerId, model: decision.model, usage: decision.usage, rationale: decision.sanitizedRationale }, evidenceHashes: [selected.manifestHash], explorerLinks: [] }); return selected;
    };
    await choose(workflow.publicTask, "public"); await choose(workflow.confidentialTask, "confidential");
    const challengeResponse = await fetch(workflow.publicResourceUrl, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (challengeResponse.status !== 402) fail("X402_CHALLENGE_REQUIRED", "public seller did not return an x402 challenge");
    const challengeHeader = challengeResponse.headers.get("payment-required") ?? fail("X402_CHALLENGE_INVALID", "public seller challenge omitted PAYMENT-REQUIRED"), challenge = JSON.parse(Buffer.from(challengeHeader, "base64").toString()) as { accepts?: Array<{ amount?: string }> }, sellerMinimum = BigInt(String(challenge.accepts?.[0]?.amount ?? "0")); await challengeResponse.arrayBuffer();
    const agreed = deterministicCounteroffer({ buyerOffer: BigInt(workflow.buyerOpeningAmount), buyerMaximum: BigInt(workflow.buyerMaximum), sellerMinimum });
    if (agreed !== sellerMinimum) fail("NEGOTIATION_PAYMENT_MISMATCH", "deterministic agreement must equal the seller's exact x402 requirement");
    const session = `public-${log.runId}`;
    await mutate(buyer, "offer.open", { "operation-id": `${session}-open`, session });
    await mutate(buyer, "offer.propose", { "operation-id": `${session}-propose`, session, revision: "1", terms: JSON.stringify({ amount: workflow.buyerOpeningAmount, rail: "x402" }) });
    await mutate(publicSeller, "offer.counter", { "operation-id": `${session}-counter`, session, revision: "2", terms: JSON.stringify({ amount: agreed.toString(), rail: "x402" }) });
    await mutate(buyer, "offer.accept", { "operation-id": `${session}-accept`, session, revision: "3", terms: JSON.stringify({ amount: agreed.toString(), rail: "x402" }) });
    log.append({ actor: "supercuts", stage: "negotiation", status: "complete", publicDetails: { session, agreedAmount: agreed.toString(), rail: "x402", pricing: "deterministic" }, evidenceHashes: [], explorerLinks: [] });
    const publicPayment = await mutate(buyer, "pay.x402", { "operation-id": `public-${log.runId}`, "resource-url": workflow.publicResourceUrl });
    const { response: _artifactBytes, ...publicEvidence } = publicPayment;
    log.append({ actor: "buyer", stage: "public-settlement", status: "complete", publicDetails: { rail: "x402", visibility: "public amount and payee", ...publicEvidence }, evidenceHashes: [String(publicPayment.responseSha256 ?? "")].filter(Boolean), explorerLinks: [] });
    const memories = workflow.memories.slice(0, 10); if (memories.length !== 10) fail("DEMO_MEMORY_COUNT", "live workflow must provide exactly ten meaningful first-purchase memories");
    for (let index = 0; index < memories.length; index++) { const remembered = await mutate(buyer, "memory.remember", { "operation-id": `memory-${log.runId}-${index}`, fact: memories[index]! }); log.append({ actor: "buyer", stage: "memory", status: "complete", publicDetails: { index: index + 1, blobId: remembered.blobId }, evidenceHashes: [], explorerLinks: [] }); }
    const privacy = await mutate(buyer, "memory.remember", { "operation-id": `privacy-${log.runId}`, fact: "Sensitive competitive research must hide counterparties and payment terms." });
    log.append({ actor: "supercuts", stage: "privacy-policy", status: "allowed", publicDetails: { recalledRuleStored: true, blobId: privacy.blobId, selectedRail: "shielded", rejectedRail: "x402" }, evidenceHashes: [], explorerLinks: [] });
    const privatePayment = await mutate(buyer, "pay.shielded", { "operation-id": `private-${log.runId}`, session: workflow.shieldedSession });
    log.append({ actor: "buyer", stage: "private-settlement", status: "complete", publicDetails: { rail: "shielded", visibility: "pool transaction; gas submission, funding, deposits and withdrawals are not claimed hidden", transactionDigest: privatePayment.transactionDigest, tatumVerified: privatePayment.tatumVerified }, evidenceHashes: [], explorerLinks: [] });
    return { runId: log.runId, events: eventPath, publicTransaction: publicPayment.transactionDigest, shieldedTransaction: privatePayment.transactionDigest };
  } finally { buyer.close(); publicSeller.close(); confidentialSeller.close(); }
}

async function replay(): Promise<Record<string, unknown>> {
  const path = resolve(value("events", join(stateDir(), "events.jsonl"))), events = recordedReplay(readDemoEvents(path));
  if (args.serve === true) { const port = Number(value("port", "4173")); const dashboard = await serveEventDashboard(path, port, true); process.stderr.write(`recorded funded run: ${dashboard.url}\n`); await new Promise<void>((done) => { process.on("SIGINT", () => { dashboard.server.close(); done(); }); process.on("SIGTERM", () => { dashboard.server.close(); done(); }); }); return { label: "recorded funded run", events: events.length, url: dashboard.url }; }
  return { label: "recorded funded run", freshTransaction: false, events };
}

try { const data = command === "setup" ? await setup() : command === "doctor" ? await doctor() : command === "check" ? check() : command === "live" ? await live() : command === "replay" ? await replay() : fail("COMMAND_UNKNOWN", "use setup, doctor, live, replay, or check"); send(data); }
catch (error) { process.stdout.write(`${JSON.stringify(errorOutput(error))}\n`); process.exitCode = 1; }
