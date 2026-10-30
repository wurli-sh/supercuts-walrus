import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  agreementCommitment, applyPoolEvent, canonicalEnvelope, createPoolIndex, decideRailFromRecall,
  decryptSessionMessage, DurableTranscriptTransport, encryptSessionMessage, ExactResourceServer,
  MessageEnvelope, noteCommitment, openDisclosure, PaymentConsumptionLedger, PrivateWallet,
  protocolAgreementCommitment, requirementsHash, RoleStore, sealDisclosure, SealDisclosureTransport, sha256, validateTranscript,
  verifyDisclosure, WorkflowMemory,
} from "../src/index.js";
import type { BlobTransport, DisclosurePackage, ExactRequirements, FinalPayment, MemoryFact, NoteOpening, PoolEvent, TranscriptManifestEntry } from "../src/index.js";

const verifyMessage = async (author: string, _bytes: Uint8Array, signature: string) => signature === `sig:${author}`;

class Blobs implements BlobTransport {
  readonly values = new Map<string, string>();
  readonly ids = new Map<string, string>();
  failAfterWrite = false;
  async put(id: string, ciphertext: string): Promise<string> {
    const blobId = `blob-${sha256(ciphertext).slice(0, 16)}`;
    this.ids.set(id, blobId); this.values.set(blobId, ciphertext);
    if (this.failAfterWrite) { this.failAfterWrite = false; throw new Error("lost upload response"); }
    return blobId;
  }
  async get(blobId: string): Promise<string> { return this.values.get(blobId) ?? Promise.reject(new Error("blob missing")); }
  async resolve(id: string): Promise<string | undefined> { return this.ids.get(id); }
}

function statePath() { const directory = mkdtempSync(join(tmpdir(), "supercuts-e2e-")); return { path: join(directory, "state.sqlite"), key: randomBytes(32) }; }
function message(sessionId: string, author: string, key: Buffer, plaintext: string, sequence = 0, parentHash: string | null = null, revision = 1): MessageEnvelope {
  const id = `${sessionId}-${sequence}`;
  const ciphertext = encryptSessionMessage(key, sessionId, id, Buffer.from(plaintext));
  return { id, sessionId, revision, sequence, parentHash, author, type: sequence ? "accept" : "offer", expiresAt: Date.now() + 60_000, ciphertext, ciphertextHash: sha256(Buffer.from(ciphertext, "base64")), signature: `sig:${author}` };
}
function envelopeHash(value: MessageEnvelope): string { return sha256(Buffer.concat([canonicalEnvelope(value), Buffer.from(value.signature)])); }

