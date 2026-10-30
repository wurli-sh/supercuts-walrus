import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import { fail } from "./errors.js";
import { LivePoolIndex } from "./live-index.js";
import { ProtocolEngine, type AcceptedAgreement, type NoteOpeningData } from "./protocol-engine.js";
import { Groth16Prover, type ProverConfig } from "./prover.js";
import { buildDeposit, buildPrivateTransfer, buildWithdraw, writeClient } from "./sui.js";
import { TatumLedger } from "./tatum.js";
import type { RoleStore } from "./store.js";

export interface LiveRuntimeProfile {
  role: "buyer" | "seller" | "auditor"; packageId: string; poolId: string; coinType: string; verifierVersion: number;
  live: {
    coinTypeHash: string; deploymentDomain: string; initialRoot: string; deploymentCheckpoint: string;
    writeGrpcEndpoint: string; tatumGrpcEndpoint: string; artifactRoot: string; snarkjsPath: string; converterPath: string;
    rapidsnarkPath?: string; artifacts: ProverConfig["expected"];
  };
  policy: { maxAmount: string; allowedAssets: string[]; allowedCounterparties: string[]; requiredPrivacy: "any" | "shielded"; expiresAt: number };
}

const hex = (value: bigint): string => value.toString(16).padStart(64, "0");
const bytes32 = (value: bigint): Buffer => Buffer.from(hex(value), "hex");
const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const serializeOpening = (opening: NoteOpeningData): Buffer => Buffer.from(JSON.stringify(opening, (_key, value) => typeof value === "bigint" ? value.toString() : value));
const parseOpening = (value: Buffer): NoteOpeningData => JSON.parse(value.toString(), (_key, item) => typeof item === "string" && /^[0-9]+$/.test(item) ? BigInt(item) : item) as NoteOpeningData;

