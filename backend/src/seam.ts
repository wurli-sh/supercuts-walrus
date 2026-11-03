#!/usr/bin/env node
import { Phase3App, errorOutput, homePath, initialize, type Role } from "./phase3.js";
import { DealJournal } from "./deal.js";
import { createConfiguredDealEngine } from "./deal-adapter.js";
import { loadMandate } from "./mandate.js";
import { LiveDealPorts } from "./live-deal-ports.js";

const PROTOCOL = 1;
interface SeamRequest { protocol: number; requestId: string; method: string; home?: string; params?: Record<string, unknown>; }
const envelope = (requestId: string | null, value: Record<string, unknown>) => ({ protocol: PROTOCOL, requestId, ...value });
let responded = false;
const write = (value: unknown, status = 0) => { if (responded) return; responded = true; process.stdout.write(`${JSON.stringify(value)}\n`); process.exitCode = status; };
const asArgs = (value: Record<string, unknown> | undefined): Record<string, string | boolean> => {
  const result: Record<string, string | boolean> = {};
  for (const [key, item] of Object.entries(value ?? {})) {
    if (typeof item === "boolean" || typeof item === "string") result[key] = item;
    else if (typeof item === "number" && Number.isSafeInteger(item)) result[key] = String(item);
    else if (item !== undefined) result[key] = Buffer.from(JSON.stringify(item)).toString("base64url");
  }
  return result;
};

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; if (raw.length > 1024 * 1024) process.stdin.destroy(new Error("request exceeds 1 MiB")); });
process.stdin.on("error", (error) => write(envelope(null, { ok: false, error: { code: "SEAM_REQUEST_INVALID", message: error.message, retryable: false } }), 1));
process.stdin.on("end", async () => {
  let request: SeamRequest;
  try { request = JSON.parse(raw) as SeamRequest; } catch { return write(envelope(null, { ok: false, error: { code: "SEAM_REQUEST_INVALID", message: "request is not valid JSON", retryable: false } }), 1); }
  if (!request || request.protocol !== PROTOCOL || typeof request.requestId !== "string" || typeof request.method !== "string") return write(envelope(typeof request?.requestId === "string" ? request.requestId : null, { ok: false, error: { code: "SEAM_PROTOCOL_MISMATCH", message: `supercuts seam protocol ${PROTOCOL} is required`, retryable: false } }), 1);
  try {
    if (request.method === "version") return write(envelope(request.requestId, { ok: true, result: { protocol: PROTOCOL, packageVersion: "0.1.0" } }));
    if (typeof request.home !== "string" || !request.home) return write(envelope(request.requestId, { ok: false, error: { code: "SEAM_HOME_REQUIRED", message: "an explicit role home is required", retryable: false } }), 1);
    if (request.params !== undefined && (!request.params || typeof request.params !== "object" || Array.isArray(request.params))) return write(envelope(request.requestId, { ok: false, error: { code: "SEAM_REQUEST_INVALID", message: "params must be an object", retryable: false } }), 1);
    const params = asArgs(request.params), home = homePath({ home: request.home ?? "" });
    if (request.method === "initialize") {
      const result = initialize(home, { ...params, role: String(request.params?.role ?? "") as Role });
      return write(envelope(request.requestId, { ok: true, result: result.data }));
    }
    const app = new Phase3App(home);
    try {
      if (request.method.startsWith("deal.")) {
        if (app.profile.role !== "buyer") throw Object.assign(new Error("deal methods require a buyer role home"), { code: "ROLE_FORBIDDEN" });
        const journal = new DealJournal(app.store);
        if (request.method === "deal.catalog") {
          const mandate = loadMandate(home);
          const entries = await new LiveDealPorts(app, mandate).catalog();
          return write(envelope(request.requestId, { ok: true, result: { capabilities: entries.map(({ origin, registration }) => ({ origin, manifest: registration.manifest, manifestBlobId: registration.manifestBlobId })) } }));
        }
        if (request.method === "deal.policy") {
          const mandate = loadMandate(home), hasTable = Boolean(app.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mandate_operations'").get());
          const reserved = hasTable ? (app.store.db.prepare("SELECT amount FROM mandate_operations").all() as Array<{ amount: string }>).reduce((sum, row) => sum + BigInt(row.amount), 0n) : 0n;
          return write(envelope(request.requestId, { ok: true, result: { perDealCeiling: mandate.perDealCeiling, totalBudget: mandate.totalRunBudget, remainingBudget: (BigInt(mandate.totalRunBudget) - reserved).toString(), expiresAt: mandate.expiresAt, defaultRail: "shielded", allowPublicX402: mandate.allowPublicX402 === true, allowedAssets: mandate.allowedAssets, allowedCapabilityIds: mandate.allowedCapabilityIds, allowedCapabilityClasses: mandate.allowedCapabilityClasses } }));
        }
        if (request.method === "deal.execute") {
          const engine = await createConfiguredDealEngine(app);
          return write(envelope(request.requestId, { ok: true, result: await engine.execute(request.params?.input as never) }));
        }
        if (request.method === "deal.resume") {
          const engine = await createConfiguredDealEngine(app);
          return write(envelope(request.requestId, { ok: true, result: await engine.resume(String(request.params?.operationId ?? "")) }));
        }
        if (request.method === "deal.get") return write(envelope(request.requestId, { ok: true, result: journal.get(String(request.params?.operationId ?? "")) }));
        if (request.method === "deal.evidence") return write(envelope(request.requestId, { ok: true, result: journal.evidence(String(request.params?.dealId ?? "")) }));
        if (request.method === "deal.delivery") {
          const delivery = journal.delivery(String(request.params?.dealId ?? ""));
          return write(envelope(request.requestId, { ok: true, result: { ...delivery, artifact: Buffer.from(delivery.artifact).toString("base64") } }));
        }
      }
      if (request.method === "authorization.preview") {
        const command = String(request.params?.command ?? ""), commandArgs = asArgs(request.params?.arguments as Record<string, unknown> | undefined);
        return write(envelope(request.requestId, { ok: true, result: app.preview(command, commandArgs) as unknown as Record<string, unknown> }));
      }
      if (request.method === "authorization.approve") return write(envelope(request.requestId, { ok: true, result: app.approve(String(request.params?.challengeId ?? "")) as unknown as Record<string, unknown> }));
      if (request.method === "command.execute") {
        const command = String(request.params?.command ?? ""), commandArgs = asArgs(request.params?.arguments as Record<string, unknown> | undefined);
        if (typeof request.params?.approvalToken === "string") commandArgs["approval-token"] = request.params.approvalToken;
        const result = await app.execute(command, commandArgs); return write(envelope(request.requestId, { ok: true, result: result.data }));
      }
      return write(envelope(request.requestId, { ok: false, error: { code: "SEAM_METHOD_UNKNOWN", message: `unknown seam method ${request.method}`, retryable: false } }), 1);
    } finally { app.close(); }
  } catch (error) {
    const shaped = errorOutput(error) as { error: Record<string, unknown> };
    const code = String(shaped.error.code ?? "INTERNAL_ERROR");
    return write(envelope(request.requestId, { ok: false, error: { ...shaped.error, retryable: ["DELIVERY_IN_PROGRESS", "MEMORY_JOB_PENDING", "TATUM_TIMEOUT"].includes(code) } }), 1);
  }
});
