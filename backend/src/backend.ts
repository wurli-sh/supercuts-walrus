import { isValidPersonalMessageSignature } from "@mysten/sui/verify";
import { DeploymentConfig } from "./config.js";
import { PoolEvent, PoolIndex, applyPoolEvent, assertPoolState, createPoolIndex } from "./indexer.js";
import { RelayAdmission, RelayPin, RelayRequest } from "./relayer.js";
import { RoleStore } from "./store.js";
import { MessageEnvelope, validateTranscript } from "./transcript.js";
import { EvidenceReader, PrivateWallet, SettlementExpectation } from "./wallet.js";

/**
 * Role-local façade. Network processes inject transport/proof adapters; this
 * class keeps security-sensitive lifecycle decisions in one reusable backend.
 */
export class SupercutsBackend {
  readonly poolIndex: PoolIndex;
  readonly relay: RelayAdmission;
  readonly wallet: PrivateWallet;
  private readonly pin: RelayPin;
  constructor(config: DeploymentConfig, readonly store: RoleStore) {
    this.poolIndex = createPoolIndex(config.initialRoot.replace(/^0x/, ""), config.deploymentCheckpoint);
    this.pin = { packageId: config.packageId, poolId: config.poolId, coinType: config.coinType, verifierVersion: config.verifierVersion };
    this.relay = new RelayAdmission(
      store,
      this.pin,
      (address, bytes, signature) => isValidPersonalMessageSignature(bytes, signature, { address }),
      // The caller must inject the pinned Groth16 verifier before admitting a
      // live relay request. A missing verifier fails closed.
      async () => false,
    );
    this.wallet = new PrivateWallet(store);
  }
  applyObservedEvents(events: PoolEvent[], poolState: { root: string; nextLeaf: bigint }): void {
    const candidate: PoolIndex = {
      root: this.poolIndex.root, nextLeaf: this.poolIndex.nextLeaf, checkpoint: this.poolIndex.checkpoint,
      spent: new Set(this.poolIndex.spent), deals: new Set(this.poolIndex.deals), acceptedRoots: new Set(this.poolIndex.acceptedRoots),
      ...(this.poolIndex.lastPosition ? { lastPosition: { ...this.poolIndex.lastPosition } } : {}),
    };
    for (const event of [...events].sort((a, b) => {
      if (a.checkpoint !== b.checkpoint) return a.checkpoint < b.checkpoint ? -1 : 1;
      if (a.transactionIndex !== b.transactionIndex) return a.transactionIndex < b.transactionIndex ? -1 : 1;
      return a.eventIndex - b.eventIndex;
    })) applyPoolEvent(candidate, event);
    assertPoolState(candidate, poolState);
    this.poolIndex.root = candidate.root; this.poolIndex.nextLeaf = candidate.nextLeaf; this.poolIndex.checkpoint = candidate.checkpoint;
    this.poolIndex.spent = candidate.spent; this.poolIndex.deals = candidate.deals; this.poolIndex.acceptedRoots = candidate.acceptedRoots;
    if (candidate.lastPosition) this.poolIndex.lastPosition = candidate.lastPosition;
  }
  async verifyTranscript(messages: MessageEnvelope[]): Promise<string> {
    return validateTranscript(messages, (address, bytes, signature) => isValidPersonalMessageSignature(bytes, signature, { address }));
  }
  preparePrivateTransfer(operationId: string, payloadHash: string, inputCommitment: string, expected: SettlementExpectation, proof: Uint8Array): void {
    this.wallet.prepare(operationId, payloadHash, inputCommitment, expected, proof);
  }
  markBroadcast(operationId: string, digest: string): void { this.wallet.recordBroadcast(operationId, digest); }
  reconcilePrivateTransfer(operationId: string, read: EvidenceReader) { return this.wallet.reconcile(operationId, read); }
  async admitRelay(request: RelayRequest, verifyProof: (statement: Uint8Array, proof: Uint8Array) => Promise<boolean>): Promise<void> {
    const admission = new RelayAdmission(this.store, this.pin, (address, bytes, signature) => isValidPersonalMessageSignature(bytes, signature, { address }), verifyProof);
    return admission.admit(request);
  }
}
