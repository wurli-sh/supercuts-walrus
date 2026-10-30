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
  verifierVersion: number;
}
export interface RelayPin { packageId: string; poolId: string; coinType: string; verifierVersion: number; }
export type ChallengeVerifier = (address: string, challenge: Uint8Array, signature: string) => Promise<boolean>;
export type ProofVerifier = (statement: Uint8Array, proof: Uint8Array) => Promise<boolean>;

export function relayChallenge(request: Omit<RelayRequest, "challengeSignature">): Uint8Array {
  const lengths = Buffer.alloc(8); lengths.writeUInt32BE(request.publicStatement.length); lengths.writeUInt32BE(request.proof.length, 4);
  return Buffer.from(JSON.stringify({
    domain: "supercuts-relay-v1", operationId: request.operationId, expiresAt: request.expiresAt, nonce: request.nonce,
    buyerAddress: request.buyerAddress, packageId: request.packageId, poolId: request.poolId, coinType: request.coinType,
    functionName: request.functionName, verifierVersion: request.verifierVersion,
    payloadHash: createHash("sha256").update(lengths).update(request.publicStatement).update(request.proof).digest("hex"),
  }));
}

export class RelayAdmission {
  constructor(private readonly store: RoleStore, private readonly pin: RelayPin, private readonly verifyChallenge: ChallengeVerifier, private readonly verifyProof: ProofVerifier) {}
  async admit(request: RelayRequest, now = Date.now()): Promise<void> {
    if (!request.operationId || !request.nonce || !request.buyerAddress || request.operationId.length > 256 || request.nonce.length > 256) fail("RELAY_CHALLENGE_INVALID", "relay challenge identity is missing or too long");
    if (!Number.isSafeInteger(request.expiresAt) || request.expiresAt - now > 10 * 60_000) fail("RELAY_CHALLENGE_INVALID", "relay challenge expiry is invalid or too far in the future");
    if (!request.publicStatement.length || request.publicStatement.length > 4096 || !request.proof.length || request.proof.length > 4096) fail("RELAY_PAYLOAD_INVALID", "relay proof or statement size is invalid");
    if (request.expiresAt <= now) fail("RELAY_CHALLENGE_EXPIRED", "relay challenge has expired");
    if (request.packageId !== this.pin.packageId || request.poolId !== this.pin.poolId || request.coinType !== this.pin.coinType || request.verifierVersion !== this.pin.verifierVersion || request.functionName !== "transfer_private") fail("RELAY_TARGET_REJECTED", "relay request does not target the pinned pool function and verifier");
    if (!(await this.verifyChallenge(request.buyerAddress, relayChallenge(request), request.challengeSignature))) fail("RELAY_SIGNATURE_INVALID", "relay challenge signature is invalid");
    if (!(await this.verifyProof(request.publicStatement, request.proof))) fail("RELAY_PROOF_INVALID", "proof does not verify against its public statement");
    if (!this.store.claimOnce("relay-nonce", `${request.buyerAddress}:${request.nonce}`, request.operationId)) fail("RELAY_REPLAY", "relay challenge nonce was already consumed");
  }
}
