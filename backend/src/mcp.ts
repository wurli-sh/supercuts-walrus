#!/usr/bin/env node
import { createInterface } from "node:readline";
import { Phase3App, errorOutput, homePath } from "./phase3.js";
import { executeMandated, loadMandate, toolSchema } from "./mandate.js";
import { RemoteBuyer } from "./remote-buyer.js";
import { DemoEventLog } from "./events.js";
import { DealJournal, type ExecuteDealInput } from "./deal.js";
import { createConfiguredDealEngine } from "./deal-adapter.js";
import { LiveDealPorts } from "./live-deal-ports.js";
import type { SettlementPlanV1 } from "./settlement.js";
import { createRequire } from "node:module";
import { fail } from "./errors.js";
import { acquireRoleHomeLease } from "./role-lock.js";

const PACKAGE_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
const MAX_REQUEST_BYTES = 1024 * 1024;

const home = homePath({});
const app = new Phase3App(home);
const roleLease = acquireRoleHomeLease(home);
const mandate = loadMandate(home);
const remote = roleLease.acquired && app.profile.role === "buyer" && !app.profile.mock && process.env.SUPERCUTS_SELLER_URL ? new RemoteBuyer(app, mandate, process.env.SUPERCUTS_SELLER_URL) : undefined;
const eventLog = roleLease.acquired && process.env.SUPERCUTS_EVENT_PATH && process.env.SUPERCUTS_RUN_ID ? new DemoEventLog(process.env.SUPERCUTS_EVENT_PATH, process.env.SUPERCUTS_RUN_ID) : undefined;
if (eventLog) eventLog.append({ actor: "operator", stage: "run", status: "started", publicDetails: { flow: remote ? "codex-remote" : "codex-deal-v2" }, evidenceHashes: [], explorerLinks: [] });
let memoryTickRunning = false;
const memoryTick = async () => {
  if (memoryTickRunning) return;
  memoryTickRunning = true;
  try { await app.processMemoryOutbox(); }
  catch (error) { process.stderr.write(`${error && typeof error === "object" && "code" in error ? String(error.code) : "MEMORY_WORKER_ERROR"}\n`); }
  finally { memoryTickRunning = false; }
};
const memoryConfigured = roleLease.acquired && app.profile.role === "buyer" && !app.profile.mock && Boolean(app.store.getSecret("live:memory-config"));
if (memoryConfigured) app.recoverStaleMemorySubmissions();
const memoryTimer = memoryConfigured ? setInterval(() => { void memoryTick(); }, 30_000) : undefined;
if (memoryTimer) { memoryTimer.unref(); void memoryTick(); }
const tools: Record<string, string> = {
  buyer: "status,doctor,deal.catalog,deal.policy,deal.execute,deal.get,deal.resume,deal.reconcile,deal.evidence,deal.delivery,capability.discover,settlement.plan,wallet.deposit,wallet.balance,wallet.recover,wallet.withdraw,wallet.exit.queue,wallet.exit.status,wallet.exit.finalize,offer.open,offer.propose,offer.accept,offer.show,pay.quote,pay.shielded,pay.x402,pay.status,resource.fetch,memory.remember,memory.recall,memory.status,memory.inventory,remote.catalog,remote.rank-briefs,remote.negotiate,remote.quote,remote.purchase-brief,remote.agreement,remote.settle-analysis,remote.delivery,remote.events,remote.research,disclose",
  seller: "status,doctor,capability.publish,wallet.balance,wallet.recover,wallet.withdraw,wallet.exit.queue,wallet.exit.status,wallet.exit.finalize,offer.counter,offer.show,pay.status,resource.serve,resource.fetch,memory.remember,memory.recall,memory.status",
  auditor: "status,doctor,audit.verify",
};
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
function logTool(name: string, data: Record<string, unknown>): void {
  if (!eventLog) return;
  const append = (actor: "buyer" | "supercuts" | "confidential-seller", stage: string, details: Record<string, unknown>, hashes: string[] = []) => eventLog.append({ actor, stage, status: "complete", publicDetails: details, evidenceHashes: hashes, explorerLinks: [] });
  if (name === "remote.research") {
    if (data.replayed === true) return;
    logTool("remote.rank-briefs", data.selection as Record<string, unknown>);
    logTool("remote.purchase-brief", data.brief as Record<string, unknown>);
    logTool("remote.agreement", data.agreement as Record<string, unknown>);
    logTool("remote.settle-analysis", data.settlement as Record<string, unknown>);
    logTool("remote.delivery", data.analysis as Record<string, unknown>);
    return;
  }
  if (name === "remote.rank-briefs") append("buyer", "seller-selection", { winner: (data.winner as Record<string, unknown> | undefined)?.capabilityId, rankings: (data.rankings as Array<Record<string, unknown>> | undefined)?.map((item) => ({ capabilityId: item.capabilityId, score: item.score, priceMist: item.priceMist })) });
  if (name === "remote.negotiate") append("buyer", "negotiation", { capabilityId: data.capabilityId, sessionId: data.sessionId, requestBlobId: data.requestBlobId, replyBlobId: data.replyBlobId, transcriptHash: data.transcriptHash }, typeof data.transcriptHash === "string" ? [data.transcriptHash] : []);
  if (name === "remote.purchase-brief") {
    const negotiation = data.negotiation as Record<string, unknown> | undefined;
    if (negotiation) append("buyer", "negotiation", { capabilityId: data.capabilityId, sessionId: negotiation.sessionId, requestBlobId: negotiation.requestBlobId, replyBlobId: negotiation.replyBlobId, transcriptHash: negotiation.transcriptHash }, typeof negotiation.transcriptHash === "string" ? [negotiation.transcriptHash] : []);
    append("buyer", "public-settlement", { rail: "x402", capabilityId: data.capabilityId, transactionDigest: data.transactionDigest, amount: data.amount, payee: data.payee, planHash: data.planHash });
    append("buyer", "artifact-delivery", { capabilityId: data.capabilityId, artifactSha256: data.artifactSha256, kind: "public-brief" }, typeof data.artifactSha256 === "string" ? [data.artifactSha256] : []);
  }
  if (name === "memory.remember") append("buyer", "memory", { blobId: data.blobId, kind: data.kind, provenance: data.provenance });
  if (name === "memory.recall") append("supercuts", "memory-recall", { citations: data.citations, restarted: false });
  if (name === "wallet.deposit" && typeof data.transactionDigest === "string") append("buyer", "prefunding", { transactionDigest: data.transactionDigest, amount: data.amount });
  if (name === "wallet.exit.queue") append(app.profile.role === "seller" ? "confidential-seller" : "buyer", "delayed-exit", { state: data.status, amount: data.amount, operationId: data.operationId });
  if (name === "remote.agreement") {
    const plan = data.plan as Record<string, unknown>;
    const negotiation = data.negotiation as Record<string, unknown> | undefined;
    if (negotiation) append("buyer", "negotiation", { capabilityId: plan.capabilityId, sessionId: negotiation.sessionId, requestBlobId: negotiation.requestBlobId, replyBlobId: negotiation.replyBlobId, transcriptHash: negotiation.transcriptHash }, typeof negotiation.transcriptHash === "string" ? [negotiation.transcriptHash] : []);
    append("buyer", "settlement-plan", { phase: "after-memory", planHash: plan.planHash, capabilityId: plan.capabilityId, rail: plan.rail, openingAmount: plan.openingAmount, maximumAmount: plan.maximumAmount, riskLevel: plan.riskLevel, reasonCodes: plan.reasonCodes, blobIds: (plan.citations as Array<{ blobId: string }> | undefined)?.map((item) => item.blobId) ?? [] }, typeof plan.manifestHash === "string" ? [plan.manifestHash] : []);
  }
  if (name === "remote.settle-analysis") append("buyer", "private-settlement", { rail: "shielded", transactionDigest: data.transactionDigest, checkpoint: data.checkpoint, planHash: data.planHash, visibility: data.visibility }, typeof data.dealCommitment === "string" ? [data.dealCommitment] : []);
  if (name === "remote.delivery" && data.status === "delivered") append("buyer", "artifact-delivery", { kind: "competitor-analysis", artifactSha256: data.artifactSha256, sessionId: data.sessionId }, typeof data.artifactSha256 === "string" ? [data.artifactSha256] : []);
  if ((name === "deal.execute" || name === "deal.resume" || name === "deal.get") && typeof data.dealId === "string") {
    const journal = new DealJournal(app.store), evidence = journal.evidence(data.dealId);
    const plan = journal.step<SettlementPlanV1>(String(data.operationId), "planning");
    if (plan) append("supercuts", "settlement-plan", { phase: "after-memory", planHash: plan.planHash, capabilityId: plan.capabilityId, rail: plan.rail, openingAmount: plan.openingAmount, maximumAmount: plan.maximumAmount, riskLevel: plan.riskLevel, reasonCodes: plan.reasonCodes, blobIds: plan.citations.map((item) => item.blobId) });
    append("supercuts", "deal-lifecycle", { dealId: data.dealId, state: data.state, rail: data.rail, agreement: (data.evidence as Record<string, unknown> | undefined)?.agreement, payment: (data.evidence as Record<string, unknown> | undefined)?.payment, delivery: (data.evidence as Record<string, unknown> | undefined)?.delivery, outcomeMemory: (data.evidence as Record<string, unknown> | undefined)?.outcomeMemory, agreementBlobId: evidence.agreementBlobId, deliveryBlobId: evidence.deliveryBlobId, outcomeMemoryBlobId: evidence.outcomeMemoryBlobId, paymentDigest: evidence.paymentDigest });
  }
}
const rl = createInterface({ input: process.stdin });
let queue: Promise<unknown> = Promise.resolve();
rl.on("line", (line) => { queue = queue.then(async () => {
  if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) return send({ jsonrpc: "2.0", error: { code: -32600, message: "Request exceeds 1 MiB" }, id: null });
  let request: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try { request = JSON.parse(line) as typeof request; } catch { return send({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }); }
  if (!request || typeof request !== "object" || request.method !== undefined && typeof request.method !== "string" || request.id !== undefined && typeof request.id !== "string" && typeof request.id !== "number" && request.id !== null || request.params !== undefined && (!request.params || typeof request.params !== "object" || Array.isArray(request.params))) return send({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid JSON-RPC request" }, id: null });
  try {
    if (request.method === "initialize") return send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: `supercuts-${app.profile.role}`, version: PACKAGE_VERSION } } });
    if (request.method === "notifications/initialized") return;
    const available = tools[app.profile.role]!.split(",").filter((name) => (roleLease.acquired || name === "status") && (remote || !name.startsWith("remote.")) && (app.profile.mock || memoryConfigured || !name.startsWith("memory.")) && (!name.startsWith("deal.") || mandate.version === "supercuts.mandate.v2") && (["status", "doctor"].includes(name) || mandate.allowedCommands.includes(name === "deal.reconcile" ? "deal.resume" : name)));
    if (request.method === "tools/list") return send({ jsonrpc: "2.0", id: request.id, result: { tools: available.map((name) => { const spec = toolSchema(name); return { name, description: spec.description, inputSchema: spec.inputSchema }; }) } });
    if (request.method === "tools/call") {
      const name = String(request.params?.name ?? ""), raw = (request.params?.arguments ?? {}) as Record<string, unknown>;
      if (!available.includes(name)) return send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Tool is unavailable for this role or configuration" } });
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Tool arguments must be an object" } });
      let data: Record<string, unknown>;
      if (name.startsWith("deal.")) {
        const spec = toolSchema(name); const { validateToolArguments } = await import("./mandate.js"); validateToolArguments(spec, raw);
        if (mandate.version !== "supercuts.mandate.v2" || !mandate.allowedCommands.includes(name === "deal.reconcile" ? "deal.resume" : name) || (name === "deal.execute" || name === "deal.resume") && Date.now() > mandate.expiresAt) fail("DEAL_MANDATE_INACTIVE", "deal tool is not authorized by an active v2 mandate");
        if (name === "deal.catalog") data = { capabilities: (await new LiveDealPorts(app, mandate).catalog()).map(({ origin, registration }) => ({ origin, manifest: registration.manifest, manifestBlobId: registration.manifestBlobId })) };
        else if (name === "deal.policy") {
          const hasTable = Boolean(app.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mandate_operations'").get());
          const reserved = hasTable ? (app.store.db.prepare("SELECT amount FROM mandate_operations").all() as Array<{ amount: string }>).reduce((sum, row) => sum + BigInt(row.amount), 0n) : 0n;
          data = { perDealCeiling: mandate.perDealCeiling, totalBudget: mandate.totalRunBudget, remainingBudget: (BigInt(mandate.totalRunBudget) - reserved).toString(), expiresAt: mandate.expiresAt, defaultRail: "shielded", allowPublicX402: mandate.allowPublicX402 === true, allowedAssets: mandate.allowedAssets, allowedCapabilityIds: mandate.allowedCapabilityIds, allowedCapabilityClasses: mandate.allowedCapabilityClasses };
        }
        else if (name === "deal.evidence") data = new DealJournal(app.store).evidence(String(raw.dealId)) as unknown as Record<string, unknown>;
        else if (name === "deal.reconcile") data = await app.reconcileDealOutcome(String(raw.operationId)) as unknown as Record<string, unknown>;
        else if (name === "deal.delivery") {
          const delivery = new DealJournal(app.store).delivery(String(raw.dealId));
          data = { dealId: delivery.dealId, contentType: delivery.contentType, artifactSha256: delivery.artifactSha256, artifactBase64: Buffer.from(delivery.artifact).toString("base64") };
        }
        else if (name === "deal.execute") {
          const input = raw.input as ExecuteDealInput;
          if (raw["operation-id"] !== input?.operationId) throw new Error("deal operation ID does not match its input");
          data = await (await createConfiguredDealEngine(app)).execute(input) as unknown as Record<string, unknown>;
        } else if (name === "deal.resume") data = await (await createConfiguredDealEngine(app)).resume(String(raw.operationId)) as unknown as Record<string, unknown>;
        else data = new DealJournal(app.store).get(String(raw.operationId)) as unknown as Record<string, unknown>;
      } else if (name.startsWith("remote.")) {
        const buyer = remote ?? fail("REMOTE_MANDATE_INACTIVE", "remote buyer tool is not configured");
        if (!mandate.allowedCommands.includes(name) || Date.now() > mandate.expiresAt) fail("REMOTE_MANDATE_INACTIVE", "remote buyer tool is not authorized by an active mandate");
        if (!["remote.catalog", "remote.rank-briefs"].includes(name) && raw.runId === undefined && process.env.SUPERCUTS_RUN_ID) raw.runId = process.env.SUPERCUTS_RUN_ID;
        const spec = toolSchema(name); const { validateToolArguments } = await import("./mandate.js"); validateToolArguments(spec, raw);
        if (process.env.SUPERCUTS_RUN_ID && name !== "remote.catalog" && name !== "remote.rank-briefs" && raw.runId !== undefined && raw.runId !== process.env.SUPERCUTS_RUN_ID) fail("SESSION_MISMATCH", "remote tool run ID differs from the active buyer session");
        data = name === "remote.catalog" ? await buyer.catalog() :
          name === "remote.rank-briefs" ? await buyer.rankBriefs(raw as { budget: string; topic: string }) :
          name === "remote.negotiate" ? await buyer.negotiate(raw as { capabilityId: string; sessionId: string; runId: string; task: string; opening: string; maximum: string; briefHash?: string }) :
          name === "remote.quote" ? await buyer.quote(raw as { capabilityId: string; operationId: string; requestId: string; runId: string; task: string; briefHash?: string }) :
          name === "remote.purchase-brief" ? await buyer.purchaseBrief(raw as { capabilityId: string; operationId: string; requestId: string; runId: string; task: string; budget: string }) :
          name === "remote.agreement" ? await buyer.agreement(raw as { capabilityId: string; operationId: string; sessionId: string; runId: string; briefHash: string }) :
          name === "remote.settle-analysis" ? await buyer.settleAnalysis(raw as { sessionId: string; operationId: string }) :
          name === "remote.delivery" ? await buyer.delivery(raw as { sessionId: string; operationId: string }) :
          name === "remote.events" ? await buyer.events(String(raw.runId)) :
          name === "remote.research" ? await buyer.research({ operationId: String(raw["operation-id"]), runId: String(raw.runId), topic: String(raw.topic), budget: String(raw.budget) }) : {};
      } else data = await executeMandated(app, mandate, name, raw);
      if (name === "status") data = { ...data, session: { runId: process.env.SUPERCUTS_RUN_ID ?? null }, roleHomeLease: roleLease.acquired ? "acquired" : "busy", ...(roleLease.ownerPid ? { roleHomeOwnerPid: roleLease.ownerPid } : {}) };
      logTool(name, data);
      const result = { schemaVersion: "supercuts.v1", ok: true, command: name, data };
      return send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
    }
    return send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
  } catch (error) { return send({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: JSON.stringify(errorOutput(error)) }], structuredContent: errorOutput(error) } }); }
  }).catch((error) => send({ jsonrpc: "2.0", error: { code: -32603, message: error instanceof Error ? error.message : "Internal error" }, id: null })); });
const close = () => { if (memoryTimer) clearInterval(memoryTimer); roleLease.release(); app.close(); process.exit(0); };
process.on("SIGINT", close); process.on("SIGTERM", close);
process.on("exit", () => roleLease.release());
