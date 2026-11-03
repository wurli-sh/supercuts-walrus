#!/usr/bin/env node
import { createInterface } from "node:readline";
import { Phase3App, errorOutput, homePath } from "./phase3.js";
import { executeMandated, loadMandate, toolSchema } from "./mandate.js";
import { RemoteBuyer } from "./remote-buyer.js";
import { DemoEventLog } from "./events.js";
import { DealJournal, type ExecuteDealInput } from "./deal.js";
import { createConfiguredDealEngine } from "./deal-adapter.js";

const home = homePath({});
const app = new Phase3App(home);
const mandate = loadMandate(home);
const remote = app.profile.role === "buyer" && !app.profile.mock && process.env.SUPERCUTS_SELLER_URL ? new RemoteBuyer(app, mandate, process.env.SUPERCUTS_SELLER_URL) : undefined;
const eventLog = remote && process.env.SUPERCUTS_EVENT_PATH && process.env.SUPERCUTS_RUN_ID ? new DemoEventLog(process.env.SUPERCUTS_EVENT_PATH, process.env.SUPERCUTS_RUN_ID) : undefined;
if (eventLog) eventLog.append({ actor: "operator", stage: "run", status: "started", publicDetails: { flow: "codex-remote" }, evidenceHashes: [], explorerLinks: [] });
const tools: Record<string, string> = {
  buyer: "status,doctor,deal.execute,deal.get,deal.resume,capability.discover,settlement.plan,wallet.deposit,wallet.balance,wallet.recover,wallet.withdraw,wallet.exit.queue,wallet.exit.status,wallet.exit.finalize,offer.open,offer.propose,offer.accept,offer.show,pay.quote,pay.shielded,pay.x402,pay.status,resource.fetch,memory.remember,memory.recall,memory.status,memory.inventory,remote.catalog,remote.rank-briefs,remote.negotiate,remote.quote,remote.purchase-brief,remote.agreement,remote.settle-analysis,remote.delivery,remote.events,disclose",
  seller: "status,doctor,capability.publish,wallet.balance,wallet.recover,wallet.withdraw,wallet.exit.queue,wallet.exit.status,wallet.exit.finalize,offer.counter,offer.show,pay.status,resource.serve,resource.fetch,memory.remember,memory.recall,memory.status",
  auditor: "status,doctor,audit.verify",
};
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
function logTool(name: string, data: Record<string, unknown>): void {
  if (!eventLog) return;
  const append = (actor: "buyer" | "supercuts", stage: string, details: Record<string, unknown>, hashes: string[] = []) => eventLog.append({ actor, stage, status: "complete", publicDetails: details, evidenceHashes: hashes, explorerLinks: [] });
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
  if (name === "remote.agreement") {
    const plan = data.plan as Record<string, unknown>;
    const negotiation = data.negotiation as Record<string, unknown> | undefined;
    if (negotiation) append("buyer", "negotiation", { capabilityId: plan.capabilityId, sessionId: negotiation.sessionId, requestBlobId: negotiation.requestBlobId, replyBlobId: negotiation.replyBlobId, transcriptHash: negotiation.transcriptHash }, typeof negotiation.transcriptHash === "string" ? [negotiation.transcriptHash] : []);
    append("buyer", "settlement-plan", { phase: "after-memory", planHash: plan.planHash, capabilityId: plan.capabilityId, rail: plan.rail, openingAmount: plan.openingAmount, maximumAmount: plan.maximumAmount, riskLevel: plan.riskLevel, reasonCodes: plan.reasonCodes, blobIds: (plan.citations as Array<{ blobId: string }> | undefined)?.map((item) => item.blobId) ?? [] }, typeof plan.manifestHash === "string" ? [plan.manifestHash] : []);
  }
  if (name === "remote.settle-analysis") append("buyer", "private-settlement", { rail: "shielded", transactionDigest: data.transactionDigest, checkpoint: data.checkpoint, planHash: data.planHash, visibility: data.visibility }, typeof data.dealCommitment === "string" ? [data.dealCommitment] : []);
  if (name === "remote.delivery" && data.status === "delivered") append("buyer", "artifact-delivery", { kind: "competitor-analysis", artifactSha256: data.artifactSha256, sessionId: data.sessionId }, typeof data.artifactSha256 === "string" ? [data.artifactSha256] : []);
}
const rl = createInterface({ input: process.stdin });
let queue: Promise<unknown> = Promise.resolve();
rl.on("line", (line) => { queue = queue.then(async () => {
  let request: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try { request = JSON.parse(line) as typeof request; } catch { return send({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }); }
  try {
    if (request.method === "initialize") return send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: `supercuts-${app.profile.role}`, version: "0.1.0" } } });
    if (request.method === "notifications/initialized") return;
    if (request.method === "tools/list") return send({ jsonrpc: "2.0", id: request.id, result: { tools: tools[app.profile.role]!.split(",").filter((name) => remote || !name.startsWith("remote.")).map((name) => { const spec = toolSchema(name); return { name, description: spec.description, inputSchema: spec.inputSchema }; }) } });
    if (request.method === "tools/call") {
      const name = String(request.params?.name ?? ""), raw = (request.params?.arguments ?? {}) as Record<string, unknown>;
      let data: Record<string, unknown>;
      if (name.startsWith("deal.")) {
        const spec = toolSchema(name); const { validateToolArguments } = await import("./mandate.js"); validateToolArguments(spec, raw);
        if (mandate.version !== "supercuts.mandate.v2" || Date.now() > mandate.expiresAt || !mandate.allowedCommands.includes(name)) throw new Error("deal tool is not authorized by an active v2 mandate");
        if (name === "deal.execute") {
          const input = raw.input as ExecuteDealInput;
          if (raw["operation-id"] !== input?.operationId) throw new Error("deal operation ID does not match its input");
          data = await (await createConfiguredDealEngine(app)).execute(input) as unknown as Record<string, unknown>;
        } else if (name === "deal.resume") data = await (await createConfiguredDealEngine(app)).resume(String(raw.operationId)) as unknown as Record<string, unknown>;
        else data = new DealJournal(app.store).get(String(raw.operationId)) as unknown as Record<string, unknown>;
      } else if (name.startsWith("remote.")) {
        if (!remote || !mandate.allowedCommands.includes(name) || Date.now() > mandate.expiresAt) throw new Error("remote buyer tool is not authorized or configured");
        const spec = toolSchema(name); const { validateToolArguments } = await import("./mandate.js"); validateToolArguments(spec, raw);
        if (process.env.SUPERCUTS_RUN_ID && name !== "remote.catalog" && name !== "remote.rank-briefs" && raw.runId !== undefined && raw.runId !== process.env.SUPERCUTS_RUN_ID) throw new Error("remote tool run ID differs from this buyer demo run");
        data = name === "remote.catalog" ? await remote.catalog() :
          name === "remote.rank-briefs" ? await remote.rankBriefs(raw as { budget: string; topic: string }) :
          name === "remote.negotiate" ? await remote.negotiate(raw as { capabilityId: string; sessionId: string; runId: string; task: string; opening: string; maximum: string; briefHash?: string }) :
          name === "remote.quote" ? await remote.quote(raw as { capabilityId: string; operationId: string; requestId: string; runId: string; task: string; briefHash?: string }) :
          name === "remote.purchase-brief" ? await remote.purchaseBrief(raw as { capabilityId: string; operationId: string; requestId: string; runId: string; task: string; budget: string }) :
          name === "remote.agreement" ? await remote.agreement(raw as { capabilityId: string; operationId: string; sessionId: string; runId: string; briefHash: string }) :
          name === "remote.settle-analysis" ? await remote.settleAnalysis(raw as { sessionId: string; operationId: string }) :
          name === "remote.delivery" ? await remote.delivery(raw as { sessionId: string; operationId: string }) :
          name === "remote.events" ? await remote.events(String(raw.runId)) : {};
      } else data = await executeMandated(app, mandate, name, raw);
      logTool(name, data);
      const result = { schemaVersion: "supercuts.v1", ok: true, command: name, data };
      return send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
    }
    return send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
  } catch (error) { return send({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: JSON.stringify(errorOutput(error)) }], structuredContent: errorOutput(error) } }); }
  }).catch((error) => send({ jsonrpc: "2.0", error: { code: -32603, message: error instanceof Error ? error.message : "Internal error" }, id: null })); });
const close = () => { app.close(); process.exit(0); };
process.on("SIGINT", close); process.on("SIGTERM", close);
