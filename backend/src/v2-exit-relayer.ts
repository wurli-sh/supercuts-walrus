import { createHash } from "node:crypto";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fail } from "./errors.js";
import type { RoleStore } from "./store.js";
import { buildWithdrawV2, type WithdrawV2Call, writeClient } from "./sui.js";
import { TatumLedger } from "./tatum.js";

export interface V2RelayerPin {
  packageId: string; poolId: string; coinType: string; relayerAddress: string; writeGrpcEndpoint: string; tatumGrpcEndpoint: string;
}
export interface V2ExitRequest extends Omit<WithdrawV2Call, "packageId" | "poolId" | "coinType"> { operationId: string; }

/** Runs in a separate, funded relayer home. It never receives a note opening. */
export class V2ExitRelayer {
  private readonly client;
  private readonly signer: Ed25519Keypair;
  private readonly tatum: TatumLedger;
  constructor(private readonly store: RoleStore, private readonly pin: V2RelayerPin) {
    const encoded = store.getSecret("live:relayer-sui-private-key")?.toString() ?? fail("RELAYER_CREDENTIAL_MISSING", "separate relayer signer is missing");
    const decoded = decodeSuiPrivateKey(encoded);
    if (decoded.scheme !== "ED25519") fail("SIGNER_UNSUPPORTED", "relayer signer must use ED25519");
    this.signer = Ed25519Keypair.fromSecretKey(decoded.secretKey);
    if (this.signer.toSuiAddress().toLowerCase() !== pin.relayerAddress.toLowerCase()) fail("RELAYER_SIGNER_MISMATCH", "relayer signer differs from the pinned funded address");
    this.client = writeClient(pin.writeGrpcEndpoint);
    const tatumKey = store.getSecret("live:tatum-api-key")?.toString() ?? fail("RELAYER_CREDENTIAL_MISSING", "relayer Tatum read credential is missing");
    this.tatum = new TatumLedger(pin.tatumGrpcEndpoint, tatumKey);
    store.db.exec(`CREATE TABLE IF NOT EXISTS v2_relay_journal (
      operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, note_nullifier TEXT NOT NULL UNIQUE,
      transaction_bytes BLOB NOT NULL, signature TEXT NOT NULL, digest TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL, updated_at INTEGER NOT NULL
    )`);
  }

  async doctor(): Promise<{ relayer: string; gasBalanceMist: string; funded: true }> {
    const { balance } = await this.client.getBalance({ owner: this.signer.toSuiAddress(), coinType: "0x2::sui::SUI" });
    const available = BigInt(balance.balance);
    if (available < 10_000_000n) fail("RELAYER_GAS_INSUFFICIENT", "separate Testnet relayer needs at least 10,000,000 MIST for the live exit gate");
    return { relayer: this.signer.toSuiAddress(), gasBalanceMist: available.toString(), funded: true };
  }

  async submit(request: V2ExitRequest): Promise<{ digest: string; checkpoint: string; relayer: string; resumed: boolean; tatumVerified: true }> {
    if (!request.operationId || request.operationId.length > 256) fail("RELAY_REQUEST_INVALID", "operation ID is invalid");
    const normalized = {
      operationId: request.operationId, root: Buffer.from(request.root).toString("hex"),
      noteNullifier: Buffer.from(request.noteNullifier).toString("hex"), recipient: request.recipient.toLowerCase(),
      amount: request.amount.toString(), exactExit: request.exactExit,
      changeCommitment: Buffer.from(request.changeCommitment).toString("hex"),
      newRoot: Buffer.from(request.newRoot).toString("hex"), newIndex: request.newIndex.toString(),
      proofHash: createHash("sha256").update(request.proof).digest("hex"),
    };
    const requestHash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    const existing = this.store.db.prepare("SELECT request_hash,transaction_bytes,signature,digest FROM v2_relay_journal WHERE operation_id=?").get(request.operationId) as { request_hash: string; transaction_bytes: Buffer; signature: string; digest: string } | undefined;
    if (existing && existing.request_hash !== requestHash) fail("OPERATION_ID_CONFLICT", "relayer operation ID identifies another proof or payout");
    let signed: { transaction: Uint8Array; signature: string; digest: string };
    if (existing) signed = { transaction: existing.transaction_bytes, signature: existing.signature, digest: existing.digest };
    else {
      await this.doctor();
      const tx = buildWithdrawV2({ ...request, packageId: this.pin.packageId, poolId: this.pin.poolId, coinType: this.pin.coinType });
      tx.setSender(this.signer.toSuiAddress());
      const simulation = await this.client.simulateTransaction({ transaction: tx, include: { effects: true } });
      if (!(simulation.Transaction ?? simulation.FailedTransaction)?.status.success) fail("RELAY_SIMULATION_FAILED", "v2 withdrawal proof or current root was rejected");
      const transaction = await tx.build({ client: this.client });
      const digest = await tx.getDigest({ client: this.client });
      const signature = (await this.signer.signTransaction(transaction)).signature;
      try {
        this.store.db.prepare("INSERT INTO v2_relay_journal(operation_id,request_hash,note_nullifier,transaction_bytes,signature,digest,status,updated_at) VALUES(?,?,?,?,?,?,'signed',?)")
          .run(request.operationId, requestHash, normalized.noteNullifier, Buffer.from(transaction), signature, digest, Date.now());
      } catch (error) { fail("RELAY_REPLAY", "nullifier or operation has already been submitted through this relayer", error); }
      signed = { transaction, signature, digest };
    }
    try { await this.client.executeTransaction({ transaction: signed.transaction, signatures: [signed.signature], include: { effects: true } }); }
    catch {
      // An ambiguous broadcast is resolved by the digest. The exact signed
      // bytes remain journaled, so a retry cannot change the payout.
    }
    let finalized;
    try { finalized = await this.client.waitForTransaction({ digest: signed.digest, timeout: 60_000, include: { effects: true } }); }
    catch (error) { return fail("RELAY_BROADCAST_UNRESOLVED", "relayer transaction outcome is unresolved; retry the same operation ID", error); }
    const tx = finalized.Transaction ?? finalized.FailedTransaction;
    if (!tx?.status.success || !tx.checkpoint) fail("RELAY_FINALITY_FAILED", "v2 exit transaction did not finalize successfully");
    await this.tatum.getTransaction(signed.digest);
    this.store.db.prepare("UPDATE v2_relay_journal SET status='finalized',updated_at=? WHERE operation_id=?").run(Date.now(), request.operationId);
    return { digest: signed.digest, checkpoint: String(tx.checkpoint), relayer: this.signer.toSuiAddress(), resumed: Boolean(existing), tatumVerified: true };
  }
}