test("phase 2 e2e: three encrypted negotiations survive uncertain upload and a fresh process", async () => {
  const blobs = new Blobs(); const location = statePath();
  const writer = new RoleStore(location.path, location.key); const transport = new DurableTranscriptTransport(writer, blobs);
  const sessions: Array<{ key: Buffer; manifest: TranscriptManifestEntry[]; seller: string; price: number }> = [];
  for (const [seller, price] of [["seller-a", 12], ["seller-b", 9], ["seller-c", 15]] as const) {
    const key = randomBytes(32); const sessionId = `buyer-${seller}`;
    const offer = message(sessionId, seller, key, JSON.stringify({ price }));
    if (seller === "seller-b") {
      blobs.failAfterWrite = true;
      await assert.rejects(() => transport.upload(offer), /lost upload response/);
    }
    const first = await transport.upload(offer);
    const accept = message(sessionId, "buyer", key, JSON.stringify({ selected: seller === "seller-b" }), 1, envelopeHash(offer));
    sessions.push({ key, seller, price, manifest: [first, await transport.upload(accept)] });
  }
  writer.close();

  const restarted = new RoleStore(location.path, location.key); const reader = new DurableTranscriptTransport(restarted, blobs);
  for (const session of sessions) {
    const sessionId = `buyer-${session.seller}`;
    const hydrated = await reader.restart(session.manifest, verifyMessage, sessionId, new Set(["buyer", session.seller]));
    assert.equal(JSON.parse(decryptSessionMessage(session.key, sessionId, hydrated.messages[0]!.id, hydrated.messages[0]!.ciphertext).toString()).price, session.price);
  }
  assert.equal(sessions.filter((session) => session.price === Math.min(...sessions.map((candidate) => candidate.price))).length, 1);
  const selected = sessions.find((session) => session.seller === "seller-b")!;
  assert.throws(() => decryptSessionMessage(randomBytes(32), "buyer-seller-b", selected.manifest[0]!.id, blobs.values.get(selected.manifest[0]!.blobId)!), { code: "SESSION_DECRYPT_FAILED" });

  const hydrated = await reader.restart(selected.manifest, verifyMessage, "buyer-seller-b", new Set(["buyer", "seller-b"]));
  await assert.rejects(() => validateTranscript([...hydrated.messages].reverse(), verifyMessage), { code: "TRANSCRIPT_ORDER_INVALID" });
  await assert.rejects(() => validateTranscript([hydrated.messages[0]!, hydrated.messages[0]!], verifyMessage), { code: "TRANSCRIPT_ORDER_INVALID" });
  await assert.rejects(() => reader.restart(selected.manifest.slice(1), verifyMessage, "buyer-seller-b", new Set(["buyer", "seller-b"])), { code: "TRANSCRIPT_ORDER_INVALID" });
  const alteredBlob = selected.manifest[0]!.blobId; blobs.values.set(alteredBlob, Buffer.from("altered").toString("base64"));
  await assert.rejects(() => reader.restart(selected.manifest, verifyMessage, "buyer-seller-b", new Set(["buyer", "seller-b"])), { code: "CIPHERTEXT_TAMPERED" });
  restarted.close();
});

test("phase 2 e2e: wallet reserves, reconciles pinned evidence, and recovers seller plus change notes", async () => {
  const location = statePath(); let state = new RoleStore(location.path, location.key); let wallet = new PrivateWallet(state);
  const paymentOpening: NoteOpening = { deployment: 11n, amount: 9n, ownerAx: 12n, ownerAy: 13n, spendSecret: 14n, salt: 15n };
  const changeOpening: NoteOpening = { deployment: 11n, amount: 3n, ownerAx: 16n, ownerAy: 17n, spendSecret: 18n, salt: 19n };
  const event: Extract<PoolEvent, { kind: "transfer" }> = { kind: "transfer", checkpoint: 102n, transactionIndex: 1n, eventIndex: 0, oldRoot: "root-1", newRoot: "root-2", firstLeafIndex: 1n, paymentCommitment: await noteCommitment(paymentOpening), changeCommitment: await noteCommitment(changeOpening), dealNullifier: "deal-n", inputNullifier: "input-n" };
  const expected = { packageId: "pkg", poolId: "pool", coinType: "SUI", inputNullifier: "input-n", dealNullifier: "deal-n", paymentCommitment: event.paymentCommitment, changeCommitment: event.changeCommitment };
  wallet.prepare("deal-1", "payload-hash", "input-note", expected, Buffer.from("proof"));
  assert.throws(() => { state.beginOperation("deal-2", "other"); state.reserveNote("input-note", "deal-2"); }, { code: "NOTE_RESERVED" });
  wallet.recordBroadcast("deal-1", "tx-good"); state.close();

  state = new RoleStore(location.path, location.key); wallet = new PrivateWallet(state);
  let operation = await wallet.reconcile("deal-1", async () => undefined);
  assert.equal(operation.status, "unresolved");
  operation = await wallet.reconcile("deal-1", async (digest) => ({ digest, finalized: true, successful: true, packageId: "pkg", poolId: "pool", coinType: "SUI", events: [event] }));
  assert.equal(operation.status, "finalized");
  assert.equal(await wallet.recoverOutput("deal-1", "payment", paymentOpening, event), event.paymentCommitment);
  assert.equal(await wallet.recoverOutput("deal-1", "change", changeOpening, event), event.changeCommitment);
  assert.equal(state.hasUnspentNote(event.paymentCommitment), true); assert.equal(state.hasUnspentNote(event.changeCommitment), true);
  assert.equal(state.hasUnspentNote("input-note"), false);
  await assert.rejects(() => wallet.reconcile("deal-1", async (digest) => ({ digest, finalized: true, successful: true, packageId: "wrong", poolId: "pool", coinType: "SUI", events: [event] })), { code: "SETTLEMENT_TARGET_MISMATCH" });

  const index = createPoolIndex("root-0", 100n);
  applyPoolEvent(index, { kind: "deposit", checkpoint: 101n, transactionIndex: 0n, eventIndex: 0, oldRoot: "root-0", newRoot: "root-1", leafIndex: 0n, noteCommitment: "input-note" });
  applyPoolEvent(index, event);
  assert.deepEqual({ root: index.root, nextLeaf: index.nextLeaf }, { root: "root-2", nextLeaf: 3n });
  state.close();
});

