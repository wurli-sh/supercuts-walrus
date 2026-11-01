import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Phase3App, initialize } from "../src/phase3.js";

const backend = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(backend, "src", "cli.ts");
const mcp = join(backend, "src", "mcp.ts");
const root = mkdtempSync(join(tmpdir(), "supercuts-phase3-"));
const homes = { buyer: join(root, "buyer"), seller: join(root, "seller"), auditor: join(root, "auditor") };

type Reply = { ok: boolean; command?: string; data?: Record<string, any>; error?: { code: string } };
function run(home: string, ...args: string[]): Reply {
  const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args, "--home", home], { cwd: backend, encoding: "utf8" });
  assert.ok(result.stdout.trim(), result.stderr); const reply = JSON.parse(result.stdout.trim()) as Reply;
  assert.equal(result.status, reply.ok ? 0 : 1, result.stdout); return reply;
}
function good(home: string, ...args: string[]): Record<string, any> {
  const reply = run(home, ...args); assert.equal(reply.ok, true, JSON.stringify(reply)); return reply.data!;
}

test("phase 3 installed CLI completes a role-separated mock workflow and restart", () => {
  for (const [role, home] of Object.entries(homes)) good(home, "init", "--role", role, "--mock");
  const doctor = good(homes.buyer, "doctor"); assert.equal(doctor.healthy, true); assert.equal(doctor.rpc, "mock-not-funded");
  const deposited = good(homes.buyer, "wallet", "deposit", "--amount", "500", "--authorize");
  assert.match(deposited.transactionDigest, /^mocktx_/); assert.equal(deposited.evidence, "deterministic-mock-not-funded");
  assert.equal(good(homes.buyer, "wallet", "balance").available, "500");

  const opened = good(homes.buyer, "offer", "open", "--authorize");
  good(homes.buyer, "offer", "propose", "--session", opened.sessionId, "--revision", "1", "--terms", "price=120", "--authorize");
  const counter = good(homes.seller, "offer", "counter", "--session", opened.sessionId, "--revision", "2", "--terms", "price=100", "--authorize");
  assert.equal(counter.state, "counter");
  const accepted = good(homes.buyer, "offer", "accept", "--session", opened.sessionId, "--revision", "3", "--terms", "price=100", "--authorize");
  assert.equal(accepted.state, "accept");

  for (let i = 0; i < 10; i++) good(homes.buyer, "memory", "remember", "--operation-id", `memory-${i}`, "--fact", `${i === 9 ? "seller-a reliable" : `workflow fact ${i}`}`, "--authorize");
  assert.equal(good(homes.buyer, "memory", "status").completed, 10);
  assert.equal(good(homes.buyer, "memory", "recall", "--query", "reliable").effect, "candidate-preference-adjusted");

  const broadcast = good(homes.buyer, "pay", "shielded", "--operation-id", "pay-1", "--amount", "100", "--counterparty", "seller-a", "--request-id", "resource-1", "--broadcast-only", "--authorize");
  assert.equal(broadcast.status, "broadcast");
  const reconciled = good(homes.buyer, "pay", "status", "--operation-id", "pay-1", "--reconcile");
  assert.equal(reconciled.status, "finalized"); assert.equal(reconciled.tatumVerified, true);
  const retried = good(homes.buyer, "pay", "shielded", "--operation-id", "pay-1", "--amount", "100", "--counterparty", "seller-a", "--request-id", "resource-1", "--authorize");
  assert.equal(retried.transactionDigest, reconciled.transactionDigest);
  const x402 = good(homes.buyer, "pay", "x402", "--operation-id", "pay-x402", "--amount", "20", "--counterparty", "seller-a", "--request-id", "resource-x402", "--authorize");
  assert.equal(x402.visibility, "public-transfer"); assert.equal(x402.tatumVerified, true);
  good(homes.seller, "resource", "serve", "--request-id", "resource-1", "--body", "artifact bytes", "--authorize");
  const fetched = good(homes.buyer, "resource", "fetch", "--request-id", "resource-1", "--operation-id", "pay-1", "--response", "artifact bytes");
  assert.equal(fetched.deliveryStatus, "delivered");
  good(homes.seller, "wallet", "recover", "--commitment", "seller-payment-note", "--amount", "100", "--authorize");
  const sellerWithdrawal = good(homes.seller, "wallet", "withdraw", "--commitment", "seller-payment-note", "--authorize"); assert.equal(sellerWithdrawal.amount, "100");

  const denied = run(homes.buyer, "pay", "x402", "--operation-id", "too-large", "--amount", "1000000001", "--counterparty", "seller-a", "--authorize");
  assert.equal(denied.error?.code, "POLICY_AMOUNT_EXCEEDED");
  const roleDenied = run(homes.seller, "wallet", "deposit", "--amount", "1", "--authorize"); assert.equal(roleDenied.error?.code, "ROLE_FORBIDDEN");

  const disclosure = good(homes.buyer, "disclose", "--deal-id", "deal-1", "--auditor", "auditor-1", "--payment-digest", reconciled.transactionDigest, "--transcript-root", accepted.transcriptCommitment, "--authorize");
  const verified = good(homes.auditor, "audit", "verify", "--package", disclosure.package, "--auditor", "auditor-1", "--deal-id", "deal-1");
  assert.equal(verified.paymentVerified, true); assert.equal(verified.evidence, "mock-not-funded");
  const withdrawn = good(homes.buyer, "wallet", "withdraw", "--commitment", deposited.commitment, "--authorize"); assert.equal(withdrawn.finalized, true);
});

