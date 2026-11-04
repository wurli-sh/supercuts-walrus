import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  BoundedClaude, DemoEventLog, RoleStore, X402ResourceService, capabilityManifestHash,
  createCapabilityManifest, paymentBindingBytes, readDemoEvents, recordedReplay,
  requirementsHash, validateCapabilityManifest, deterministicCounteroffer, settlementRailForPrivacy,
} from "../src/index.js";

test("capability v1 validates its canonical hash and rejects mutations", () => {
  const manifest = createCapabilityManifest({ capabilityId: "market-brief", sellerId: "seller-public", capability: "public-market-research", description: "Cited public market brief", inputSchema: { type: "object", properties: { topic: { type: "string" } } }, outputSchema: { type: "object", properties: { report: { type: "string" } } }, supportedRails: ["x402"], priceBand: { minimum: "10", maximum: "20" }, asset: "0x2::sui::SUI", endpoint: "https://seller.example/research", expiresAt: Date.now() + 60_000 });
  validateCapabilityManifest(manifest); const { manifestHash: _hash, ...unsigned } = manifest; assert.equal(manifest.manifestHash, capabilityManifestHash(unsigned));
  assert.throws(() => validateCapabilityManifest({ ...manifest, description: "mutated" }), { code: "CAPABILITY_HASH_MISMATCH" });
});

test("amounts and privacy rail are selected deterministically", () => {
  assert.equal(deterministicCounteroffer({ buyerOffer: 70n, sellerMinimum: 90n, buyerMaximum: 100n }), 90n);
  assert.equal(settlementRailForPrivacy("public", ["x402", "shielded"]), "x402");
  assert.equal(settlementRailForPrivacy("confidential", ["x402", "shielded"]), "shielded");
  assert.throws(() => settlementRailForPrivacy("confidential", ["x402"]), { code: "RAIL_UNAVAILABLE" });
});

test("demo stream redacts forbidden fields and replay is visibly recorded", () => {
  const path = join(mkdtempSync(join(tmpdir(), "supercuts-events-")), "events.jsonl"), log = new DemoEventLog(path, "run-1");
  log.append({ actor: "buyer", stage: "settlement", status: "complete", publicDetails: { amount: "5", privateKey: "never", nested: { approvalToken: "never" } }, evidenceHashes: [], explorerLinks: [] });
  const events = readDemoEvents(path); assert.equal(events[0]!.publicDetails.privateKey, "[REDACTED]");
  const replay = recordedReplay(events); assert.equal(replay[0]!.mode, "recorded-funded-run");
});

test("bounded Claude accepts only the forced schema tool output", async () => {
  const calls: unknown[] = [], client = new BoundedClaude({ apiKey: "test", maxTurns: 1, retries: 0, fetch: async (_url, init) => { calls.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ content: [{ type: "text", text: "Selected for relevance" }, { type: "tool_use", name: "choose", input: { action: "select", capabilityId: "one", rationale: "fits" } }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } }); } });
  const result = await client.decide<{ action: string; capabilityId: string; rationale: string }>({ system: "Rank only the supplied candidates.", task: "research", candidates: [{ capabilityId: "one" }], schema: { name: "choose", description: "Select one approved candidate.", properties: { action: { type: "string", enum: ["select"] }, capabilityId: { type: "string" }, rationale: { type: "string", maxLength: 200 } }, required: ["action", "capabilityId", "rationale"] } });
  assert.equal(result.action.capabilityId, "one"); assert.equal(result.usage.outputTokens, 5); assert.equal(calls.length, 1);
  assert.equal((calls[0] as { model: string }).model, "claude-haiku-5-5");
  assert.equal("temperature" in (calls[0] as object), false);
});

