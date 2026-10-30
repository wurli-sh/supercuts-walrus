import { isValidPersonalMessageSignature } from "@mysten/sui/verify";
import { DeploymentConfig } from "./config.js";
import { PoolEvent, PoolIndex, applyPoolEvent, assertPoolState, createPoolIndex } from "./indexer.js";
import { RelayAdmission, RelayPin, RelayRequest } from "./relayer.js";
import { RoleStore } from "./store.js";
import { MessageEnvelope, validateTranscript } from "./transcript.js";

/**
 * Role-local façade. Network processes inject transport/proof adapters; this
 * class keeps security-sensitive lifecycle decisions in one reusable backend.
 */
export class SupercutsBackend {
  readonly poolIndex: PoolIndex;
  readonly relay: RelayAdmission;
  constructor(readonly config: DeploymentConfig, readonly store: RoleStore) {
    this.poolIndex = createPoolIndex(config.initialRoot.replace(/^0x/, ""), config.deploymentCheckpoint);
    const pin: RelayPin = { packageId: config.packageId, poolId: config.poolId, coinType: config.coinType, verifierVersion: config.verifierVersion };
    this.relay = new RelayAdmission(
      store,
      pin,
      (address, bytes, signature) => isValidPersonalMessageSignature(bytes, signature, { address }),
      // The caller must inject the pinned Groth16 verifier before admitting a
      // live relay request. A missing verifier fails closed.
      async () => false,
    );
  }
  applyObservedEvents(events: PoolEvent[], poolState: { root: string; nextLeaf: bigint }): void {
    for (const event of [...events].sort((a, b) => {
      if (a.checkpoint !== b.checkpoint) return a.checkpoint < b.checkpoint ? -1 : 1;
      if (a.transactionIndex !== b.transactionIndex) return a.transactionIndex < b.transactionIndex ? -1 : 1;
      return a.eventIndex - b.eventIndex;
    })) applyPoolEvent(this.poolIndex, event);
    assertPoolState(this.poolIndex, poolState);
  }
  async verifyTranscript(messages: MessageEnvelope[]): Promise<string> {
    return validateTranscript(messages, (address, bytes, signature) => isValidPersonalMessageSignature(bytes, signature, { address }));
  }
  reserveInput(operationId: string, payloadHash: string, noteCommitment: string): void {
    this.store.beginOperation(operationId, payloadHash);
    this.store.reserveNote(noteCommitment, operationId);
  }
  persistProof(operationId: string, proof: Uint8Array): void {
    this.store.putSecret(`proof:${operationId}`, proof);
    this.store.transitionOperation(operationId, "proof_persisted");
  }
  markBroadcast(operationId: string, digest: string): void { this.store.transitionOperation(operationId, "broadcast", digest); }
  markFinalized(operationId: string, digest: string): void { this.store.transitionOperation(operationId, "finalized", digest); }
  markUnresolved(operationId: string): void { this.store.transitionOperation(operationId, "unresolved"); }
  async admitRelay(request: RelayRequest, verifyProof: (statement: Uint8Array, proof: Uint8Array) => Promise<boolean>): Promise<void> {
    const pin: RelayPin = { packageId: this.config.packageId, poolId: this.config.poolId, coinType: this.config.coinType, verifierVersion: this.config.verifierVersion };
    const admission = new RelayAdmission(this.store, pin, (address, bytes, signature) => isValidPersonalMessageSignature(bytes, signature, { address }), verifyProof);
    return admission.admit(request);
  }
}