function mcpExchange(home: string, requests: unknown[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", mcp], { cwd: backend, env: { ...process.env, SUPERCUTS_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => stdout += chunk); child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))) : reject(new Error(`${code}: ${stderr}`)));
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`); child.stdin.end();
  });
}

test("phase 3 independent MCP processes expose role-scoped tools and backend policy", async () => {
  const buyerReplies = await mcpExchange(homes.buyer, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pay.x402", arguments: { "operation-id": "mcp-over", amount: "1000000001", counterparty: "seller-a", authorize: true } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "pay.x402", arguments: { "operation-id": "mcp-over", amount: "1000000001", counterparty: "seller-a" } } },
  ]);
  assert.ok(buyerReplies[1].result.tools.some((tool: any) => tool.name === "pay.shielded"));
  assert.ok(buyerReplies[1].result.tools.some((tool: any) => tool.name === "settlement.plan"));
  assert.ok(!buyerReplies[1].result.tools.some((tool: any) => tool.name === "settlement.approve-review"));
  assert.equal(buyerReplies[1].result.tools.find((tool: any) => tool.name === "pay.x402").inputSchema.additionalProperties, false);
  assert.equal(buyerReplies[2].result.structuredContent.error.code, "MCP_ARGUMENT_UNKNOWN");
  assert.equal(buyerReplies[3].result.structuredContent.error.code, "MANDATE_DEAL_CEILING_EXCEEDED");
  const sellerReplies = await mcpExchange(homes.seller, [{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }]);
  assert.ok(sellerReplies[0].result.tools.some((tool: any) => tool.name === "offer.counter"));
  assert.ok(!sellerReplies[0].result.tools.some((tool: any) => tool.name === "wallet.deposit"));
  const auditorReplies = await mcpExchange(homes.auditor, [{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }]);
  assert.deepEqual(auditorReplies[0].result.tools.map((tool: any) => tool.name), ["status", "doctor", "audit.verify"]);
});

test("phase 3 approval tokens bind exact intent, role state, and one-time use", () => {
  const buyerHome = join(root, "token-buyer"), sellerHome = join(root, "token-seller");
  initialize(buyerHome, { role: "buyer", mock: true }); initialize(sellerHome, { role: "seller", mock: true });
  const buyer = new Phase3App(buyerHome), seller = new Phase3App(sellerHome);
  try {
    const preview = buyer.preview("wallet.deposit", { amount: "7" }); const approval = buyer.approve(preview.challengeId);
    assert.equal(buyer.execute("wallet.deposit", { amount: "7", "approval-token": approval.token }).ok, true);
    assert.throws(() => buyer.execute("wallet.deposit", { amount: "7", "approval-token": approval.token }), { code: "AUTHORIZATION_REPLAY" });
    const changed = buyer.approve(buyer.preview("wallet.deposit", { amount: "8" }).challengeId);
    assert.throws(() => buyer.execute("wallet.deposit", { amount: "9", "approval-token": changed.token }), { code: "AUTHORIZATION_INTENT_MISMATCH" });
    assert.throws(() => seller.execute("wallet.withdraw", { commitment: "x", "approval-token": changed.token }), { code: "AUTHORIZATION_INVALID" });
  } finally { buyer.close(); seller.close(); }
});
