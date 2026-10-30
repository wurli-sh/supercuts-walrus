import { createHash } from "node:crypto";
import { RoleStore } from "./store.js";
import { fail } from "./errors.js";

export interface RelayRequest {
  operationId: string;
  expiresAt: number;
  nonce: string;
  buyerAddress: string;
  challengeSignature: string;
  packageId: string;
  poolId: string;
  coinType: string;
  functionName: "transfer_private";
  publicStatement: Uint8Array;
  proof: Uint8Array;
}
export interface RelayPin { packageId: string; poolId: string; coinType: string; verifierVersion: number; }
export type ChallengeVerifier = (address: string, challenge: Uint8Array, signature: string) => Promise<boolean>;
export type ProofVerifier = (statement: Uint8Array, proof: Uint8Array) => Promise<boolean>;

export function relayChallenge(request: Omit<RelayRequest, "challengeSignature">): Uint8Array {
  return Buffer.from(JSON.stringify({
    domain: "supercuts-relay-v1", operationId: request.operationId, expiresAt: request.expiresAt, nonce: request.nonce,
    payloadHash: createHash("sha256").update(request.publicStatement).update(request.proof).digest("hex"),
  }));
}

export class RelayAdmission {
  constructor(private readonly store: RoleStore, private readonly pin: RelayPin, private readonly verifyChallenge: ChallengeVerifier, private readonly verifyProof: ProofVerifier) {}
  async admit(request: RelayRequest, now = Date.now()): Promise<void> {
    if (request.expiresAt <= now) fail("RELAY_CHALLENGE_EXPIRED", "relay challenge has expired");
    if (request.packageId !== this.pin.packageId || request.poolId !== this.pin.poolId || request.coinType !== this.pin.coinType || request.functionName !== "transfer_private") fail("RELAY_TARGET_REJECTED", "relay request does not target the pinned pool function");
    if (!(await this.verifyChallenge(request.buyerAddress, relayChallenge(request), request.challengeSignature))) fail("RELAY_SIGNATURE_INVALID", "relay challenge signature is invalid");
    if (!(await this.verifyProof(request.publicStatement, request.proof))) fail("RELAY_PROOF_INVALID", "proof does not verify against its public statement");
    if (!this.store.claimOnce("relay-nonce", `${request.buyerAddress}:${request.nonce}`, request.operationId)) fail("RELAY_REPLAY", "relay challenge nonce was already consumed");
  }
}
