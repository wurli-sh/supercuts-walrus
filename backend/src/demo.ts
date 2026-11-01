#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { DemoEventLog, readDemoEvents, recordedReplay } from "./events.js";
import { Phase3App, errorOutput, initialize, parseArgs } from "./phase3.js";
import { serveEventDashboard } from "./dashboard.js";
import { fail } from "./errors.js";
import { validateCapabilityManifest, type CapabilityManifest } from "./capability.js";
import { deterministicCounteroffer } from "./procurement.js";
import { BoundedClaude } from "./claude.js";

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
  const common: Record<string, string | boolean> = mock ? { mock: true } : { "deployment-config": resolve(value("deployment-config")), "tatum-key-file": resolve(value("tatum-key-file")), "write-grpc": value("write-grpc"), "tatum-grpc": value("tatum-grpc"), "walrus-publisher": value("walrus-publisher"), "walrus-aggregator": value("walrus-aggregator"), ...(typeof args.rapidsnark === "string" ? { rapidsnark: resolve(args.rapidsnark) } : {}) };
  const roleInputs: Array<[keyof typeof roles, "buyer" | "seller" | "auditor", string]> = [["buyer", "buyer", keys.buyer], ["publicSeller", "seller", keys.publicSeller], ["confidentialSeller", "seller", keys.confidentialSeller], ["auditor", "auditor", keys.auditor]];
  for (const [name, role, key] of roleInputs) {
    if (existsSync(join(roles[name], "profile.json"))) continue;
    initialize(roles[name], { role, ...common, ...(!mock ? { "sui-key-file": key } : {}), ...(role === "buyer" ? { "allow-counterparty": `${addresses.publicSeller},${addresses.confidentialSeller},public-seller,confidential-seller`, ...(typeof args["memory-config-file"] === "string" ? { "memory-config-file": resolve(args["memory-config-file"]) } : {}) } : {}) });
  }
  const workflowPath = typeof args.workflow === "string" ? resolve(args.workflow) : !mock ? resolve(value("workflow")) : undefined;
  if (workflowPath) {
    const workflow = JSON.parse(readFileSync(workflowPath, "utf8")) as { capabilities?: CapabilityManifest[] }, capabilities = workflow.capabilities ?? [];
    if (!capabilities.length) fail("DEMO_CAPABILITIES_REQUIRED", "live workflow must provide capability manifests for the buyer mandate"); for (const manifest of capabilities) validateCapabilityManifest(manifest);
    const mandatePath = join(roles.buyer, "mandate.json"), mandate = JSON.parse(readFileSync(mandatePath, "utf8")) as Record<string, unknown>;
    mandate.requireSettlementPlan = true; mandate.allowedCommands = [...new Set([...(Array.isArray(mandate.allowedCommands) ? mandate.allowedCommands as string[] : []), "settlement.plan"])]; mandate.allowedCapabilityIds = [...new Set(capabilities.map((item) => item.capabilityId))]; mandate.allowedCapabilityClasses = [...new Set(capabilities.map((item) => item.capability))]; mandate.allowedRails = [...new Set(capabilities.flatMap((item) => item.supportedRails))];
    writeFileSync(mandatePath, `${JSON.stringify(mandate, null, 2)}\n`, { mode: 0o600 }); chmodSync(mandatePath, 0o600);
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
  if (existsSync(eventPath)) {
    const text = readFileSync(eventPath, "utf8"); if (/(?:suiprivkey|BEGIN [A-Z ]*PRIVATE KEY|approval.?token|note.?opening|full.?prompt)/i.test(text)) fail("SECRET_SCAN_FAILED", "event bundle contains forbidden secret material"); const events = readDemoEvents(eventPath); checked.push(eventPath);
    if (args["require-claude"] === true && !["buyer", "public-seller", "confidential-seller"].every((actor) => events.some((event) => event.actor === actor && event.stage === "agent-decision" && event.status === "complete" && typeof event.publicDetails.model === "string" && Number(event.publicDetails.outputTokens) > 0))) fail("DEMO_CLAUDE_EVIDENCE_MISSING", "event stream is missing live Claude decisions from a buyer or seller agent");
    const decisionKeys: Record<string, Set<string>> = { "settlement-plan": new Set(["phase", "planHash", "capabilityId", "rail", "openingAmount", "maximumAmount", "riskLevel", "reasonCodes", "blobIds"]), "memory-recall": new Set(["restarted", "citations", "policyBlobId"]) };
    for (const event of events) { const allowed = decisionKeys[event.stage]; if (allowed && Object.keys(event.publicDetails).some((key) => !allowed.has(key))) fail("DEMO_DECISION_EVENT_INVALID", `${event.stage} contains a non-allowlisted public field`); }
    if (events.some((event) => event.stage === "settlement-plan")) {
      const memoryBlobIds = events.filter((event) => event.stage === "memory" && event.status === "complete").map((event) => String(event.publicDetails.blobId ?? ""));
      if (memoryBlobIds.length < 10 || new Set(memoryBlobIds).size < 10 || memoryBlobIds.some((id) => !id || id.startsWith("mockwalrus_")) || !events.some((event) => event.stage === "memory-recall" && event.publicDetails.restarted === true && Array.isArray(event.publicDetails.citations) && event.publicDetails.citations.some((citation) => citation.kind === "privacy_rule" && citation.provenance === "owner_policy")) || !events.some((event) => event.stage === "settlement-plan" && event.publicDetails.phase === "after-memory" && event.publicDetails.rail === "shielded" && Array.isArray(event.publicDetails.reasonCodes) && event.publicDetails.reasonCodes.includes("MEMORY_PRIVACY_APPLIED")) || !events.some((event) => event.stage === "public-settlement" && event.status === "complete") || !events.some((event) => event.stage === "artifact-delivery" && event.status === "complete") || !events.some((event) => event.stage === "private-settlement" && event.status === "complete" && event.evidenceHashes.length > 0)) fail("DEMO_ACCEPTANCE_INCOMPLETE", "event stream does not contain the required memory-native funded settlement sequence");
    }
  }
  return { healthy: true, checked, secretScan: "pass" };
}