test("phase 2 e2e: x402 exact challenge settles once and deduplicates delivery", async () => {
  const state = new RoleStore(statePath().path, randomBytes(32)); const ledger = new PaymentConsumptionLedger(state);
  const requirements: ExactRequirements = { scheme: "exact", network: "sui:testnet", amount: "1000", asset: "0x2::sui::SUI", payTo: "0xpayee", maxTimeoutSeconds: 60, extra: {} };
  const payment: FinalPayment = { digest: "tx-x402", network: requirements.network, asset: requirements.asset, amount: 1000n, payTo: requirements.payTo, finalized: true };
  const payments = new Map([[payment.digest, payment]]);
  const server = new ExactResourceServer(ledger, requirements, async (binding) => binding.payer === "payer" && binding.payerSignature === "payer-ok", async (digest) => payments.get(digest));
  const challenge = server.challenge("resource-1"); let produced = 0;
  const submission = { binding: { requestId: challenge.requestId, nonce: challenge.nonce, requirementsHash: requirementsHash(requirements), transactionDigest: payment.digest, payer: "payer", payerSignature: "payer-ok" } };
  assert.equal((await server.deliver("resource-1", submission, async () => Buffer.from(`result-${++produced}`))).toString(), "result-1");
  assert.equal((await server.deliver("resource-1", submission, async () => Buffer.from(`result-${++produced}`))).toString(), "result-1"); assert.equal(produced, 1);
  await assert.rejects(() => server.deliver("resource-1", { binding: { ...submission.binding, payerSignature: "forged" } }, async () => Buffer.from("leak")), { code: "X402_PAYER_SIGNATURE_INVALID" });
  const missing = server.challenge("missing-payment");
  await assert.rejects(() => server.deliver(missing.requestId, { binding: { ...submission.binding, requestId: missing.requestId, nonce: missing.nonce, transactionDigest: "fabricated" } }, async () => Buffer.from("bad")), { code: "PAYMENT_NOT_FOUND" });
  const second = server.challenge("resource-2");
  await assert.rejects(() => server.deliver("resource-2", { binding: { ...submission.binding, requestId: second.requestId, nonce: second.nonce } }, async () => Buffer.from("bad")), { code: "PAYMENT_CONSUMED" });
  for (const patch of [{ nonce: "wrong" }, { requirementsHash: "wrong" }]) {
    const fresh = server.challenge(`bad-${Object.keys(patch)[0]}`);
    await assert.rejects(() => server.deliver(fresh.requestId, { binding: { ...submission.binding, requestId: fresh.requestId, nonce: fresh.nonce, ...patch } }, async () => Buffer.from("bad")), { code: "X402_REQUEST_BINDING_INVALID" });
  }
  const wrongPayee = server.challenge("wrong-payee");
  payments.set("tx-wrong", { ...payment, digest: "tx-wrong", payTo: "0xattacker" });
  await assert.rejects(() => server.deliver(wrongPayee.requestId, { binding: { ...submission.binding, requestId: wrongPayee.requestId, nonce: wrongPayee.nonce, transactionDigest: "tx-wrong" } }, async () => Buffer.from("bad")), { code: "X402_PAYEE_MISMATCH" });

  const emptyPayment = { ...payment, digest: "tx-empty" }; payments.set(emptyPayment.digest, emptyPayment);
  const empty = server.challenge("empty-resource"); const emptySubmission = { binding: { ...submission.binding, requestId: empty.requestId, nonce: empty.nonce, transactionDigest: emptyPayment.digest } };
  let emptyCalls = 0; assert.equal((await server.deliver(empty.requestId, emptySubmission, async () => { emptyCalls++; return Buffer.alloc(0); })).length, 0);
  assert.equal((await server.deliver(empty.requestId, emptySubmission, async () => { emptyCalls++; return Buffer.from("duplicate"); })).length, 0); assert.equal(emptyCalls, 1);

  const concurrentPayment = { ...payment, digest: "tx-concurrent" }; payments.set(concurrentPayment.digest, concurrentPayment);
  const concurrent = server.challenge("concurrent"); const concurrentSubmission = { binding: { ...submission.binding, requestId: concurrent.requestId, nonce: concurrent.nonce, transactionDigest: concurrentPayment.digest } };
  let release!: () => void; let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; }); const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  const first = server.deliver(concurrent.requestId, concurrentSubmission, async () => { started(); await releasePromise; return Buffer.from("once"); });
  await startedPromise;
  await assert.rejects(() => server.deliver(concurrent.requestId, concurrentSubmission, async () => Buffer.from("twice")), { code: "DELIVERY_IN_PROGRESS" });
  release(); assert.equal((await first).toString(), "once");
  state.close();
});

