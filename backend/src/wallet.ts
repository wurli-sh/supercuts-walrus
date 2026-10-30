import { fail } from "./errors.js";
import { PoolEvent } from "./indexer.js";
import { RoleStore, StoredOperation } from "./store.js";
import { encodeNoteOpening, NoteOpening, noteCommitment } from "./notes.js";

export interface SettlementEvidence {
  digest: string; finalized: boolean; successful: boolean; packageId: string; poolId: string; coinType: string; events: PoolEvent[];
}
export type EvidenceReader = (digest: string) => Promise<SettlementEvidence | undefined>;
export interface SettlementExpectation { packageId: string; poolId: string; coinType: string; inputNullifier: string; dealNullifier: string; paymentCommitment: string; changeCommitment: string; }

function encodeExpectation(expected: SettlementExpectation): Buffer {
  const entries = Object.entries(expected);
  if (entries.some(([, value]) => !value || typeof value !== "string" || value.length > 512)) fail("SETTLEMENT_EXPECTATION_INVALID", "settlement expectation is incomplete or too large");
  return Buffer.from(JSON.stringify(Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)))));
}

function rejectEvidence(store: RoleStore, operationId: string, code: string, message: string): never {
  const status = store.getOperation(operationId)?.status;
  if (status && status !== "unresolved" && status !== "finalized" && status !== "confirmed" && status !== "delivered") store.transitionOperation(operationId, "unresolved");
  return fail(code, message);
}

export class PrivateWallet {
  constructor(private readonly store: RoleStore) {}

  prepare(operationId: string, payloadHash: string, inputCommitment: string, expected: SettlementExpectation, proof: Uint8Array): void {
    this.store.beginOperation(operationId, payloadHash);
    this.store.reserveNote(inputCommitment, operationId);
    this.store.putSecretOnce(`settlement:${operationId}`, encodeExpectation(expected));
    this.store.putNote(inputCommitment, "input", operationId, undefined, expected.inputNullifier);
    const operation = this.store.getOperation(operationId)!;
    if (operation.status === "reserved") {
      this.store.putSecretOnce(`proof:${operationId}`, proof);
      this.store.transitionOperation(operationId, "proof_persisted");
    } else if (!this.store.getSecret(`proof:${operationId}`)?.equals(Buffer.from(proof))) {
      fail("PROOF_RETRY_CONFLICT", "retry proof differs from the persisted proof");
    }
  }

  recordBroadcast(operationId: string, digest: string): void {
    const operation = this.store.getOperation(operationId) ?? fail("OPERATION_NOT_FOUND", `operation ${operationId} does not exist`);
    if (operation.txDigest && operation.txDigest !== digest) fail("OPERATION_DIGEST_CONFLICT", "operation cannot be rebound to another transaction");
    if (operation.status === "proof_persisted" || (operation.status === "unresolved" && this.store.getSecret(`proof:${operationId}`))) this.store.transitionOperation(operationId, "broadcast", digest);
    else if (operation.status !== "broadcast" && operation.status !== "finalized" && operation.status !== "confirmed" && operation.status !== "delivered") fail("OPERATION_NOT_READY", "proof must be persisted before broadcast");
  }

  async reconcile(operationId: string, read: EvidenceReader): Promise<StoredOperation> {
    const operation = this.store.getOperation(operationId) ?? fail("OPERATION_NOT_FOUND", `operation ${operationId} does not exist`);
    const encodedExpectation = this.store.getSecret(`settlement:${operationId}`) ?? fail("SETTLEMENT_EXPECTATION_MISSING", "operation has no persisted settlement expectation");
    let expected: SettlementExpectation;
    try { expected = JSON.parse(encodedExpectation.toString()) as SettlementExpectation; } catch (error) { return fail("SETTLEMENT_EXPECTATION_INVALID", "persisted settlement expectation is invalid", error); }
    if (!operation.txDigest) return operation;
    const evidence = await read(operation.txDigest);
    if (!evidence || !evidence.finalized) {
      if (operation.status !== "unresolved") this.store.transitionOperation(operationId, "unresolved");
      return this.store.getOperation(operationId)!;
    }
    if (evidence.digest !== operation.txDigest) rejectEvidence(this.store, operationId, "SETTLEMENT_DIGEST_MISMATCH", "evidence reader returned another transaction");
    if (!evidence.successful) rejectEvidence(this.store, operationId, "SETTLEMENT_FAILED", "finalized transaction did not execute successfully");
    if (evidence.packageId !== expected.packageId || evidence.poolId !== expected.poolId || evidence.coinType !== expected.coinType) rejectEvidence(this.store, operationId, "SETTLEMENT_TARGET_MISMATCH", "transaction does not settle against the pinned pool and asset");
    const transfer = evidence.events.find((event): event is Extract<PoolEvent, { kind: "transfer" }> => event.kind === "transfer" && event.inputNullifier === expected.inputNullifier && event.dealNullifier === expected.dealNullifier && event.paymentCommitment === expected.paymentCommitment && event.changeCommitment === expected.changeCommitment);
    if (!transfer) rejectEvidence(this.store, operationId, "SETTLEMENT_EVENT_MISSING", "finalized transaction does not contain the expected transfer");
    if (operation.status === "broadcast" || operation.status === "unresolved") this.store.transitionOperation(operationId, "finalized", evidence.digest);
    this.store.markNoteSpent(expected.inputNullifier);
    return this.store.getOperation(operationId)!;
  }

  async recoverOutput(operationId: string, role: "payment" | "change", opening: NoteOpening, event: Extract<PoolEvent, { kind: "transfer" }>): Promise<string> {
    const operation = this.store.getOperation(operationId) ?? fail("OPERATION_NOT_FOUND", `operation ${operationId} does not exist`);
    if (!["finalized", "confirmed", "delivered"].includes(operation.status)) fail("NOTE_RECOVERY_NOT_FINAL", "output notes can only be recovered from a finalized operation");
    const expected = JSON.parse((this.store.getSecret(`settlement:${operationId}`) ?? fail("SETTLEMENT_EXPECTATION_MISSING", "operation has no persisted settlement expectation")).toString()) as SettlementExpectation;
    if (event.inputNullifier !== expected.inputNullifier || event.dealNullifier !== expected.dealNullifier || event.paymentCommitment !== expected.paymentCommitment || event.changeCommitment !== expected.changeCommitment) fail("NOTE_RECOVERY_EVENT_MISMATCH", "recovery event does not match the persisted settlement");
    const commitment = await noteCommitment(opening);
    const expectedCommitment = role === "payment" ? event.paymentCommitment : event.changeCommitment;
    if (commitment !== expectedCommitment) fail("NOTE_RECOVERY_MISMATCH", `${role} opening does not match the finalized commitment`);
    this.store.putSecretOnce(`note:${commitment}`, encodeNoteOpening(opening));
    this.store.putNote(commitment, role, operationId, event.firstLeafIndex + (role === "change" ? 1n : 0n));
    return commitment;
  }
}
