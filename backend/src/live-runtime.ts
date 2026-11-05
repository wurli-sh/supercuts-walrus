import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import { fail } from "./errors.js";
import { assertSuiFinality, assertTatumFinality } from "./finality.js";
import { LivePoolIndex } from "./live-index.js";
import { ProtocolEngine, type AcceptedAgreement, type NoteOpeningData } from "./protocol-engine.js";
import { Groth16Prover, type ProverConfig } from "./prover.js";
import { buildDeposit, buildPrivateTransfer, buildWithdraw, writeClient } from "./sui.js";
import { V2ExitQueue, type QueuedExit } from "./v2-exits.js";
import { TatumLedger } from "./tatum.js";
import type { RoleStore } from "./store.js";
import { paymentBindingBytes, requirementsHash, type ExactRequirements } from "./x402.js";

export function x402ResourceFailure(status: number, response: Uint8Array): string {
  const fallback = `paid resource returned ${status}`;
  let value: unknown;
  try { value = JSON.parse(Buffer.from(response).toString("utf8")); } catch { return fallback; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>, code = typeof record.error === "string" ? record.error.replace(/\s+/g, " ").slice(0, 128) : "", message = typeof record.message === "string" ? record.message.replace(/\s+/g, " ").slice(0, 512) : "";
  return code || message ? `${fallback}: ${[code, message].filter(Boolean).join(": ")}` : fallback;
}

export function timestampExpirationUnsupported(value: unknown): boolean {
  const messages: string[] = [];
  const visit = (item: unknown, depth = 0): void => {
    if (depth > 3 || item == null) return;
    if (typeof item === "string") messages.push(item);
    else if (item instanceof Error) { messages.push(item.message); visit(item.cause, depth + 1); }
    else if (typeof item === "object") for (const nested of Object.values(item as Record<string, unknown>)) visit(nested, depth + 1);
  };
  visit(value);
  return messages.some((message) => /timestamp-based transaction expiration is not yet supported|timestamp.*expiration.*not supported/i.test(message));
}

export interface LiveRuntimeProfile {
  role: "buyer" | "seller" | "auditor"; packageId: string; poolId: string; coinType: string; verifierVersion: number;
  live: {
    coinTypeHash: string; deploymentDomain: string; initialRoot: string; deploymentCheckpoint: string;
    writeGrpcEndpoint: string; tatumGrpcEndpoint: string; artifactRoot: string; snarkjsPath: string; converterPath: string;
    rapidsnarkPath?: string; artifacts: ProverConfig["expected"];
    walrusPublisherUrl?: string; walrusAggregatorUrl?: string;
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
    this.index = new LivePoolIndex(store, this.client, engine, profile.packageId, profile.poolId, BigInt(profile.live.deploymentCheckpoint), profile.verifierVersion === 2 ? "pool_v2" : "pool");
    this.prover = new Groth16Prover({ artifactRoot: profile.live.artifactRoot, snarkjsPath: profile.live.snarkjsPath, converterPath: profile.live.converterPath, ...(profile.live.rapidsnarkPath ? { rapidsnarkPath: profile.live.rapidsnarkPath } : {}), ...(profile.verifierVersion === 2 ? { version: 2 as const } : {}), expected: profile.live.artifacts });
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
    if (!suiObject.object) fail("POOL_OBJECT_MISSING", "pinned Testnet pool object is unavailable; check the Sui write RPC and deployment config");
    if (!service) fail("TATUM_UNAVAILABLE", "Tatum read RPC did not return service information; check its endpoint and owner-only API key");
    const babySeed = this.store.getSecret("identity:babyjub-seed") ?? fail("IDENTITY_MISSING", "BabyJub identity is missing");
    const identity = this.engine.identity(babySeed);
    const fixes: string[] = [];
    if (!artifacts.rapidSnark) fixes.push("Set an executable RapidSnark path in the role profile for v2 proofs.");
    if (!this.profile.live.walrusPublisherUrl) fixes.push("Configure the Walrus publisher URL for capability and transcript writes.");
    if (!this.profile.live.walrusAggregatorUrl) fixes.push("Configure the Walrus aggregator URL for capability and transcript reads.");
    for (const [name, endpoint] of [["publisher", this.profile.live.walrusPublisherUrl], ["aggregator", this.profile.live.walrusAggregatorUrl]] as const) {
      if (!endpoint) continue;
      try { const response = await fetch(endpoint, { method: "HEAD", signal: AbortSignal.timeout(8_000) }); if (response.status >= 500) fixes.push(`Walrus ${name} returned HTTP ${response.status}; check the configured service.`); }
      catch { fixes.push(`Walrus ${name} is unreachable; check the configured URL and network access.`); }
    }
    if (this.profile.role === "buyer" && !this.store.getSecret("live:memory-config")) fixes.push("Configure an owner-only Walrus Memory file using the local 1536-dimensional embedding adapter.");
    return { healthy: true, readyForDemo: fixes.length === 0, fixes, runtime: "testnet-live", signer: this.signer.toSuiAddress(), babyJubPublicKey: identity.publicKey.map(String), x25519PublicKey: this.store.getSecret("identity:x25519-public")?.toString("base64"), rapidSnark: artifacts.rapidSnark, artifacts: artifacts.artifacts, poolObjectVerified: true, tatumServiceVerified: true };
  }
  async balance(): Promise<Record<string, unknown>> {
    const state = await this.index.sync(); let available = 0n, notes = 0;
    for (const row of this.store.db.prepare("SELECT commitment FROM notes WHERE spent=0 ORDER BY commitment").all() as Array<{ commitment: string }>) {
      const secret = this.store.getSecret(`note:${row.commitment}`); if (!secret) continue;
      const opening = parseOpening(secret); if (state.leaves[Number(opening.leafIndex)] === opening.commitment) { available += opening.amount; notes++; }
    }
    return { available: available.toString(), notes, root: hex(state.root), nextLeaf: state.nextLeaf.toString(), checkpoint: state.lastCheckpoint.toString(), evidence: "event-derived-and-pool-object-verified",
      ...(state.activity ? { poolActivity: state.activity, privacyWarning: state.activity.reducedPrivacy ? "Sparse observed pool use reduces privacy; distinct depositing addresses do not prove independent users" : undefined } : {}) };
  }
  private async signed(operationId: string, intentHash: string, tx: Transaction, legacyIntentHash?: string): Promise<{ digest: string; transaction: Uint8Array; signature: string }> {
    const existing = this.store.db.prepare("SELECT intent_hash,transaction_bytes,signature,digest FROM live_signed_transactions WHERE operation_id=?").get(operationId) as { intent_hash: string; transaction_bytes: Buffer; signature: string; digest: string } | undefined;
    if (existing) { if (existing.intent_hash !== intentHash && existing.intent_hash !== legacyIntentHash) fail("OPERATION_ID_CONFLICT", "operation ID identifies different transaction intent"); return { digest: existing.digest, transaction: existing.transaction_bytes, signature: existing.signature }; }
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
  private async submit(operationId: string, signed: { digest: string; transaction: Uint8Array; signature: string }, finalizeState?: () => void): Promise<Record<string, unknown>> {
    let result;
    try { result = await this.client.executeTransaction({ transaction: signed.transaction, signatures: [signed.signature], include: { effects: true, events: true } }); }
    catch { try { await this.tatum.getTransaction(signed.digest); } catch (cause) { fail("BROADCAST_UNRESOLVED", "broadcast outcome is ambiguous; exact signed bytes remain journaled for retry", cause); } }
    const finalized = await this.client.waitForTransaction({ digest: signed.digest, timeout: 60_000, include: { effects: true, events: true } });
    const checkpoint = assertSuiFinality(finalized, signed.digest);
    await this.confirmTatum(signed.digest, checkpoint);
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      finalizeState?.();
      this.store.db.prepare("UPDATE live_signed_transactions SET status='finalized',updated_at=? WHERE operation_id=?").run(Date.now(), operationId);
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
    return { transactionDigest: signed.digest, checkpoint, finalized: true, evidence: { sui: "effects-and-checkpoint", tatum: true, broadcastResult: Boolean(result) } };
  }
  private async confirmTatum(digest: string, checkpoint: string): Promise<void> {
    assertTatumFinality(await this.tatum.getTransaction(digest), digest, checkpoint);
  }
  async paymentStatus(operationId: string, reconcile = false): Promise<Record<string, unknown>> {
    const row = this.store.db.prepare("SELECT digest,status,updated_at AS updatedAt FROM live_signed_transactions WHERE operation_id=?").get(operationId) as { digest: string; status: string; updatedAt: number } | undefined;
    if (!row) fail("OPERATION_NOT_FOUND", "payment operation was not found in the live transaction journal");
    const payment = row as { digest: string; status: string; updatedAt: number };
    const context = this.store.db.prepare("SELECT kind FROM live_operation_context WHERE operation_id=?").get(operationId) as { kind: string } | undefined;
    const delivered = Boolean(this.store.db.prepare("SELECT 1 FROM live_x402_deliveries WHERE operation_id=?").get(operationId));
    if (payment.status === "finalized") return { operationId, status: "finalized", transactionDigest: payment.digest, kind: context?.kind ?? "unknown", deliveryStatus: delivered ? "delivered" : "not-applicable-or-pending", finalized: true, safeToResumeSameOperationId: true };
    if (!reconcile) return { operationId, status: payment.status, transactionDigest: payment.digest, kind: context?.kind ?? "unknown", deliveryStatus: delivered ? "delivered" : "pending", finalized: false, chainStatus: "unchecked", safeToResumeSameOperationId: true };
    try {
      const transaction = await this.client.waitForTransaction({ digest: payment.digest, timeout: 5_000, include: { effects: true } });
      const checkpoint = assertSuiFinality(transaction, payment.digest); await this.confirmTatum(payment.digest, checkpoint);
      this.store.db.prepare("UPDATE live_signed_transactions SET status='finalized',updated_at=? WHERE operation_id=?").run(Date.now(), operationId);
      return { operationId, status: "finalized", transactionDigest: payment.digest, kind: context?.kind ?? "unknown", deliveryStatus: delivered ? "delivered" : "pending", finalized: true, checkpoint, tatumVerified: true, safeToResumeSameOperationId: true };
    } catch {
      return { operationId, status: payment.status, transactionDigest: payment.digest, kind: context?.kind ?? "unknown", deliveryStatus: delivered ? "delivered" : "pending", finalized: false, chainStatus: "not-found-or-pending", safeToResumeSameOperationId: true };
    }
  }
  private prepareOpening(opening: NoteOpeningData, role: "input" | "change", operationId: string, leaves: bigint[]): void {
    const commitment = hex(opening.commitment), key = `note:${commitment}`;
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.store.getSecret(key);
      if (prior) {
        const old = parseOpening(prior);
        const row = this.store.db.prepare("SELECT role,operation_id,leaf_index,spent FROM notes WHERE commitment=?").get(commitment) as { role: string; operation_id: string | null; leaf_index: string | null; spent: number } | undefined;
        if (!row || row.role !== role || row.operation_id !== operationId || row.spent ||
          serializeOpening({ ...old, leafIndex: opening.leafIndex }).toString() !== serializeOpening(opening).toString()) fail("NOTE_ID_CONFLICT", "prepared note opening differs from this operation");
        if (old.leafIndex !== opening.leafIndex) {
          if (leaves[Number(old.leafIndex)] === opening.commitment) fail("NOTE_ID_CONFLICT", "an indexed note cannot move to another leaf");
          this.store.putSecret(key, serializeOpening(opening));
          this.store.db.prepare("UPDATE notes SET leaf_index=? WHERE commitment=?").run(opening.leafIndex.toString(), commitment);
        }
      } else {
        this.store.putSecretOnce(key, serializeOpening(opening));
        this.store.putNote(commitment, role, operationId, opening.leafIndex);
      }
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
  }
  async deposit(amount: bigint, operationId: string): Promise<Record<string, unknown>> {
    if (this.profile.role !== "buyer") fail("ROLE_FORBIDDEN", "only a buyer role can deposit");
    this.operationContext(operationId, "deposit", amount.toString()); const prepared = this.store.db.prepare("SELECT commitment FROM notes WHERE operation_id=? AND role='input'").get(operationId) as { commitment: string } | undefined, prior = this.existingSigned(operationId);
    if (prior) { const evidence = await this.submit(operationId, prior); return { commitment: prepared?.commitment, amount: amount.toString(), resumed: true, ...evidence }; }
    const state = await this.index.sync(), identity = this.engine.identity(this.store.getSecret("identity:babyjub-seed") ?? fail("IDENTITY_MISSING", "BabyJub identity is missing"));
    const priorOpening = prepared ? parseOpening(this.store.getSecret(`note:${prepared.commitment}`) ?? fail("NOTE_RECOVERY_MISMATCH", "prepared deposit opening is missing")) : undefined;
    const witness = this.engine.buildDeposit(state.leaves, identity, amount, priorOpening?.spendSecret, priorOpening?.salt), commitment = hex(witness.opening.commitment), intentHash = hash(`deposit:${amount}:${state.root}:${commitment}`);
    this.prepareOpening(witness.opening, "input", operationId, state.leaves);
    const proof = await this.prover.prove("deposit", witness.input);
    const tx = buildDeposit({ packageId: this.profile.packageId, poolId: this.profile.poolId, coinType: this.profile.coinType, poolModule: this.profile.verifierVersion === 2 ? "pool_v2" : "pool", amount, noteCommitment: bytes32(witness.opening.commitment), newRoot: bytes32(witness.newRoot), newIndex: witness.newIndex, proof: proof.proof });
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
    if (this.profile.verifierVersion === 2) fail("V2_EXIT_RELAY_REQUIRED", "v2 exits require an owner-approved scheduled request and a separate relayer");
    this.operationContext(operationId, "withdraw", `${commitment}:${recipient}`); const secret = this.store.getSecret(`note:${commitment}`) ?? fail("NOTE_NOT_FOUND", "encrypted note opening was not found"); const note = parseOpening(secret), prior = this.existingSigned(operationId); if (prior) { const evidence = await this.submit(operationId, prior, () => { this.store.db.prepare("UPDATE notes SET spent=1 WHERE commitment=?").run(commitment); }); return { commitment, amount: note.amount.toString(), recipient, resumed: true, ...evidence }; } const state = await this.index.sync();
    const witness = this.engine.buildWithdraw(state.leaves, note, recipient), nullifier = hex(witness.noteNullifier), proof = await this.prover.prove("withdraw", witness.input), intentHash = hash(`withdraw:${commitment}:${recipient}:${state.root}`);
    const tx = buildWithdraw({ packageId: this.profile.packageId, poolId: this.profile.poolId, coinType: this.profile.coinType, root: bytes32(state.root), noteNullifier: bytes32(witness.noteNullifier), recipient, amount: note.amount, proof: proof.proof });
    const evidence = await this.submit(operationId, await this.signed(operationId, intentHash, tx), () => { this.store.db.prepare("UPDATE notes SET spent=1,nullifier=? WHERE commitment=?").run(nullifier, commitment); }); return { commitment, amount: note.amount.toString(), recipient, nullifier, prover: proof.engine, ...evidence };
  }
  async queueV2Exit(commitment: string, operationId: string, amount: bigint, exactExit: boolean, windowStart: number, windowEnd: number, ownerApproved: boolean): Promise<QueuedExit> {
    if (this.profile.verifierVersion !== 2 || this.profile.role === "auditor") fail("V2_EXIT_UNAVAILABLE", "v2 exits require a buyer or seller v2 role");
    this.operationContext(operationId, "exit-v2", `${commitment}:${amount}:${exactExit}:${windowStart}:${windowEnd}`);
    const row = this.store.db.prepare("SELECT spent FROM notes WHERE commitment=?").get(commitment) as { spent: number } | undefined;
    if (!row || row.spent) fail("NOTE_NOT_FOUND", "unspent recovered note was not found");
    const secret = this.store.getSecret(`note:${commitment}`) ?? fail("NOTE_NOT_FOUND", "encrypted note opening was not found");
    const note = parseOpening(secret), queue = new V2ExitQueue(this.store);
    const scheduled = queue.queue({ operationId, commitment, amount, exactExit, windowStart, windowEnd }, ownerApproved);
    if (this.store.getSecret(`v2-exit-request:${operationId}`)) return scheduled;
    const state = await this.index.sync();
    const witness = this.engine.buildWithdrawV2(state.leaves, note, scheduled.payoutAddress, amount, exactExit);
    const proof = await this.prover.prove("withdraw", witness.input);
    const request = { operationId, root: hex(state.root), noteNullifier: hex(witness.noteNullifier), recipient: scheduled.payoutAddress,
      amount: amount.toString(), exactExit, changeCommitment: hex(witness.changeOpening.commitment), newRoot: hex(witness.newRoot),
      newIndex: witness.newIndex.toString(), proof: proof.proof.toString("base64") };
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      if (witness.changeOpening.amount > 0n) {
        const changeCommitment = hex(witness.changeOpening.commitment);
        this.store.putSecretOnce(`note:${changeCommitment}`, serializeOpening(witness.changeOpening));
        this.store.putNote(changeCommitment, "change", operationId, witness.changeOpening.leafIndex);
      }
      this.store.putSecretOnce(`v2-exit-request:${operationId}`, Buffer.from(JSON.stringify(request)));
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
    return scheduled;
  }
  async refreshV2Exit(operationId: string): Promise<{ refreshed: boolean; requestOperationId: string }> {
    if (this.profile.verifierVersion !== 2) fail("V2_EXIT_UNAVAILABLE", "v2 exit refresh requires a v2 profile");
    const queue = new V2ExitQueue(this.store), scheduled = queue.get(operationId) ?? fail("EXIT_REQUEST_INVALID", "exit operation is missing");
    if (scheduled.status !== "queued" || Date.now() >= scheduled.windowEnd) fail("EXIT_WINDOW_CLOSED", "only an unsubmitted exit inside its owner window can be refreshed");
    const encoded = this.store.getSecret(`v2-exit-request:${operationId}`) ?? fail("EXIT_REQUEST_INVALID", "persisted v2 exit proof is missing");
    const previous = JSON.parse(encoded.toString()) as { root: string; changeCommitment: string; operationId: string };
    const state = await this.index.sync();
    if (previous.root === hex(state.root)) return { refreshed: false, requestOperationId: previous.operationId };
    const secret = this.store.getSecret(`note:${scheduled.commitment}`) ?? fail("NOTE_NOT_FOUND", "encrypted note opening was not found");
    const note = parseOpening(secret), witness = this.engine.buildWithdrawV2(state.leaves, note, scheduled.payoutAddress, scheduled.amount, scheduled.exactExit);
    const proof = await this.prover.prove("withdraw", witness.input);
    const requestOperationId = `${operationId.slice(0, 200)}:root:${hex(state.root).slice(0, 16)}`;
    const request = { operationId: requestOperationId, root: hex(state.root), noteNullifier: hex(witness.noteNullifier), recipient: scheduled.payoutAddress,
      amount: scheduled.amount.toString(), exactExit: scheduled.exactExit, changeCommitment: hex(witness.changeOpening.commitment),
      newRoot: hex(witness.newRoot), newIndex: witness.newIndex.toString(), proof: proof.proof.toString("base64") };
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db.prepare("DELETE FROM notes WHERE commitment=? AND operation_id=? AND role='change' AND spent=0").run(previous.changeCommitment, operationId);
      this.store.db.prepare("DELETE FROM secrets WHERE name=?").run(`note:${previous.changeCommitment}`);
      if (witness.changeOpening.amount > 0n) {
        const changeCommitment = hex(witness.changeOpening.commitment);
        this.store.putSecretOnce(`note:${changeCommitment}`, serializeOpening(witness.changeOpening));
        this.store.putNote(changeCommitment, "change", operationId, witness.changeOpening.leafIndex);
      }
      this.store.putSecret(`v2-exit-request:${operationId}`, Buffer.from(JSON.stringify(request)));
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
    return { refreshed: true, requestOperationId };
  }
  async finalizeV2Exit(operationId: string, digest: string, relayerAddress: string): Promise<Record<string, unknown>> {
    if (this.profile.verifierVersion !== 2) fail("V2_EXIT_UNAVAILABLE", "v2 exit finality requires a v2 profile");
    const queue = new V2ExitQueue(this.store), scheduled = queue.get(operationId) ?? fail("EXIT_REQUEST_INVALID", "exit operation is missing");
    const encoded = this.store.getSecret(`v2-exit-request:${operationId}`) ?? fail("EXIT_REQUEST_INVALID", "persisted v2 exit proof is missing");
    const request = JSON.parse(encoded.toString()) as Record<string, string | boolean>;
    const observed = await this.client.getTransaction({ digest, include: { events: true, effects: true, transaction: true } });
    const checkpoint = assertSuiFinality(observed, digest);
    const tx = observed.Transaction ?? observed.FailedTransaction;
    if (tx.transaction?.sender?.toLowerCase() !== relayerAddress.toLowerCase()) fail("EXIT_FINALITY_INVALID", "exit was not finalized by the pinned relayer");
    const vector = (value: unknown): string => {
      if (typeof value !== "string") fail("EXIT_EVENT_INVALID", "exit event field is missing");
      return /^(?:0x)?[0-9a-f]{64}$/i.test(value as string) ? (value as string).replace(/^0x/, "").toLowerCase() : Buffer.from(value as string, "base64").toString("hex");
    };
    const event = tx.events?.find((item) => item.packageId.toLowerCase() === this.profile.packageId.toLowerCase() && item.module === "pool_v2" && item.eventType.endsWith("::WithdrawEvent"));
    const value = event?.json as Record<string, unknown> | undefined;
    if (!value || vector(value.old_root) !== request.root || vector(value.new_root) !== request.newRoot ||
      vector(value.note_nullifier) !== request.noteNullifier || vector(value.change_commitment) !== request.changeCommitment ||
      String(value.recipient).toLowerCase() !== String(request.recipient).toLowerCase() || String(value.amount) !== request.amount ||
      value.exact_exit !== request.exactExit || BigInt(String(value.leaf_index)) + 1n !== BigInt(String(request.newIndex))) fail("EXIT_EVENT_INVALID", "finalized exit event differs from the locally proved request");
    await this.confirmTatum(digest, checkpoint);
    await this.index.sync();
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      queue.recordSubmission(operationId, digest);
      queue.recordFinalized(operationId, digest);
      this.store.db.prepare("UPDATE notes SET spent=1,nullifier=? WHERE commitment=?").run(String(request.noteNullifier), scheduled.commitment);
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
    return { operationId, digest, checkpoint, payoutAddress: scheduled.payoutAddress, amount: scheduled.amount.toString(), exactExit: scheduled.exactExit, relayer: relayerAddress, tatumVerified: true, finalized: true };
  }
  acceptAgreement(sessionId: string, encoded: string): Record<string, unknown> {
    if (this.profile.role !== "buyer") fail("ROLE_FORBIDDEN", "only the buyer can accept a settlement agreement");
    let raw: Record<string, unknown>; try { raw = JSON.parse(Buffer.from(encoded, "base64url").toString()) as Record<string, unknown>; } catch (error) { return fail("AGREEMENT_INVALID", "agreement must be base64url JSON", error); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.sessionId !== sessionId || !sessionId || sessionId.length > 256 ||
      !["shielded", "x402"].includes(String(raw.rail))) fail("AGREEMENT_INVALID", "agreement session or rail is invalid");
    const number = (name: string): bigint => { const value = raw[name]; if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return fail("AGREEMENT_INVALID", `${name} must be a decimal integer`); return BigInt(value); };
    const point = (name: string): [bigint, bigint] => { const value = raw[name]; if (!Array.isArray(value) || value.length !== 2 || value.some((item) => typeof item !== "string" || !/^[0-9]+$/.test(item))) return fail("AGREEMENT_INVALID", `${name} must be a decimal BabyJub point`); return [BigInt(value[0] as string), BigInt(value[1] as string)]; };
    const buyer = this.engine.identity(this.store.getSecret("identity:babyjub-seed") ?? fail("IDENTITY_MISSING", "BabyJub identity is missing")), suppliedBuyer = point("buyerPublicKey");
    if (suppliedBuyer[0] !== buyer.publicKey[0] || suppliedBuyer[1] !== buyer.publicKey[1]) fail("AGREEMENT_BUYER_MISMATCH", "agreement is bound to another buyer identity");
    const signatureRaw = raw.sellerSignature as Record<string, unknown> | undefined ?? fail("AGREEMENT_INVALID", "sellerSignature is missing");
    if (!signatureRaw || typeof signatureRaw !== "object" || ["R8x", "R8y", "S"].some((key) => typeof signatureRaw[key] !== "string" || !/^[0-9]+$/.test(signatureRaw[key] as string))) fail("AGREEMENT_INVALID", "sellerSignature is malformed");
    const signature = { R8x: BigInt(signatureRaw.R8x as string), R8y: BigInt(signatureRaw.R8y as string), S: BigInt(signatureRaw.S as string) };
    const unsigned = { dealId: number("dealId"), revision: number("revision"), transcriptRootLo: number("transcriptRootLo"), transcriptRootHi: number("transcriptRootHi"), serviceDigestLo: number("serviceDigestLo"), serviceDigestHi: number("serviceDigestHi"), settlementNonceLo: number("settlementNonceLo"), settlementNonceHi: number("settlementNonceHi"), paymentAmount: number("paymentAmount"), blinding: number("blinding"), expiry: number("expiry"), buyer, sellerPublicKey: point("sellerPublicKey"), recipientSpendTag: number("recipientSpendTag") };
    if (unsigned.paymentAmount <= 0n || unsigned.expiry <= BigInt(Date.now())) fail("AGREEMENT_INVALID", "agreement amount or expiry is invalid");
    if (Date.now() > this.profile.policy.expiresAt) fail("POLICY_EXPIRED", "payment policy has expired");
    const counterparty = String(raw.counterparty ?? ""); if (!counterparty || !this.profile.policy.allowedCounterparties.includes(counterparty)) fail("POLICY_COUNTERPARTY_FORBIDDEN", "agreement counterparty is not allowed");
    if (unsigned.paymentAmount > BigInt(this.profile.policy.maxAmount)) fail("POLICY_AMOUNT_EXCEEDED", "agreement exceeds the configured cap");
    if (!this.profile.policy.allowedAssets.includes(this.profile.coinType)) fail("POLICY_ASSET_FORBIDDEN", "pool asset is not allowed");
    const values = this.engine.agreementValues(unsigned); if (!this.engine.verify(unsigned.sellerPublicKey, 2005n, values.dealCommitment, signature)) fail("AGREEMENT_SIGNATURE_INVALID", "seller did not sign the pinned agreement commitment");
    const serialized = JSON.stringify({ ...raw, sessionId }); const existing = this.store.db.prepare("SELECT agreement FROM live_agreements WHERE session_id=?").get(sessionId) as { agreement: string } | undefined;
    if (existing && existing.agreement !== serialized) fail("AGREEMENT_SESSION_CONFLICT", "session already contains another accepted agreement");
    this.store.db.prepare("INSERT OR IGNORE INTO live_agreements(session_id,agreement,deal_commitment,accepted_at) VALUES(?,?,?,?)").run(sessionId, serialized, hex(values.dealCommitment), Date.now());
    return { sessionId, revision: unsigned.revision.toString(), state: "accepted", dealCommitment: hex(values.dealCommitment), expiry: unsigned.expiry.toString(), paymentAmount: unsigned.paymentAmount.toString(), counterparty, ...(typeof raw.capabilityId === "string" ? { capabilityId: raw.capabilityId } : {}), ...(typeof raw.manifestHash === "string" ? { manifestHash: raw.manifestHash } : {}) };
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
  async settleShielded(sessionId: string, operationId: string, bind?: (actual: { amount: string; counterparty: string; asset: string; requestId: string; session: string }) => void): Promise<Record<string, unknown>> {
    if (this.profile.role !== "buyer") fail("ROLE_FORBIDDEN", "only the buyer can settle a shielded agreement");
    this.operationContext(operationId, "shielded", sessionId);
    const row = this.store.db.prepare("SELECT agreement FROM live_agreements WHERE session_id=?").get(sessionId) as { agreement: string } | undefined ?? fail("AGREEMENT_NOT_ACCEPTED", "session has no accepted cryptographic agreement");
    const raw = JSON.parse(row.agreement) as Record<string, any>, bigint = (name: string) => BigInt(String(raw[name]));
    if (raw.sessionId !== sessionId || raw.rail !== "shielded") fail("AGREEMENT_BINDING_MISMATCH", "accepted agreement does not authorize shielded settlement for this session");
    bind?.({ amount: String(raw.paymentAmount), counterparty: String(raw.counterparty), asset: this.profile.coinType, requestId: sessionId, session: sessionId });
    const prior = this.existingSigned(operationId); if (prior) { const input = this.store.db.prepare("SELECT input_commitment,input_nullifier FROM live_transfer_inputs WHERE operation_id=?").get(operationId) as { input_commitment: string; input_nullifier: string } | undefined ?? fail("NOTE_RECOVERY_MISMATCH", "signed shielded payment has no persisted input note"); const evidence = await this.submit(operationId, prior, () => { this.store.db.prepare("UPDATE notes SET spent=1,nullifier=? WHERE commitment=?").run(input.input_nullifier, input.input_commitment); }); return { operationId, status: "finalized", rail: "shielded", sessionId, requestId: sessionId, amount: String(raw.paymentAmount), counterparty: String(raw.counterparty), asset: this.profile.coinType, policyDecision: "allowed", tatumVerified: true, visibility: "no-direct-public-payment; funding-deposits-withdrawals-gas-and-pool-activity-visible", evidence: "sui-and-tatum-finalized", resumed: true, ...evidence }; }
    if (Date.now() >= Number(raw.expiry)) fail("AGREEMENT_EXPIRED", "accepted agreement expired before a payment was signed");
    if (Date.now() > this.profile.policy.expiresAt) fail("POLICY_EXPIRED", "payment policy has expired");
    if (BigInt(String(raw.paymentAmount)) > BigInt(this.profile.policy.maxAmount) || !this.profile.policy.allowedAssets.includes(this.profile.coinType) || !this.profile.policy.allowedCounterparties.includes(String(raw.counterparty))) fail("POLICY_PAYMENT_DENIED", "accepted agreement no longer fits the buyer payment policy");
    const buyer = this.engine.identity(this.store.getSecret("identity:babyjub-seed") ?? fail("IDENTITY_MISSING", "BabyJub identity is missing"));
    const agreement: AcceptedAgreement = { dealId: bigint("dealId"), revision: bigint("revision"), transcriptRootLo: bigint("transcriptRootLo"), transcriptRootHi: bigint("transcriptRootHi"), serviceDigestLo: bigint("serviceDigestLo"), serviceDigestHi: bigint("serviceDigestHi"), settlementNonceLo: bigint("settlementNonceLo"), settlementNonceHi: bigint("settlementNonceHi"), paymentAmount: bigint("paymentAmount"), blinding: bigint("blinding"), expiry: bigint("expiry"), buyer, sellerPublicKey: raw.sellerPublicKey.map(BigInt) as [bigint, bigint], recipientSpendTag: bigint("recipientSpendTag"), sellerSignature: { R8x: BigInt(raw.sellerSignature.R8x), R8y: BigInt(raw.sellerSignature.R8y), S: BigInt(raw.sellerSignature.S) } };
    const state = await this.index.sync(); let selected: NoteOpeningData | undefined;
    const reservedInput = this.store.db.prepare("SELECT input_commitment,input_nullifier FROM live_transfer_inputs WHERE operation_id=?").get(operationId) as { input_commitment: string; input_nullifier: string } | undefined;
    for (const note of this.store.db.prepare("SELECT commitment FROM notes WHERE spent=0 ORDER BY commitment").all() as Array<{ commitment: string }>) { if (reservedInput && reservedInput.input_commitment !== note.commitment) continue; const secret = this.store.getSecret(`note:${note.commitment}`); if (!secret) continue; const opening = parseOpening(secret); if (state.leaves[Number(opening.leafIndex)] !== opening.commitment) continue; if (opening.amount > agreement.paymentAmount && (!selected || opening.amount < selected.amount)) selected = opening; }
    const inputNote = selected ?? fail("INSUFFICIENT_SHIELDED_BALANCE", "no unspent note can pay the agreement while leaving positive change");
    const preparedChange = this.store.db.prepare("SELECT commitment FROM notes WHERE operation_id=? AND role='change'").get(operationId) as { commitment: string } | undefined, priorChange = preparedChange ? parseOpening(this.store.getSecret(`note:${preparedChange.commitment}`) ?? fail("NOTE_RECOVERY_MISMATCH", "prepared change opening is missing")) : undefined;
    const witness = this.engine.buildTransfer(state.leaves, inputNote, agreement, priorChange?.spendSecret, priorChange?.salt), changeCommitment = hex(witness.changeCommitment), inputNullifier = hex(witness.inputNullifier), proof = await this.prover.prove("transfer", witness.input), intentHash = hash(`shielded:${sessionId}:${witness.dealCommitment}:${state.root}`);
    if (reservedInput && (reservedInput.input_commitment !== hex(inputNote.commitment) || reservedInput.input_nullifier !== inputNullifier)) fail("OPERATION_ID_CONFLICT", "shielded operation identifies a different input note");
    this.store.db.prepare("INSERT OR IGNORE INTO live_transfer_inputs(operation_id,input_commitment,input_nullifier) VALUES(?,?,?)").run(operationId, hex(inputNote.commitment), inputNullifier);
    this.prepareOpening(witness.changeOpening, "change", operationId, state.leaves);
    const tx = buildPrivateTransfer({ packageId: this.profile.packageId, poolId: this.profile.poolId, coinType: this.profile.coinType, poolModule: this.profile.verifierVersion === 2 ? "pool_v2" : "pool", expiryMs: agreement.expiry, newIndex: witness.newIndex, dealCommitment: bytes32(witness.dealCommitment), dealNullifier: bytes32(witness.dealNullifier), inputNullifier: bytes32(witness.inputNullifier), paymentCommitment: bytes32(witness.paymentCommitment), changeCommitment: bytes32(witness.changeCommitment), newRoot: bytes32(witness.newRoot), proof: proof.proof });
    const evidence = await this.submit(operationId, await this.signed(operationId, intentHash, tx), () => { this.store.db.prepare("UPDATE notes SET spent=1,nullifier=? WHERE commitment=?").run(inputNullifier, hex(inputNote.commitment)); }); await this.index.sync();
    return { operationId, status: "finalized", rail: "shielded", sessionId, requestId: sessionId, amount: agreement.paymentAmount.toString(), counterparty: String(raw.counterparty), asset: this.profile.coinType, transactionDigest: evidence.transactionDigest, finalized: true, policyDecision: "allowed", tatumVerified: true, prover: proof.engine, proveMs: proof.proveMs, dealCommitment: hex(witness.dealCommitment), paymentCommitment: hex(witness.paymentCommitment), changeCommitment, visibility: "no-direct-public-payment; funding-deposits-withdrawals-gas-and-pool-activity-visible", evidence: "sui-and-tatum-finalized" };
  }
  async payX402Resource(operationId: string, resourceUrl: string, bind?: (actual: { amount: string; counterparty: string; asset: string; endpoint: string; requestId: string; requirementsHash: string }) => void): Promise<Record<string, unknown>> {
    this.operationContext(operationId, "x402", resourceUrl);
    const existing = this.store.db.prepare("SELECT resource_url,receipt,response FROM live_x402_deliveries WHERE operation_id=?").get(operationId) as { resource_url: string; receipt: string; response: Buffer } | undefined;
    if (existing) { if (existing.resource_url !== resourceUrl) fail("OPERATION_ID_CONFLICT", "operation ID identifies another x402 resource"); const receipt = JSON.parse(existing.receipt) as Record<string, unknown>; bind?.({ amount: String(receipt.amount), counterparty: String(receipt.counterparty), asset: String(receipt.asset), endpoint: resourceUrl, requestId: String(receipt.requestId), requirementsHash: String(receipt.requirementsHash) }); return { ...receipt, response: existing.response.toString("base64"), replayed: true }; }
    let requested: URL; try { requested = new URL(resourceUrl); } catch (error) { return fail("X402_RESOURCE_INVALID", "resource URL is invalid", error); }
    if (requested.protocol !== "https:" && !(requested.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(requested.hostname))) fail("X402_RESOURCE_INVALID", "resource must use HTTPS except on loopback");
    const challenged = await fetch(requested, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (challenged.status !== 402) fail("X402_CHALLENGE_REQUIRED", `resource returned ${challenged.status} instead of 402`);
    const header = challenged.headers.get("payment-required"); await challenged.arrayBuffer();
    const encodedChallenge = header ?? fail("X402_CHALLENGE_INVALID", "payment-required header is missing");
    let challenge: Record<string, any>; try { challenge = JSON.parse(Buffer.from(encodedChallenge, "base64").toString()) as Record<string, any>; } catch (error) { return fail("X402_CHALLENGE_INVALID", "payment-required is not base64 JSON", error); }
    const accepted = Array.isArray(challenge.accepts) ? challenge.accepts[0] as Record<string, unknown> : undefined, resource = challenge.resource as Record<string, unknown> | undefined;
    if (challenge.x402Version !== 2 || !accepted || accepted.scheme !== "exact" || accepted.network !== "sui:testnet") fail("X402_CHALLENGE_INVALID", "resource does not offer x402 v2 exact payment on Sui Testnet");
    const requirements = accepted as unknown as ExactRequirements ?? fail("X402_CHALLENGE_INVALID", "challenge has no accepted payment requirements");
    const paymentUrl = new URL(String(resource?.url ?? resourceUrl)); if (paymentUrl.toString() !== requested.toString()) fail("X402_CHALLENGE_INVALID", "challenge redirected payment away from the requested resource");
    const payTo = String(requirements.payTo), asset = String(requirements.asset), amount = BigInt(String(requirements.amount));
    if (!/^0x[0-9a-f]{64}$/i.test(payTo) || !/^0x[0-9a-f]+::[A-Za-z0-9_]+::[A-Za-z0-9_]+$/.test(asset) || amount <= 0n) fail("X402_CHALLENGE_INVALID", "challenge payment requirements are malformed");
    if (Date.now() > this.profile.policy.expiresAt) fail("POLICY_EXPIRED", "payment policy has expired");
    if (this.profile.policy.requiredPrivacy === "shielded") fail("POLICY_PRIVACY_REQUIRED", "policy requires shielded settlement");
    if (amount > BigInt(this.profile.policy.maxAmount)) fail("POLICY_AMOUNT_EXCEEDED", "challenge exceeds the configured cap");
    if (!this.profile.policy.allowedAssets.includes(asset)) fail("POLICY_ASSET_FORBIDDEN", "challenged asset is not allowed");
    if (!this.profile.policy.allowedCounterparties.includes(payTo)) fail("POLICY_COUNTERPARTY_FORBIDDEN", "challenged payee is not allowed");
    const extra = requirements.extra as Record<string, unknown> | undefined, requestId = String(extra?.requestId ?? operationId), challengeOperationId = String(extra?.operationId ?? operationId), nonce = String(extra?.nonce ?? ""), expiresAt = Number(extra?.expiresAt);
    const unsignedRequirements = { ...requirements, extra: { requestId, operationId: challengeOperationId, nonce, expiresAt } };
    if (challengeOperationId !== operationId || !nonce || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || String(extra?.requirementsHash ?? "") !== requirementsHash(unsignedRequirements)) fail("X402_CHALLENGE_INVALID", "challenge does not bind this operation, request, and expiry");
    bind?.({ amount: amount.toString(), counterparty: payTo, asset, endpoint: resourceUrl, requestId, requirementsHash: String(extra?.requirementsHash) });
    const tx = new (await import("@mysten/sui/transactions")).Transaction(); tx.transferObjects([tx.coin({ balance: amount, type: asset })], payTo);
    tx.setSender(this.signer.toSuiAddress()); await tx.build({ client: this.client });
    const resolvedExpiration = tx.getData().expiration;
    const validity = resolvedExpiration?.$kind === "ValidDuring" ? resolvedExpiration.ValidDuring : fail("X402_TRANSACTION_EXPIRY_INVALID", "Sui did not resolve a bounded transaction validity window");
    if (validity.minEpoch == null || validity.maxEpoch == null || !validity.chain || validity.nonce == null) fail("X402_TRANSACTION_EXPIRY_INVALID", "Sui resolved an incomplete transaction validity window");
    tx.setExpiration({ ValidDuring: { minEpoch: validity.minEpoch, maxEpoch: validity.maxEpoch, minTimestamp: validity.minTimestamp ?? null, maxTimestamp: expiresAt, chain: validity.chain, nonce: validity.nonce } });
    try {
      const probe = await this.client.simulateTransaction({ transaction: tx, include: { effects: true } });
      const simulated = probe.Transaction ?? probe.FailedTransaction;
      if (!simulated?.status.success && timestampExpirationUnsupported(simulated?.status?.error)) tx.setExpiration({ ValidDuring: { minEpoch: validity.minEpoch, maxEpoch: validity.maxEpoch, minTimestamp: validity.minTimestamp ?? null, maxTimestamp: null, chain: validity.chain, nonce: validity.nonce } });
    } catch (error) {
      if (!timestampExpirationUnsupported(error)) throw error;
      tx.setExpiration({ ValidDuring: { minEpoch: validity.minEpoch, maxEpoch: validity.maxEpoch, minTimestamp: validity.minTimestamp ?? null, maxTimestamp: null, chain: validity.chain, nonce: validity.nonce } });
    }
    const legacyIntentHash = hash(JSON.stringify({ domain: "supercuts-x402-v2", operationId, resourceUrl, payTo, asset, amount: amount.toString() }));
    const intentHash = hash(JSON.stringify({ domain: "supercuts-x402-v2", operationId, resourceUrl, payTo, asset, amount: amount.toString(), requestId, requirementsHash: String(extra?.requirementsHash) })), signed = await this.signed(operationId, intentHash, tx, legacyIntentHash);
    const unsignedBinding = { requestId, nonce, requirementsHash: requirementsHash(unsignedRequirements), transactionDigest: signed.digest, payer: this.signer.toSuiAddress() };
    const payerSignature = (await this.signer.signPersonalMessage(paymentBindingBytes(unsignedBinding))).signature;
    const paymentPayload = { x402Version: 2, resource, accepted: requirements, payload: { signature: signed.signature, transaction: Buffer.from(signed.transaction).toString("base64") } };
    const paid = await fetch(paymentUrl, { redirect: "error", headers: { "payment-signature": Buffer.from(JSON.stringify(paymentPayload)).toString("base64"), "x-supercuts-binding": Buffer.from(JSON.stringify({ ...unsignedBinding, payerSignature })).toString("base64") }, signal: AbortSignal.timeout(60_000) });
    const response = Buffer.from(await paid.arrayBuffer()); if (!paid.ok) fail("X402_DELIVERY_FAILED", x402ResourceFailure(paid.status, response));
    const settlementHeader = paid.headers.get("payment-response") ?? fail("X402_SETTLEMENT_INVALID", "payment-response header is missing");
    let settlement: Record<string, unknown>; try { settlement = JSON.parse(Buffer.from(settlementHeader, "base64").toString()) as Record<string, unknown>; } catch (error) { return fail("X402_SETTLEMENT_INVALID", "payment-response is not base64 JSON", error); }
    if (settlement.success !== true || settlement.transaction !== signed.digest || settlement.network !== "sui:testnet") fail("X402_SETTLEMENT_INVALID", "resource reported a different or unsuccessful settlement");
    const finalized = await this.client.waitForTransaction({ digest: signed.digest, timeout: 60_000, include: { effects: true } });
    const checkpoint = assertSuiFinality(finalized, signed.digest); await this.confirmTatum(signed.digest, checkpoint);
    const receipt = { operationId, status: "finalized", rail: "x402", amount: amount.toString(), counterparty: payTo, asset, requestId, requirementsHash: String(extra?.requirementsHash), transactionDigest: signed.digest, policyDecision: "allowed", tatumVerified: true, visibility: "public-transfer", finalized: true, checkpoint, responseSha256: hash(response) };
    this.store.db.prepare("INSERT INTO live_x402_deliveries(operation_id,resource_url,receipt,response,updated_at) VALUES(?,?,?,?,?)").run(operationId, resourceUrl, JSON.stringify(receipt), response, Date.now());
    this.store.db.prepare("UPDATE live_signed_transactions SET status='finalized',updated_at=? WHERE operation_id=?").run(Date.now(), operationId); return { ...receipt, response: response.toString("base64") };
  }
}