class FakeSeal implements SealDisclosureTransport {
  async encrypt(auditor: string, plaintext: Uint8Array) { return Buffer.concat([Buffer.from(`${auditor}:`), Buffer.from(plaintext)]); }
  async decrypt(auditor: string, ciphertext: Uint8Array) {
    const prefix = Buffer.from(`${auditor}:`); const value = Buffer.from(ciphertext);
    if (!value.subarray(0, prefix.length).equals(prefix)) throw new Error("wrong auditor");
    return value.subarray(prefix.length);
  }
}

test("phase 2 e2e: protocol audit opening reproduces the Poseidon deal commitment", async () => {
  const names = ["deployment", "dealId", "revision", "transcriptRootLo", "transcriptRootHi", "serviceDigestLo", "serviceDigestHi", "settlementNonceLo", "settlementNonceHi", "paymentAmount", "expiry", "buyerAx", "buyerAy", "sellerAx", "sellerAy", "recipientSpendTag"];
  const agreement = Object.fromEntries(names.map((name, index) => [name, String(index + 1)]));
  assert.equal(await protocolAgreementCommitment(agreement, JSON.stringify({ blinding: "17" })), "18d362e846b1cce7a45723bc549807305a50d1e90d9bcc9d326e7a8d1fbd8aa0");
  await assert.rejects(() => protocolAgreementCommitment({ ...agreement, expiry: "018" }, JSON.stringify({ blinding: "17" })), { code: "AUDIT_PACKAGE_INVALID" });
  await assert.rejects(() => protocolAgreementCommitment(agreement, JSON.stringify({ blinding: "17", spendSecret: "18" })), { code: "AUDIT_PACKAGE_INVALID" });
});