export class LiveRuntime {
  readonly client; readonly engine: ProtocolEngine; readonly index: LivePoolIndex; readonly prover: Groth16Prover;
  private constructor(readonly profile: LiveRuntimeProfile, readonly store: RoleStore, readonly tatum: TatumLedger, readonly signer: Ed25519Keypair, engine: ProtocolEngine) {
    this.engine = engine; this.client = writeClient(profile.live.writeGrpcEndpoint);
    this.index = new LivePoolIndex(store, this.client, engine, profile.packageId, profile.poolId, BigInt(profile.live.deploymentCheckpoint));
    this.prover = new Groth16Prover({ artifactRoot: profile.live.artifactRoot, snarkjsPath: profile.live.snarkjsPath, converterPath: profile.live.converterPath, ...(profile.live.rapidsnarkPath ? { rapidsnarkPath: profile.live.rapidsnarkPath } : {}), expected: profile.live.artifacts });
    store.db.exec(`CREATE TABLE IF NOT EXISTS live_signed_transactions (
      operation_id TEXT PRIMARY KEY, intent_hash TEXT NOT NULL, transaction_bytes BLOB NOT NULL,
      signature TEXT NOT NULL, digest TEXT NOT NULL UNIQUE, status TEXT NOT NULL, updated_at INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS live_x402_deliveries (
      operation_id TEXT PRIMARY KEY, resource_url TEXT NOT NULL, receipt TEXT NOT NULL, response BLOB NOT NULL, updated_at INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS live_agreements (
      session_id TEXT PRIMARY KEY, agreement TEXT NOT NULL, deal_commitment TEXT NOT NULL, accepted_at INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS live_seller_agreements (
      session_id TEXT PRIMARY KEY, agreement TEXT NOT NULL, payment_salt TEXT NOT NULL, amount TEXT NOT NULL, created_at INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS live_operation_context (
      operation_id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, created_at INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS live_transfer_inputs (
      operation_id TEXT PRIMARY KEY, input_commitment TEXT NOT NULL, input_nullifier TEXT NOT NULL
    )`);
  }
  static async create(profile: LiveRuntimeProfile, store: RoleStore): Promise<LiveRuntime> {
    const encoded = store.getSecret("live:sui-private-key")?.toString() ?? fail("LIVE_CREDENTIAL_MISSING", "encrypted Sui signer is missing");
    const decoded = decodeSuiPrivateKey(encoded); if (decoded.scheme !== "ED25519") fail("SIGNER_UNSUPPORTED", "the initial live runtime requires an ED25519 Sui key");
    const tatumKey = store.getSecret("live:tatum-api-key")?.toString() ?? fail("LIVE_CREDENTIAL_MISSING", "encrypted Tatum key is missing");
    const engine = await ProtocolEngine.create({ deploymentDomain: profile.live.deploymentDomain, poolId: profile.poolId, coinTypeHash: profile.live.coinTypeHash, verifierVersion: profile.verifierVersion, initialRoot: profile.live.initialRoot });
    return new LiveRuntime(profile, store, new TatumLedger(profile.live.tatumGrpcEndpoint, tatumKey), Ed25519Keypair.fromSecretKey(decoded.secretKey), engine);
  }
  async doctor(): Promise<Record<string, unknown>> {
    const artifacts = this.prover.doctor();
    const [service, suiObject] = await Promise.all([this.tatum.getServiceInfo(), this.client.getObject({ objectId: this.profile.poolId, include: { json: true } })]);
    const babySeed = this.store.getSecret("identity:babyjub-seed") ?? fail("IDENTITY_MISSING", "BabyJub identity is missing");
    const identity = this.engine.identity(babySeed);
    return { healthy: true, runtime: "testnet-live", signer: this.signer.toSuiAddress(), babyJubPublicKey: identity.publicKey.map(String), x25519PublicKey: this.store.getSecret("identity:x25519-public")?.toString("base64"), rapidSnark: artifacts.rapidSnark, artifacts: artifacts.artifacts, poolObjectVerified: Boolean(suiObject.object), tatumServiceVerified: Boolean(service) };
  }
  async balance(): Promise<Record<string, unknown>> {
    const state = await this.index.sync(); let available = 0n, notes = 0;
    for (const row of this.store.db.prepare("SELECT commitment FROM notes WHERE spent=0 ORDER BY commitment").all() as Array<{ commitment: string }>) {
      const secret = this.store.getSecret(`note:${row.commitment}`); if (!secret) continue;
      const opening = parseOpening(secret); if (state.leaves[Number(opening.leafIndex)] === opening.commitment) { available += opening.amount; notes++; }
    }
    return { available: available.toString(), notes, root: hex(state.root), nextLeaf: state.nextLeaf.toString(), checkpoint: state.lastCheckpoint.toString(), evidence: "event-derived-and-pool-object-verified" };
  }
  private async signed(operationId: string, intentHash: string, tx: Transaction): Promise<{ digest: string; transaction: Uint8Array; signature: string }> {
    const existing = this.store.db.prepare("SELECT intent_hash,transaction_bytes,signature,digest FROM live_signed_transactions WHERE operation_id=?").get(operationId) as { intent_hash: string; transaction_bytes: Buffer; signature: string; digest: string } | undefined;
    if (existing) { if (existing.intent_hash !== intentHash) fail("OPERATION_ID_CONFLICT", "operation ID identifies different transaction intent"); return { digest: existing.digest, transaction: existing.transaction_bytes, signature: existing.signature }; }
    tx.setSender(this.signer.toSuiAddress());
    const simulation = await this.client.simulateTransaction({ transaction: tx, include: { effects: true } });
    const simulated = simulation.Transaction ?? simulation.FailedTransaction; if (!simulated?.status.success) fail("TRANSACTION_SIMULATION_FAILED", "Sui rejected the transaction during simulation");
    const transaction = await tx.build({ client: this.client }), digest = await tx.getDigest({ client: this.client }), signature = (await this.signer.signTransaction(transaction)).signature;
    this.store.db.prepare("INSERT INTO live_signed_transactions(operation_id,intent_hash,transaction_bytes,signature,digest,status,updated_at) VALUES(?,?,?,?,?,'signed',?)").run(operationId, intentHash, Buffer.from(transaction), signature, digest, Date.now());
    return { transaction, signature, digest };
  }
  private operationContext(operationId: string, kind: string, subject: string): void {
    const existing = this.store.db.prepare("SELECT kind,subject FROM live_operation_context WHERE operation_id=?").get(operationId) as { kind: string; subject: string } | undefined;
    if (existing) { if (existing.kind !== kind || existing.subject !== subject) fail("OPERATION_ID_CONFLICT", "operation ID identifies another live operation"); return; }
    this.store.db.prepare("INSERT INTO live_operation_context(operation_id,kind,subject,created_at) VALUES(?,?,?,?)").run(operationId, kind, subject, Date.now());
  }
  private existingSigned(operationId: string): { digest: string; transaction: Uint8Array; signature: string } | undefined {
    const row = this.store.db.prepare("SELECT transaction_bytes,signature,digest FROM live_signed_transactions WHERE operation_id=?").get(operationId) as { transaction_bytes: Buffer; signature: string; digest: string } | undefined;
    return row ? { digest: row.digest, transaction: row.transaction_bytes, signature: row.signature } : undefined;
  }
  private async submit(operationId: string, signed: { digest: string; transaction: Uint8Array; signature: string }): Promise<Record<string, unknown>> {
    let result;
    try { result = await this.client.executeTransaction({ transaction: signed.transaction, signatures: [signed.signature], include: { effects: true, events: true } }); }
    catch { try { await this.tatum.getTransaction(signed.digest); } catch (cause) { fail("BROADCAST_UNRESOLVED", "broadcast outcome is ambiguous; exact signed bytes remain journaled for retry", cause); } }
    const finalized = await this.client.waitForTransaction({ digest: signed.digest, timeout: 60_000, include: { effects: true, events: true } });
    const tx = finalized.Transaction ?? finalized.FailedTransaction; if (!tx?.status.success || !tx.checkpoint) fail("TRANSACTION_FINALITY_FAILED", "transaction was not finalized successfully");
    const tatum = await this.tatum.getTransaction(signed.digest);
    this.store.db.prepare("UPDATE live_signed_transactions SET status='finalized',updated_at=? WHERE operation_id=?").run(Date.now(), operationId);
    return { transactionDigest: signed.digest, checkpoint: tx.checkpoint, finalized: true, evidence: { sui: "effects-and-checkpoint", tatum: Boolean(tatum), broadcastResult: Boolean(result) } };
  }
  async deposit(amount: bigint, operationId: string): Promise<Record<string, unknown>> {
    if (this.profile.role !== "buyer") fail("ROLE_FORBIDDEN", "only a buyer role can deposit");
    this.operationContext(operationId, "deposit", amount.toString()); const prepared = this.store.db.prepare("SELECT commitment FROM notes WHERE operation_id=? AND role='input'").get(operationId) as { commitment: string } | undefined, prior = this.existingSigned(operationId);
    if (prior) { const evidence = await this.submit(operationId, prior); return { commitment: prepared?.commitment, amount: amount.toString(), resumed: true, ...evidence }; }
    const state = await this.index.sync(), identity = this.engine.identity(this.store.getSecret("identity:babyjub-seed") ?? fail("IDENTITY_MISSING", "BabyJub identity is missing"));
    const priorOpening = prepared ? parseOpening(this.store.getSecret(`note:${prepared.commitment}`) ?? fail("NOTE_RECOVERY_MISMATCH", "prepared deposit opening is missing")) : undefined;
    const witness = this.engine.buildDeposit(state.leaves, identity, amount, priorOpening?.spendSecret, priorOpening?.salt), commitment = hex(witness.opening.commitment), intentHash = hash(`deposit:${amount}:${state.root}:${commitment}`);
    this.store.putSecretOnce(`note:${commitment}`, serializeOpening(witness.opening)); this.store.putNote(commitment, "input", operationId, witness.opening.leafIndex);
    const proof = await this.prover.prove("deposit", witness.input);
    const tx = buildDeposit({ packageId: this.profile.packageId, poolId: this.profile.poolId, coinType: this.profile.coinType, amount, noteCommitment: bytes32(witness.opening.commitment), newRoot: bytes32(witness.newRoot), newIndex: witness.newIndex, proof: proof.proof });
    const evidence = await this.submit(operationId, await this.signed(operationId, intentHash, tx)); await this.index.sync();
    return { commitment, amount: amount.toString(), prover: proof.engine, proveMs: proof.proveMs, ...evidence };
  }
  async recover(): Promise<Record<string, unknown>> {
    const state = await this.index.sync(); let recovered = 0;
    if (this.profile.role === "seller") for (const row of this.store.db.prepare("SELECT session_id,agreement,payment_salt,amount FROM live_seller_agreements").all() as Array<{ session_id: string; agreement: string; payment_salt: string; amount: string }>) {
      const secret = this.store.getSecret(`seller-spend:${row.session_id}`); if (!secret) continue; const spendSecret = BigInt(secret.toString()), raw = JSON.parse(row.agreement) as Record<string, any>, owner = raw.sellerPublicKey.map((value: string) => BigInt(value)) as [bigint, bigint], salt = BigInt(row.payment_salt), amount = BigInt(row.amount), commitment = this.engine.noteCommitment(amount, owner, spendSecret, salt), leafIndex = state.leaves.findIndex((leaf) => leaf === commitment); if (leafIndex < 0) continue;
      const opening: NoteOpeningData = { deployment: this.engine.deploymentField, amount, ownerAx: owner[0], ownerAy: owner[1], spendSecret, salt, commitment, leafIndex: BigInt(leafIndex) }, id = hex(commitment); this.store.putSecretOnce(`note:${id}`, serializeOpening(opening)); this.store.putNote(id, "payment", row.session_id, BigInt(leafIndex)); recovered++;
    }
    return { recovered, indexedLeaves: state.leaves.length, root: hex(state.root), nextLeaf: state.nextLeaf.toString(), checkpoint: state.lastCheckpoint.toString(), source: "pinned-chain-events" };
  }
  async withdraw(commitment: string, recipient: string, operationId: string): Promise<Record<string, unknown>> {
    this.operationContext(operationId, "withdraw", `${commitment}:${recipient}`); const secret = this.store.getSecret(`note:${commitment}`) ?? fail("NOTE_NOT_FOUND", "encrypted note opening was not found"); const note = parseOpening(secret), prior = this.existingSigned(operationId); if (prior) { const evidence = await this.submit(operationId, prior); this.store.db.prepare("UPDATE notes SET spent=1 WHERE commitment=?").run(commitment); return { commitment, amount: note.amount.toString(), recipient, resumed: true, ...evidence }; } const state = await this.index.sync();
    const witness = this.engine.buildWithdraw(state.leaves, note, recipient), nullifier = hex(witness.noteNullifier), proof = await this.prover.prove("withdraw", witness.input), intentHash = hash(`withdraw:${commitment}:${recipient}:${state.root}`);
    const tx = buildWithdraw({ packageId: this.profile.packageId, poolId: this.profile.poolId, coinType: this.profile.coinType, root: bytes32(state.root), noteNullifier: bytes32(witness.noteNullifier), recipient, amount: note.amount, proof: proof.proof });
    const evidence = await this.submit(operationId, await this.signed(operationId, intentHash, tx)); this.store.markNoteSpent(nullifier); return { commitment, amount: note.amount.toString(), recipient, nullifier, prover: proof.engine, ...evidence };
  }
  acceptAgreement(sessionId: string, encoded: string): Record<string, unknown> {
    if (this.profile.role !== "buyer") fail("ROLE_FORBIDDEN", "only the buyer can accept a settlement agreement");
    let raw: Record<string, unknown>; try { raw = JSON.parse(Buffer.from(encoded, "base64url").toString()) as Record<string, unknown>; } catch (error) { return fail("AGREEMENT_INVALID", "agreement must be base64url JSON", error); }
    const number = (name: string): bigint => { const value = raw[name]; if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return fail("AGREEMENT_INVALID", `${name} must be a decimal integer`); return BigInt(value); };
    const point = (name: string): [bigint, bigint] => { const value = raw[name]; if (!Array.isArray(value) || value.length !== 2 || value.some((item) => typeof item !== "string" || !/^[0-9]+$/.test(item))) return fail("AGREEMENT_INVALID", `${name} must be a decimal BabyJub point`); return [BigInt(value[0] as string), BigInt(value[1] as string)]; };
    const buyer = this.engine.identity(this.store.getSecret("identity:babyjub-seed") ?? fail("IDENTITY_MISSING", "BabyJub identity is missing")), suppliedBuyer = point("buyerPublicKey");
    if (suppliedBuyer[0] !== buyer.publicKey[0] || suppliedBuyer[1] !== buyer.publicKey[1]) fail("AGREEMENT_BUYER_MISMATCH", "agreement is bound to another buyer identity");
    const signatureRaw = raw.sellerSignature as Record<string, unknown> | undefined ?? fail("AGREEMENT_INVALID", "sellerSignature is missing");
    const signature = { R8x: BigInt(String(signatureRaw.R8x)), R8y: BigInt(String(signatureRaw.R8y)), S: BigInt(String(signatureRaw.S)) };
    const unsigned = { dealId: number("dealId"), revision: number("revision"), transcriptRootLo: number("transcriptRootLo"), transcriptRootHi: number("transcriptRootHi"), serviceDigestLo: number("serviceDigestLo"), serviceDigestHi: number("serviceDigestHi"), settlementNonceLo: number("settlementNonceLo"), settlementNonceHi: number("settlementNonceHi"), paymentAmount: number("paymentAmount"), blinding: number("blinding"), expiry: number("expiry"), buyer, sellerPublicKey: point("sellerPublicKey"), recipientSpendTag: number("recipientSpendTag") };
    if (unsigned.paymentAmount <= 0n || unsigned.expiry <= BigInt(Date.now())) fail("AGREEMENT_INVALID", "agreement amount or expiry is invalid");
    const counterparty = String(raw.counterparty ?? ""); if (!counterparty || !this.profile.policy.allowedCounterparties.includes(counterparty)) fail("POLICY_COUNTERPARTY_FORBIDDEN", "agreement counterparty is not allowed");
    if (unsigned.paymentAmount > BigInt(this.profile.policy.maxAmount)) fail("POLICY_AMOUNT_EXCEEDED", "agreement exceeds the configured cap");
    if (!this.profile.policy.allowedAssets.includes(this.profile.coinType)) fail("POLICY_ASSET_FORBIDDEN", "pool asset is not allowed");
    const values = this.engine.agreementValues(unsigned); if (!this.engine.verify(unsigned.sellerPublicKey, 2005n, values.dealCommitment, signature)) fail("AGREEMENT_SIGNATURE_INVALID", "seller did not sign the pinned agreement commitment");
    const serialized = JSON.stringify({ ...raw, sessionId }); const existing = this.store.db.prepare("SELECT agreement FROM live_agreements WHERE session_id=?").get(sessionId) as { agreement: string } | undefined;
    if (existing && existing.agreement !== serialized) fail("AGREEMENT_SESSION_CONFLICT", "session already contains another accepted agreement");
    this.store.db.prepare("INSERT OR IGNORE INTO live_agreements(session_id,agreement,deal_commitment,accepted_at) VALUES(?,?,?,?)").run(sessionId, serialized, hex(values.dealCommitment), Date.now());
    return { sessionId, revision: unsigned.revision.toString(), state: "accepted", dealCommitment: hex(values.dealCommitment), expiry: unsigned.expiry.toString(), paymentAmount: unsigned.paymentAmount.toString() };
  }
  prepareSellerAgreement(sessionId: string, encoded: string): Record<string, unknown> {
    if (this.profile.role !== "seller") fail("ROLE_FORBIDDEN", "only the seller can sign a settlement agreement");
    let raw: Record<string, any>; try { raw = JSON.parse(Buffer.from(encoded, "base64url").toString()) as Record<string, any>; } catch (error) { return fail("AGREEMENT_INVALID", "agreement draft must be base64url JSON", error); }
    const persisted = this.store.db.prepare("SELECT agreement FROM live_seller_agreements WHERE session_id=?").get(sessionId) as { agreement: string } | undefined;
    if (persisted) { const value = JSON.parse(persisted.agreement) as Record<string, any>; for (const [key, item] of Object.entries(raw)) if (JSON.stringify(value[key]) !== JSON.stringify(item)) fail("AGREEMENT_SESSION_CONFLICT", "seller session already signed another agreement draft"); return { sessionId, revision: String(value.revision), state: "counter", dealCommitment: hex(this.engine.agreementValues({ dealId: BigInt(value.dealId), revision: BigInt(value.revision), transcriptRootLo: BigInt(value.transcriptRootLo), transcriptRootHi: BigInt(value.transcriptRootHi), serviceDigestLo: BigInt(value.serviceDigestLo), serviceDigestHi: BigInt(value.serviceDigestHi), settlementNonceLo: BigInt(value.settlementNonceLo), settlementNonceHi: BigInt(value.settlementNonceHi), paymentAmount: BigInt(value.paymentAmount), blinding: BigInt(value.blinding), expiry: BigInt(value.expiry), buyer: { seed: new Uint8Array(32), publicKey: value.buyerPublicKey.map((item: string) => BigInt(item)) as [bigint, bigint] }, sellerPublicKey: value.sellerPublicKey.map((item: string) => BigInt(item)) as [bigint, bigint], recipientSpendTag: BigInt(value.recipientSpendTag) }).dealCommitment), agreement: Buffer.from(persisted.agreement).toString("base64url"), replayed: true }; }
    const decimal = (name: string): bigint => { if (typeof raw[name] !== "string" || !/^[0-9]+$/.test(raw[name])) return fail("AGREEMENT_INVALID", `${name} must be a decimal integer`); return BigInt(raw[name]); }, buyerPoint = raw.buyerPublicKey;
    if (!Array.isArray(buyerPoint) || buyerPoint.length !== 2) fail("AGREEMENT_INVALID", "buyerPublicKey is missing");
    const seller = this.engine.identity(this.store.getSecret("identity:babyjub-seed") ?? fail("IDENTITY_MISSING", "BabyJub identity is missing")), spendSecret = this.engine.randomScalar(), unsigned = { dealId: decimal("dealId"), revision: decimal("revision"), transcriptRootLo: decimal("transcriptRootLo"), transcriptRootHi: decimal("transcriptRootHi"), serviceDigestLo: decimal("serviceDigestLo"), serviceDigestHi: decimal("serviceDigestHi"), settlementNonceLo: decimal("settlementNonceLo"), settlementNonceHi: decimal("settlementNonceHi"), paymentAmount: decimal("paymentAmount"), blinding: decimal("blinding"), expiry: decimal("expiry"), buyer: { seed: new Uint8Array(32), publicKey: buyerPoint.map((value: string) => BigInt(value)) as [bigint, bigint] }, sellerPublicKey: seller.publicKey, recipientSpendTag: this.engine.spendTag(spendSecret) };
    if (unsigned.expiry <= BigInt(Date.now()) || unsigned.paymentAmount <= 0n) fail("AGREEMENT_INVALID", "draft amount or expiry is invalid");
    const values = this.engine.agreementValues(unsigned), finalized = { ...raw, sellerPublicKey: seller.publicKey.map(String), recipientSpendTag: unsigned.recipientSpendTag.toString(), sellerSignature: Object.fromEntries(Object.entries(this.engine.sign(seller, 2005n, values.dealCommitment)).map(([key, value]) => [key, value.toString()])) };
    const agreement = JSON.stringify(finalized);
    this.store.putSecretOnce(`seller-spend:${sessionId}`, Buffer.from(spendSecret.toString())); this.store.db.prepare("INSERT OR IGNORE INTO live_seller_agreements(session_id,agreement,payment_salt,amount,created_at) VALUES(?,?,?,?,?)").run(sessionId, agreement, values.paymentSalt.toString(), unsigned.paymentAmount.toString(), Date.now());
    return { sessionId, revision: unsigned.revision.toString(), state: "counter", dealCommitment: hex(values.dealCommitment), agreement: Buffer.from(agreement).toString("base64url") };
  }
  async settleShielded(sessionId: string, operationId: string): Promise<Record<string, unknown>> {
    if (this.profile.role !== "buyer") fail("ROLE_FORBIDDEN", "only the buyer can settle a shielded agreement");
    this.operationContext(operationId, "shielded", sessionId);
    const row = this.store.db.prepare("SELECT agreement FROM live_agreements WHERE session_id=?").get(sessionId) as { agreement: string } | undefined ?? fail("AGREEMENT_NOT_ACCEPTED", "session has no accepted cryptographic agreement");
    const raw = JSON.parse(row.agreement) as Record<string, any>, bigint = (name: string) => BigInt(String(raw[name]));
    const prior = this.existingSigned(operationId); if (prior) { const evidence = await this.submit(operationId, prior), input = this.store.db.prepare("SELECT input_commitment,input_nullifier FROM live_transfer_inputs WHERE operation_id=?").get(operationId) as { input_commitment: string; input_nullifier: string } | undefined; if (input) this.store.db.prepare("UPDATE notes SET spent=1,nullifier=? WHERE commitment=?").run(input.input_nullifier, input.input_commitment); return { operationId, status: "finalized", rail: "shielded", sessionId, requestId: sessionId, amount: String(raw.paymentAmount), counterparty: String(raw.counterparty), asset: this.profile.coinType, policyDecision: "allowed", tatumVerified: true, visibility: "amount-and-parties-hidden-in-pool", evidence: "sui-and-tatum-finalized", resumed: true, ...evidence }; }
    const buyer = this.engine.identity(this.store.getSecret("identity:babyjub-seed") ?? fail("IDENTITY_MISSING", "BabyJub identity is missing"));
    const agreement: AcceptedAgreement = { dealId: bigint("dealId"), revision: bigint("revision"), transcriptRootLo: bigint("transcriptRootLo"), transcriptRootHi: bigint("transcriptRootHi"), serviceDigestLo: bigint("serviceDigestLo"), serviceDigestHi: bigint("serviceDigestHi"), settlementNonceLo: bigint("settlementNonceLo"), settlementNonceHi: bigint("settlementNonceHi"), paymentAmount: bigint("paymentAmount"), blinding: bigint("blinding"), expiry: bigint("expiry"), buyer, sellerPublicKey: raw.sellerPublicKey.map(BigInt) as [bigint, bigint], recipientSpendTag: bigint("recipientSpendTag"), sellerSignature: { R8x: BigInt(raw.sellerSignature.R8x), R8y: BigInt(raw.sellerSignature.R8y), S: BigInt(raw.sellerSignature.S) } };
    const state = await this.index.sync(); let selected: NoteOpeningData | undefined;
    for (const note of this.store.db.prepare("SELECT commitment FROM notes WHERE spent=0 ORDER BY commitment").all() as Array<{ commitment: string }>) { const secret = this.store.getSecret(`note:${note.commitment}`); if (!secret) continue; const opening = parseOpening(secret); if (opening.amount > agreement.paymentAmount && (!selected || opening.amount < selected.amount)) selected = opening; }
    const inputNote = selected ?? fail("INSUFFICIENT_SHIELDED_BALANCE", "no unspent note can pay the agreement while leaving positive change");
    const preparedChange = this.store.db.prepare("SELECT commitment FROM notes WHERE operation_id=? AND role='change'").get(operationId) as { commitment: string } | undefined, priorChange = preparedChange ? parseOpening(this.store.getSecret(`note:${preparedChange.commitment}`) ?? fail("NOTE_RECOVERY_MISMATCH", "prepared change opening is missing")) : undefined;
    const witness = this.engine.buildTransfer(state.leaves, inputNote, agreement, priorChange?.spendSecret, priorChange?.salt), changeCommitment = hex(witness.changeCommitment), inputNullifier = hex(witness.inputNullifier), proof = await this.prover.prove("transfer", witness.input), intentHash = hash(`shielded:${sessionId}:${witness.dealCommitment}:${state.root}`);
    this.store.db.prepare("INSERT OR IGNORE INTO live_transfer_inputs(operation_id,input_commitment,input_nullifier) VALUES(?,?,?)").run(operationId, hex(inputNote.commitment), inputNullifier);
    this.store.putSecretOnce(`note:${changeCommitment}`, serializeOpening(witness.changeOpening)); this.store.putNote(changeCommitment, "change", operationId, witness.changeOpening.leafIndex);
    const tx = buildPrivateTransfer({ packageId: this.profile.packageId, poolId: this.profile.poolId, coinType: this.profile.coinType, expiryMs: agreement.expiry, newIndex: witness.newIndex, dealCommitment: bytes32(witness.dealCommitment), dealNullifier: bytes32(witness.dealNullifier), inputNullifier: bytes32(witness.inputNullifier), paymentCommitment: bytes32(witness.paymentCommitment), changeCommitment: bytes32(witness.changeCommitment), newRoot: bytes32(witness.newRoot), proof: proof.proof });
    const evidence = await this.submit(operationId, await this.signed(operationId, intentHash, tx)); this.store.db.prepare("UPDATE notes SET spent=1,nullifier=? WHERE commitment=?").run(inputNullifier, hex(inputNote.commitment)); await this.index.sync();
    return { operationId, status: "finalized", rail: "shielded", sessionId, requestId: sessionId, amount: agreement.paymentAmount.toString(), counterparty: String(raw.counterparty), asset: this.profile.coinType, transactionDigest: evidence.transactionDigest, finalized: true, policyDecision: "allowed", tatumVerified: true, prover: proof.engine, dealCommitment: hex(witness.dealCommitment), paymentCommitment: hex(witness.paymentCommitment), changeCommitment, visibility: "amount-and-parties-hidden-in-pool", evidence: "sui-and-tatum-finalized" };
  }
  async payX402Resource(operationId: string, resourceUrl: string): Promise<Record<string, unknown>> {
    this.operationContext(operationId, "x402", resourceUrl);
    const existing = this.store.db.prepare("SELECT resource_url,receipt,response FROM live_x402_deliveries WHERE operation_id=?").get(operationId) as { resource_url: string; receipt: string; response: Buffer } | undefined;
    if (existing) { if (existing.resource_url !== resourceUrl) fail("OPERATION_ID_CONFLICT", "operation ID identifies another x402 resource"); return { ...JSON.parse(existing.receipt), response: existing.response.toString("base64"), replayed: true }; }
    let requested: URL; try { requested = new URL(resourceUrl); } catch (error) { return fail("X402_RESOURCE_INVALID", "resource URL is invalid", error); }
    if (requested.protocol !== "https:" && !(requested.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(requested.hostname))) fail("X402_RESOURCE_INVALID", "resource must use HTTPS except on loopback");
    const challenged = await fetch(requested, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (challenged.status !== 402) fail("X402_CHALLENGE_REQUIRED", `resource returned ${challenged.status} instead of 402`);
    const header = challenged.headers.get("payment-required"); await challenged.arrayBuffer();
    const encodedChallenge = header ?? fail("X402_CHALLENGE_INVALID", "payment-required header is missing");
    let challenge: Record<string, any>; try { challenge = JSON.parse(Buffer.from(encodedChallenge, "base64").toString()) as Record<string, any>; } catch (error) { return fail("X402_CHALLENGE_INVALID", "payment-required is not base64 JSON", error); }
    const accepted = Array.isArray(challenge.accepts) ? challenge.accepts[0] as Record<string, unknown> : undefined, resource = challenge.resource as Record<string, unknown> | undefined;
    if (challenge.x402Version !== 2 || !accepted || accepted.scheme !== "exact" || accepted.network !== "sui:testnet") fail("X402_CHALLENGE_INVALID", "resource does not offer x402 v2 exact payment on Sui Testnet");
    const requirements = accepted ?? fail("X402_CHALLENGE_INVALID", "challenge has no accepted payment requirements");
    const paymentUrl = new URL(String(resource?.url ?? resourceUrl)); if (paymentUrl.origin !== requested.origin) fail("X402_CHALLENGE_INVALID", "challenge redirected payment to another origin");
    const payTo = String(requirements.payTo), asset = String(requirements.asset), amount = BigInt(String(requirements.amount));
    if (!/^0x[0-9a-f]{64}$/i.test(payTo) || !/^0x[0-9a-f]+::[A-Za-z0-9_]+::[A-Za-z0-9_]+$/.test(asset) || amount <= 0n) fail("X402_CHALLENGE_INVALID", "challenge payment requirements are malformed");
    if (Date.now() > this.profile.policy.expiresAt) fail("POLICY_EXPIRED", "payment policy has expired");
    if (this.profile.policy.requiredPrivacy === "shielded") fail("POLICY_PRIVACY_REQUIRED", "policy requires shielded settlement");
    if (amount > BigInt(this.profile.policy.maxAmount)) fail("POLICY_AMOUNT_EXCEEDED", "challenge exceeds the configured cap");
    if (!this.profile.policy.allowedAssets.includes(asset)) fail("POLICY_ASSET_FORBIDDEN", "challenged asset is not allowed");
    if (!this.profile.policy.allowedCounterparties.includes(payTo)) fail("POLICY_COUNTERPARTY_FORBIDDEN", "challenged payee is not allowed");
    const tx = new (await import("@mysten/sui/transactions")).Transaction(); tx.transferObjects([tx.coin({ balance: amount, type: asset })], payTo);
    const intentHash = hash(JSON.stringify({ domain: "supercuts-x402-v2", operationId, resourceUrl, payTo, asset, amount: amount.toString() })), signed = await this.signed(operationId, intentHash, tx);
    const paymentPayload = { x402Version: 2, resource, accepted: requirements, payload: { signature: signed.signature, transaction: Buffer.from(signed.transaction).toString("base64") } };
    const paid = await fetch(paymentUrl, { redirect: "error", headers: { "payment-signature": Buffer.from(JSON.stringify(paymentPayload)).toString("base64") }, signal: AbortSignal.timeout(60_000) });
    const response = Buffer.from(await paid.arrayBuffer()); if (!paid.ok) fail("X402_DELIVERY_FAILED", `paid resource returned ${paid.status}`);
    const settlementHeader = paid.headers.get("payment-response") ?? fail("X402_SETTLEMENT_INVALID", "payment-response header is missing");
    let settlement: Record<string, unknown>; try { settlement = JSON.parse(Buffer.from(settlementHeader, "base64").toString()) as Record<string, unknown>; } catch (error) { return fail("X402_SETTLEMENT_INVALID", "payment-response is not base64 JSON", error); }
    if (settlement.success !== true || settlement.transaction !== signed.digest || settlement.network !== "sui:testnet") fail("X402_SETTLEMENT_INVALID", "resource reported a different or unsuccessful settlement");
    const finalized = await this.client.waitForTransaction({ digest: signed.digest, timeout: 60_000, include: { effects: true } }), finalTx = finalized.Transaction ?? finalized.FailedTransaction;
    if (!finalTx?.status.success || !finalTx.checkpoint) fail("TRANSACTION_FINALITY_FAILED", "x402 payment was not finalized successfully"); await this.tatum.getTransaction(signed.digest);
    const receipt = { operationId, status: "finalized", rail: "x402", amount: amount.toString(), counterparty: payTo, asset, requestId: operationId, transactionDigest: signed.digest, policyDecision: "allowed", tatumVerified: true, visibility: "public-transfer", finalized: true, checkpoint: finalTx.checkpoint, responseSha256: hash(response) };
    this.store.db.prepare("INSERT INTO live_x402_deliveries(operation_id,resource_url,receipt,response,updated_at) VALUES(?,?,?,?,?)").run(operationId, resourceUrl, JSON.stringify(receipt), response, Date.now());
    this.store.db.prepare("UPDATE live_signed_transactions SET status='finalized',updated_at=? WHERE operation_id=?").run(Date.now(), operationId); return { ...receipt, response: response.toString("base64") };
  }
}