test("seller-owned x402 service challenges, settles once, and rejects cross-request reuse", async () => {
  const directory = mkdtempSync(join(tmpdir(), "supercuts-x402-service-")), store = new RoleStore(join(directory, "state.sqlite"), randomBytes(32)), payer = Ed25519Keypair.generate(), digest = "tx-digest";
  const facilitatorFetch: typeof fetch = async (input) => new Response(JSON.stringify(String(input).endsWith("/verify") ? { isValid: true } : { success: true, transaction: digest, network: "sui:testnet" }), { status: 200, headers: { "content-type": "application/json" } });
  const facilitatorKey = "f".repeat(32);
  const service = new X402ResourceService(store, { origin: "http://127.0.0.1:0", facilitatorUrl: "http://127.0.0.1:9999", facilitatorKey, network: "sui:testnet", asset: "0x2::sui::SUI", payTo: `0x${"11".repeat(32)}`, amount: "7" }, facilitatorFetch);
  const server = service.createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address === "object");
  // The configured origin is part of the signed challenge; use a second service with the actual ephemeral port.
  await new Promise<void>((resolve) => server.close(() => resolve())); store.close();
  const store2 = new RoleStore(join(directory, "state2.sqlite"), randomBytes(32)), origin = `http://127.0.0.1:${address.port}`, service2 = new X402ResourceService(store2, { origin, facilitatorUrl: "http://127.0.0.1:9999", facilitatorKey, network: "sui:testnet", asset: "0x2::sui::SUI", payTo: `0x${"11".repeat(32)}`, amount: "7" }, facilitatorFetch), server2 = service2.createServer();
  service2.register("request-a", "operation-a", Buffer.from('{"report":"ready"}')); service2.register("request-b", "operation-b", Buffer.from('{"report":"other"}')); service2.register("request-expired", "operation-expired", Buffer.from('{"report":"expired"}'));
  await new Promise<void>((resolve) => server2.listen(address.port, "127.0.0.1", resolve));
  try {
    const challengeResponse = await fetch(`${origin}/capability/request-a`); assert.equal(challengeResponse.status, 402);
    const challenge = JSON.parse(Buffer.from(challengeResponse.headers.get("payment-required")!, "base64").toString()) as any, requirements = challenge.accepts[0], extra = requirements.extra;
    const unsignedRequirements = { ...requirements, extra: { requestId: extra.requestId, operationId: extra.operationId, nonce: extra.nonce } };
    const unsignedBinding = { requestId: "request-a", nonce: extra.nonce, requirementsHash: requirementsHash(unsignedRequirements), transactionDigest: digest, payer: payer.toSuiAddress() };
    const payerSignature = (await payer.signPersonalMessage(paymentBindingBytes(unsignedBinding))).signature, headers = { "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, resource: challenge.resource, accepted: requirements, payload: { signature: "transaction-signature", transaction: "bytes" } })).toString("base64"), "x-supercuts-binding": Buffer.from(JSON.stringify({ ...unsignedBinding, payerSignature })).toString("base64") };
    const paid = await fetch(`${origin}/capability/request-a`, { headers }); assert.equal(paid.status, 200); assert.equal(await paid.text(), '{"report":"ready"}');
    const replayed = await fetch(`${origin}/capability/request-a`, { headers }); assert.equal(replayed.status, 200);
    const secondChallengeResponse = await fetch(`${origin}/capability/request-b`), secondChallenge = JSON.parse(Buffer.from(secondChallengeResponse.headers.get("payment-required")!, "base64").toString()) as any, secondRequirements = secondChallenge.accepts[0], secondExtra = secondRequirements.extra;
    const secondUnsignedRequirements = { ...secondRequirements, extra: { requestId: secondExtra.requestId, operationId: secondExtra.operationId, nonce: secondExtra.nonce } }, secondBinding = { requestId: "request-b", nonce: secondExtra.nonce, requirementsHash: requirementsHash(secondUnsignedRequirements), transactionDigest: digest, payer: payer.toSuiAddress() }, secondSignature = (await payer.signPersonalMessage(paymentBindingBytes(secondBinding))).signature;
    const consumed = await fetch(`${origin}/capability/request-b`, { headers: { "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, resource: secondChallenge.resource, accepted: secondRequirements, payload: { signature: "transaction-signature", transaction: "bytes" } })).toString("base64"), "x-supercuts-binding": Buffer.from(JSON.stringify({ ...secondBinding, payerSignature: secondSignature })).toString("base64") } }); assert.equal(consumed.status, 409);
    const expiredChallenge = await fetch(`${origin}/capability/request-expired`); assert.equal(expiredChallenge.status, 402);
    store2.db.prepare("UPDATE x402_challenges SET created_at=? WHERE request_id=?").run(Date.now() - 301_000, "request-expired");
    const expiredPayment = await fetch(`${origin}/capability/request-expired`, { headers: { "payment-signature": "e30=" } });
    assert.equal(expiredPayment.status, 400); assert.equal((await expiredPayment.json() as { error: string }).error, "X402_CHALLENGE_EXPIRED");
  } finally { await new Promise<void>((resolve) => server2.close(() => resolve())); store2.close(); }
});