test("phase 2 e2e: scoped disclosure binds auditor, terms, transcript and finalized payment", async () => {
  const pkg: DisclosurePackage = { version: 1, dealId: "deal-1", auditor: "auditor-a", agreement: { seller: "seller-b", amount: "9" }, agreementOpening: "opening", transcriptRoot: "transcript-root", authorizations: [{ author: "buyer", signature: "ok" }, { author: "seller-b", signature: "ok" }], paymentDigest: "tx-private", dealNullifier: "deal-n" };
  const seal = new FakeSeal(); const ciphertext = await sealDisclosure(pkg, seal);
  await assert.rejects(() => openDisclosure(ciphertext, "auditor-b", seal));
  const opened = await openDisclosure(ciphertext, "auditor-a", seal);
  const evidence = { finalized: true, paymentDigest: pkg.paymentDigest, dealNullifier: pkg.dealNullifier, agreementCommitment: agreementCommitment(pkg.agreement, pkg.agreementOpening), transcriptRoot: pkg.transcriptRoot };
  const authors = new Set(["buyer", "seller-b"]); const derive = async (agreement: Record<string, unknown>, opening: string) => agreementCommitment(agreement, opening);
  await verifyDisclosure(opened, "auditor-a", "deal-1", async () => evidence, async (_author, _bytes, signature) => signature === "ok", authors, derive);
  await assert.rejects(() => verifyDisclosure({ ...opened, agreement: { ...opened.agreement, amount: "10" } }, "auditor-a", "deal-1", async () => evidence, async () => true, authors, derive), { code: "AUDIT_TERMS_MISMATCH" });
  await assert.rejects(() => verifyDisclosure(opened, "auditor-a", "deal-2", async () => evidence, async () => true, authors, derive), { code: "AUDIT_DEAL_MISMATCH" });
  await assert.rejects(() => verifyDisclosure({ ...opened, authorizations: [opened.authorizations[0]!] }, "auditor-a", "deal-1", async () => evidence, async () => true, authors, derive), { code: "AUDIT_AUTHORIZATION_INVALID" });
  await assert.rejects(() => verifyDisclosure(opened, "auditor-a", "deal-1", async () => ({ ...evidence, transcriptRoot: "other" }), async () => true, authors, derive), { code: "AUDIT_TRANSCRIPT_MISMATCH" });
});

test("phase 2 e2e: ten completed memories alter a later rail decision and missing recall stops", async () => {
  const state = new RoleStore(statePath().path, randomBytes(32));
  const memory = new WorkflowMemory(state, { remember: async (fact: MemoryFact) => `memory-${fact.operationId}` });
  const kinds = ["budget_preference", "counterparty_reliability", "delivery_observation", "successful_counteroffer", "privacy_choice"] as const;
  for (let index = 0; index < 10; index++) await memory.record({ kind: kinds[index % kinds.length]!, subject: `workflow-${index}`, observation: index === 9 ? "require hidden amount" : "observed workflow outcome", operationId: `fact-${index}`, createdAt: index });
  assert.equal(memory.completed().length, 10);
  assert.equal(await memory.record({ kind: "budget_preference", subject: "workflow-0", observation: "observed workflow outcome", operationId: "fact-0", createdAt: 0 }), "memory-fact-0");
  await assert.rejects(() => memory.record({ kind: "budget_preference", subject: "changed", observation: "conflicting reuse", operationId: "fact-0", createdAt: 0 }), { code: "MEMORY_OPERATION_CONFLICT" });
  assert.equal(decideRailFromRecall([{ hiddenAmountRequired: false }], "x402"), "x402");
  assert.throws(() => decideRailFromRecall([{ hiddenAmountRequired: true }], "x402"), { code: "PUBLIC_RAIL_FORBIDDEN" });
  assert.throws(() => decideRailFromRecall([], "shielded"), { code: "POLICY_RECALL_REQUIRED" });
  assert.throws(() => decideRailFromRecall([{ hiddenAmountRequired: true }, { hiddenAmountRequired: false }], "shielded"), { code: "POLICY_RECALL_REQUIRED" });
  state.close();

  const failedState = new RoleStore(statePath().path, randomBytes(32)); let writes = 0;
  const failedMemory = new WorkflowMemory(failedState, { remember: async () => { writes++; throw new Error("lost response"); } });
  const fact: MemoryFact = { kind: "privacy_choice", subject: "buyer", observation: "hidden amount", operationId: "uncertain", createdAt: 1 };
  await assert.rejects(() => failedMemory.record(fact), /lost response/);
  await assert.rejects(() => failedMemory.record(fact), { code: "MEMORY_JOB_UNRESOLVED" }); assert.equal(writes, 1); failedState.close();
});

