import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Phase3App } from "../../../src/phase3.js";
import { DealJournal } from "../../../src/deal.js";
import {
  AuditorClient, BuyerClient, SellerClient, SeamUnavailable, SupercutsSdkError, initializeProfile,
  type ApprovalProvider, type AuthorizationIntent, type OperationId, type SessionId,
} from "../src/index.js";

const root = mkdtempSync(join(tmpdir(), "supercuts-sdk-"));
const homes = { buyer: join(root, "buyer"), seller: join(root, "seller"), auditor: join(root, "auditor") };
const approved: AuthorizationIntent[] = [];
const provider: ApprovalProvider = { async approve(intent) { approved.push(intent); return { approved: true }; } };

test("typed SDK initializes roles and completes a procurement workflow through the seam", async () => {
  await initializeProfile({ home: homes.buyer }, { role: "buyer", mock: true, maxAmount: 500n, allowedCounterparties: ["seller-a"] });
  await initializeProfile({ home: homes.seller }, { role: "seller", mock: true });
  await initializeProfile({ home: homes.auditor }, { role: "auditor", mock: true });
  const buyer = await BuyerClient.connect({ home: homes.buyer, approvalProvider: provider });
  const seller = await SellerClient.connect({ home: homes.seller, approvalProvider: provider });
  const auditor = await AuditorClient.connect({ home: homes.auditor });

  const capability = await seller.publishCapability({ seller: "seller-a", service: "dataset", terms: "100 MIST" });
  assert.deepEqual(await buyer.discoverSellers([capability]), [capability]);
  const deposit = await buyer.deposit(500n); assert.equal(deposit.amount, 500n); assert.equal(deposit.evidence, "deterministic-mock-not-funded");
  assert.equal((await buyer.balance()).available, 500n);
  const opened = await buyer.openOffer();
  await buyer.propose(opened.sessionId, 1, { price: "120" });
  await seller.counter(opened.sessionId, 2, { price: "100" });
  const accepted = await buyer.accept(opened.sessionId, 3, { price: "100" });
  const receipt = await buyer.settleShielded({ operationId: "sdk-pay-1" as OperationId, amount: 100n, counterparty: "seller-a", requestId: "sdk-resource" });
  assert.equal(receipt.amount, 100n); assert.equal(receipt.status, "finalized");
  await seller.serveResource("sdk-resource", Buffer.from("payload"));
  const resource = await buyer.fetchResource({ requestId: "sdk-resource", operationId: "sdk-pay-1" as OperationId, response: Buffer.from("payload") });
  assert.equal(Buffer.from(resource.body).toString(), "payload");
  const disclosure = await buyer.requestDisclosure({ dealId: "deal-sdk", auditor: "auditor-sdk", paymentDigest: receipt.transactionDigest, transcriptRoot: accepted.transcriptCommitment });
  const result = await auditor.verify({ package: disclosure.package, auditor: "auditor-sdk", dealId: "deal-sdk" });
  assert.equal(result.paymentVerified, true);
  assert.ok(approved.every((intent) => !JSON.stringify(intent).includes("state.key")));
});

test("approval denial and profile role mismatch are typed failures", async () => {
  const denied = await BuyerClient.connect({ home: homes.buyer, approvalProvider: { async approve() { return { approved: false, reason: "operator rejected" }; } } });
  await assert.rejects(() => denied.deposit(1n), (error: unknown) => error instanceof SupercutsSdkError && error.code === "AUTHORIZATION_DENIED" && error.message === "operator rejected");
  await assert.rejects(() => BuyerClient.connect({ home: homes.seller, approvalProvider: provider }), (error: unknown) => error instanceof SupercutsSdkError && error.code === "SDK_ROLE_MISMATCH");
});

test("operation authorization survives an exact retry but rejects changed payload", async () => {
  const buyer = await BuyerClient.connect({ home: homes.buyer, approvalProvider: provider });
  const first = await buyer.payX402({ operationId: "sdk-retry" as OperationId, amount: 5n, counterparty: "seller-a" });
  const second = await buyer.payX402({ operationId: "sdk-retry" as OperationId, amount: 5n, counterparty: "seller-a" });
  assert.equal(second.transactionDigest, first.transactionDigest);
  await assert.rejects(() => buyer.payX402({ operationId: "sdk-retry" as OperationId, amount: 6n, counterparty: "seller-a" }), (error: unknown) => error instanceof SupercutsSdkError && error.code === "OPERATION_ID_CONFLICT");
});

test("deal status crosses the SDK seam without exposing encrypted task input", async () => {
  const app = new Phase3App(homes.buyer);
  const created = new DealJournal(app.store).create({ operationId: "sdk-composite", capabilityClass: "artifact.generation", input: { privateTask: "not in status" }, budget: { asset: "0x2::sui::SUI", maximum: "10" } });
  app.close();
  const buyer = await BuyerClient.connect({ home: homes.buyer, approvalProvider: provider });
  const received = await buyer.getDeal("sdk-composite");
  assert.equal(received.dealId, created.dealId);
  assert.equal(received.state, "created");
  assert.equal(JSON.stringify(received).includes("not in status"), false);
  await assert.rejects(() => buyer.executeDeal({ operationId: "sdk-live-only", capabilityClass: "artifact.generation", input: {}, budget: { asset: "0x2::sui::SUI", maximum: "10" } }), (error: unknown) => error instanceof SupercutsSdkError && error.code === "DEAL_LIVE_REQUIRED");
});

test("SDK reports missing, malformed, interrupted, timed-out, and mismatched backend seams", async () => {
  const fake = (name: string, source: string) => { const path = join(root, name); writeFileSync(path, source); return path; };
  await assert.rejects(() => initializeProfile({ home: join(root, "missing"), seamPath: join(root, "absent.js") }, { role: "buyer", mock: true }), (error: unknown) => error instanceof SeamUnavailable && /missing/.test(error.message));
  const malformed = fake("malformed.cjs", "process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write('oops'));");
  await assert.rejects(() => initializeProfile({ home: join(root, "malformed"), seamPath: malformed }, { role: "buyer", mock: true }), (error: unknown) => error instanceof SeamUnavailable && /invalid JSON/.test(error.message));
  const interrupted = fake("interrupted.cjs", "process.exit(7);");
  await assert.rejects(() => initializeProfile({ home: join(root, "interrupted"), seamPath: interrupted }, { role: "buyer", mock: true }), (error: unknown) => error instanceof SeamUnavailable && /exit 7/.test(error.message));
  const stalled = fake("stalled.cjs", "process.stdin.resume(); setInterval(()=>{},1000);");
  await assert.rejects(() => initializeProfile({ home: join(root, "stalled"), seamPath: stalled, timeoutMs: 50 }, { role: "buyer", mock: true }), (error: unknown) => error instanceof SeamUnavailable && /exceeded/.test(error.message));
  const mismatch = fake("mismatch.cjs", "let s=''; process.stdin.on('data',x=>s+=x); process.stdin.on('end',()=>{const r=JSON.parse(s); process.stdout.write(JSON.stringify({protocol:1,requestId:r.requestId,ok:true,result:{protocol:1,packageVersion:'9.9.9'}}))});");
  await assert.rejects(() => initializeProfile({ home: join(root, "mismatch"), seamPath: mismatch }, { role: "buyer", mock: true }), (error: unknown) => error instanceof SeamUnavailable && /incompatible/.test(error.message));
});