async function live(): Promise<Record<string, unknown>> {
  const root = stateDir(), workflow = JSON.parse(readFileSync(resolve(value("workflow")), "utf8")) as { publicResourceUrl: string; publicOperationId: string; shieldedSession: string; buyerDepositAmount: string; memories: string[]; capabilities: CapabilityManifest[]; publicTask: string; confidentialTask: string; buyerOpeningAmount: string; buyerMaximum: string }, eventPath = typeof args.events === "string" ? resolve(args.events) : join(root, "events.jsonl"), log = new DemoEventLog(eventPath, randomUUID(), "live"), roleHomes = homes(root); let buyer = new Phase3App(roleHomes.buyer); const publicSeller = new Phase3App(roleHomes.publicSeller), confidentialSeller = new Phase3App(roleHomes.confidentialSeller);
  if (buyer.profile.mock) fail("LIVE_PROFILE_REQUIRED", "supercuts-demo live refuses mock profiles");
  const claudeKeyPath = resolve(value("claude-key-file"));
  if ((statSync(claudeKeyPath).mode & 0o077) !== 0) fail("CREDENTIAL_PERMISSIONS", "Claude key file must be owner-only");
  const claudeKey = readFileSync(claudeKeyPath, "utf8").trim();
  const claude = (actor: "buyer" | "public-seller" | "confidential-seller") => new BoundedClaude({ apiKey: claudeKey, onDecision: (entry) => log.append({ actor, stage: "agent-decision", status: "complete", publicDetails: { model: entry.model, action: entry.action, inputTokens: entry.usage.inputTokens, outputTokens: entry.usage.outputTokens }, evidenceHashes: [], explorerLinks: [] }) });
  const mutate = async (app: Phase3App, name: string, parameters: Record<string, string | boolean>) => { const intent = app.preview(name, parameters), approval = app.approve(intent.challengeId); return (await app.execute(name, { ...parameters, "approval-token": approval.token })).data; };
  try {
    log.append({ actor: "operator", stage: "run", status: "started", publicDetails: { label: "fresh funded run" }, evidenceHashes: [], explorerLinks: [] });
    for (const manifest of workflow.capabilities) validateCapabilityManifest(manifest);
    const publicCapabilities = workflow.capabilities.filter((item) => item.supportedRails.includes("x402") && item.endpoint === workflow.publicResourceUrl), confidentialCapabilities = workflow.capabilities.filter((item) => item.supportedRails.includes("shielded"));
    if (!publicCapabilities.length || !confidentialCapabilities.length) fail("DEMO_CAPABILITIES_REQUIRED", "workflow must contain matching public x402 and confidential shielded capabilities");
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
    for (let index = 0; index < memories.length; index++) { const envelope = { version: "supercuts.settlement-memory.v1", kind: index % 2 ? "quality" : "reliability", observation: memories[index], scope: { capabilityId: String(publicPlan.capabilityId), counterparty: String(publicPlan.sellerId), network: "sui:testnet", asset: String(publicPlan.asset) }, createdAt: Date.now() + index, signal: index % 2 ? { quality: Math.min(1, 0.8 + index / 100) } : { reliability: Math.min(1, 0.8 + index / 100) } }; const remembered = await mutate(buyer, "memory.remember", { "operation-id": `memory-${log.runId}-${index}`, memory: Buffer.from(JSON.stringify(envelope)).toString("base64url") }); log.append({ actor: "buyer", stage: "memory", status: "complete", publicDetails: { index: index + 1, blobId: remembered.blobId, kind: remembered.kind, provenance: remembered.provenance }, evidenceHashes: [], explorerLinks: [] }); }
    const confidential = confidentialCapabilities[0]!, policyEnvelope = { version: "supercuts.settlement-memory.v1", kind: "privacy_rule", scope: { capabilityId: confidential.capabilityId, counterparty: confidential.sellerId, network: "sui:testnet", asset: confidential.asset }, createdAt: Date.now() + 20, signal: { requiresShielded: true } };
    const privacy = await mutate(buyer, "memory.policy", { "operation-id": `privacy-${log.runId}`, memory: Buffer.from(JSON.stringify(policyEnvelope)).toString("base64url") });
    buyer.close(); buyer = new Phase3App(roleHomes.buyer);
    const recalled = (await buyer.execute("memory.recall", { query: `${confidential.capabilityId} privacy settlement` })).data;
    log.append({ actor: "supercuts", stage: "memory-recall", status: "complete", publicDetails: { restarted: true, citations: recalled.citations, policyBlobId: privacy.blobId }, evidenceHashes: [], explorerLinks: [] });
    if (!confidential.supportedRails.includes("x402")) fail("DEMO_PRIVACY_ALTERNATIVE_REQUIRED", "confidential capability must offer x402 and shielded rails to demonstrate memory-driven selection");
    if (!(recalled.citations as Array<{ blobId: string; kind: string }>).some((item) => item.blobId === privacy.blobId && item.kind === "privacy_rule")) fail("DEMO_PRIVACY_RECALL_MISSING", "owner privacy rule was not cited by Walrus Memory recall");
    const privateOperation = `private-${log.runId}`, privatePlan = await mutate(buyer, "settlement.plan", { "operation-id": privateOperation, manifest: Buffer.from(JSON.stringify(confidential)).toString("base64url"), alternatives: Buffer.from(JSON.stringify(confidentialCapabilities.slice(1))).toString("base64url"), "requested-amount": confidential.priceBand.minimum });
    if (privatePlan.rail !== "shielded" || !(privatePlan.reasonCodes as string[]).includes("MEMORY_PRIVACY_APPLIED")) fail("DEMO_PRIVACY_PLAN_MISSING", "the recalled owner policy did not select shielded settlement");
    await claude("buyer").decide<{ action: string }>({ system: "You are the buyer agent. The owner privacy rule and approved settlement plan require the shielded rail. You may only choose the approved next action.", task: workflow.confidentialTask, candidates: [{ action: "proceed_shielded", capabilityId: privatePlan.capabilityId, rail: privatePlan.rail }], schema: { name: "choose_private_action", description: "Choose the policy-approved action.", properties: { action: { type: "string", enum: ["proceed_shielded"] } }, required: ["action"] } });
    log.append({ actor: "buyer", stage: "settlement-plan", status: "complete", publicDetails: { phase: "after-memory", planHash: privatePlan.planHash, capabilityId: privatePlan.capabilityId, rail: privatePlan.rail, openingAmount: privatePlan.openingAmount, maximumAmount: privatePlan.maximumAmount, riskLevel: privatePlan.riskLevel, reasonCodes: privatePlan.reasonCodes, blobIds: (privatePlan.citations as Array<{ blobId: string }>).map((item) => item.blobId) }, evidenceHashes: [String(privatePlan.manifestHash)], explorerLinks: [] });
    const depositAmount = BigInt(workflow.buyerDepositAmount ?? "0");
    if (depositAmount <= BigInt(confidential.priceBand.minimum)) fail("DEMO_DEPOSIT_INSUFFICIENT", "buyerDepositAmount must exceed the confidential payment to leave a change note");
    await mutate(buyer, "wallet.deposit", { "operation-id": `deposit-${log.runId}`, amount: depositAmount.toString() });
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
    log.append({ actor: "buyer", stage: "private-settlement", status: "complete", publicDetails: { rail: "shielded", visibility: "no direct public payment reveals the deal amount or counterparty; funding, deposits, withdrawals, gas, and pool activity remain visible", transactionDigest: privatePayment.transactionDigest, tatumVerified: privatePayment.tatumVerified, prover: privatePayment.prover }, evidenceHashes: [String(privatePayment.dealCommitment ?? "")].filter(Boolean), explorerLinks: [] });
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