test("phase 2 e2e: crash matrix resumes one identity without a second charge", async () => {
  const event: Extract<PoolEvent, { kind: "transfer" }> = { kind: "transfer", checkpoint: 1n, transactionIndex: 0n, eventIndex: 0, oldRoot: "a", newRoot: "b", firstLeafIndex: 0n, paymentCommitment: "p", changeCommitment: "c", dealNullifier: "deal", inputNullifier: "input" };
  const expected = { packageId: "pkg", poolId: "pool", coinType: "SUI", inputNullifier: "input", dealNullifier: "deal", paymentCommitment: "p", changeCommitment: "c" };
  const settled = async (digest: string) => ({ digest, finalized: true, successful: true, packageId: "pkg", poolId: "pool", coinType: "SUI", events: [event] });
  const locations = Array.from({ length: 4 }, () => statePath());

  // Failure before proof persistence: the reservation and operation identity survive.
  let state = new RoleStore(locations[0]!.path, locations[0]!.key);
  state.beginOperation("op", "payload"); state.reserveNote("note", "op"); state.close();
  state = new RoleStore(locations[0]!.path, locations[0]!.key); let wallet = new PrivateWallet(state);
  wallet.prepare("op", "payload", "note", expected, Buffer.from("proof")); wallet.recordBroadcast("op", "tx-0"); await wallet.reconcile("op", settled); assert.equal(state.getOperation("op")?.status, "finalized"); state.close();

  // Failure after proof persistence and after broadcast both reuse persisted artifacts.
  for (const [index, stopAfterBroadcast] of [[1, false], [2, true]] as const) {
    state = new RoleStore(locations[index]!.path, locations[index]!.key); wallet = new PrivateWallet(state);
    wallet.prepare("op", "payload", "note", expected, Buffer.from("proof"));
    if (stopAfterBroadcast) wallet.recordBroadcast("op", `tx-${index}`);
    state.close();
    state = new RoleStore(locations[index]!.path, locations[index]!.key); wallet = new PrivateWallet(state);
    wallet.prepare("op", "payload", "note", expected, Buffer.from("proof")); wallet.recordBroadcast("op", `tx-${index}`);
    await wallet.reconcile("op", settled); assert.equal(state.getOperation("op")?.txDigest, `tx-${index}`);
    assert.throws(() => wallet.recordBroadcast("op", "second-charge"), { code: "OPERATION_DIGEST_CONFLICT" }); state.close();
  }

  // Chain settlement before local confirmation is recovered exclusively from evidence.
  state = new RoleStore(locations[3]!.path, locations[3]!.key); wallet = new PrivateWallet(state);
  wallet.prepare("op", "payload", "note", expected, Buffer.from("proof")); wallet.recordBroadcast("op", "tx-3"); state.close();
  state = new RoleStore(locations[3]!.path, locations[3]!.key); wallet = new PrivateWallet(state);
  assert.equal((await wallet.reconcile("op", settled)).status, "finalized"); state.close();

  // Confirmation before delivery resumes the same challenge/payment and produces once.
  const delivery = statePath(); state = new RoleStore(delivery.path, delivery.key);
  const requirements: ExactRequirements = { scheme: "exact", network: "sui:testnet", amount: "7", asset: "SUI", payTo: "payee", maxTimeoutSeconds: 30, extra: {} };
  const payment: FinalPayment = { digest: "public-tx", network: "sui:testnet", asset: "SUI", amount: 7n, payTo: "payee", finalized: true };
  const readPayment = async (digest: string) => digest === payment.digest ? payment : undefined;
  let ledger = new PaymentConsumptionLedger(state); let server = new ExactResourceServer(ledger, requirements, async () => true, readPayment);
  const challenge = server.challenge("request");
  const submission = { binding: { requestId: "request", nonce: challenge.nonce, requirementsHash: requirementsHash(requirements), transactionDigest: payment.digest, payer: "payer", payerSignature: "sig" } };
  ledger.claim(payment, "request"); state.close();
  state = new RoleStore(delivery.path, delivery.key); ledger = new PaymentConsumptionLedger(state); server = new ExactResourceServer(ledger, requirements, async () => true, readPayment);
  assert.equal(server.challenge("request").nonce, challenge.nonce); let calls = 0;
  assert.equal((await server.deliver("request", submission, async () => Buffer.from(`delivered-${++calls}`))).toString(), "delivered-1");
  assert.equal((await server.deliver("request", submission, async () => Buffer.from(`delivered-${++calls}`))).toString(), "delivered-1"); assert.equal(calls, 1); state.close();
});
