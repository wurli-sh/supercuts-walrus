import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { fail } from "./errors.js";

export interface TransferCall {
  packageId: string; poolId: string; coinType: string; expiryMs: bigint; newIndex: bigint;
  dealCommitment: Uint8Array; dealNullifier: Uint8Array; inputNullifier: Uint8Array;
  paymentCommitment: Uint8Array; changeCommitment: Uint8Array; newRoot: Uint8Array; proof: Uint8Array;
}
const bytes = (value: Uint8Array) => Array.from(value);
export function buildPrivateTransfer(call: TransferCall): Transaction {
  for (const [name, value] of Object.entries({ dealCommitment: call.dealCommitment, dealNullifier: call.dealNullifier, inputNullifier: call.inputNullifier, paymentCommitment: call.paymentCommitment, changeCommitment: call.changeCommitment, newRoot: call.newRoot })) {
    if (value.length !== 32) fail("POOL_ARGUMENT_INVALID", `${name} must contain 32 bytes`);
  }
  const tx = new Transaction();
  tx.moveCall({ target: `${call.packageId}::pool::transfer_private`, typeArguments: [call.coinType], arguments: [
    tx.object(call.poolId), tx.object("0x6"), tx.pure.vector("u8", bytes(call.dealCommitment)), tx.pure.vector("u8", bytes(call.dealNullifier)),
    tx.pure.vector("u8", bytes(call.inputNullifier)), tx.pure.vector("u8", bytes(call.paymentCommitment)), tx.pure.vector("u8", bytes(call.changeCommitment)),
    tx.pure.u64(call.expiryMs), tx.pure.vector("u8", bytes(call.newRoot)), tx.pure.u64(call.newIndex), tx.pure.vector("u8", bytes(call.proof)),
  ] });
  return tx;
}
export function writeClient(endpoint: string): SuiGrpcClient { return new SuiGrpcClient({ baseUrl: endpoint, network: "testnet" }); }
