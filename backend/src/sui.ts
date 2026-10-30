import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { fail } from "./errors.js";

export interface TransferCall {
  packageId: string; poolId: string; coinType: string; expiryMs: bigint; newIndex: bigint;
  dealCommitment: Uint8Array; dealNullifier: Uint8Array; inputNullifier: Uint8Array;
  paymentCommitment: Uint8Array; changeCommitment: Uint8Array; newRoot: Uint8Array; proof: Uint8Array;
}
export interface DepositCall {
  packageId: string; poolId: string; coinType: string; amount: bigint; newIndex: bigint;
  noteCommitment: Uint8Array; newRoot: Uint8Array; proof: Uint8Array;
}
export interface WithdrawCall {
  packageId: string; poolId: string; coinType: string; amount: bigint; recipient: string;
  root: Uint8Array; noteNullifier: Uint8Array; proof: Uint8Array;
}
const bytes = (value: Uint8Array) => Array.from(value);
const validateCommon = (call: { packageId: string; poolId: string; coinType: string; proof: Uint8Array }): void => {
  if (!/^0x[0-9a-f]{64}$/i.test(call.packageId) || !/^0x[0-9a-f]{64}$/i.test(call.poolId) || !/^[^\s:]+(?:::[^\s:]+){2}(?:<.*>)?$/.test(call.coinType)) fail("POOL_ARGUMENT_INVALID", "package, pool, or coin type is invalid");
  if (!call.proof.length || call.proof.length > 4096) fail("POOL_ARGUMENT_INVALID", "proof length is invalid");
};
const validateU64 = (value: bigint, name: string, positive = false): void => {
  if (value < (positive ? 1n : 0n) || value > (1n << 64n) - 1n) fail("POOL_ARGUMENT_INVALID", `${name} must be ${positive ? "a positive " : "an "}u64 value`);
};
const validate32 = (values: Record<string, Uint8Array>): void => {
  for (const [name, value] of Object.entries(values)) if (value.length !== 32) fail("POOL_ARGUMENT_INVALID", `${name} must contain 32 bytes`);
};

export function buildDeposit(call: DepositCall): Transaction {
  validateCommon(call); validateU64(call.amount, "amount", true); validateU64(call.newIndex, "new index");
  validate32({ noteCommitment: call.noteCommitment, newRoot: call.newRoot });
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(call.amount)]);
  tx.moveCall({ target: `${call.packageId}::pool::deposit`, typeArguments: [call.coinType], arguments: [
    tx.object(call.poolId), coin!, tx.pure.vector("u8", bytes(call.noteCommitment)), tx.pure.vector("u8", bytes(call.newRoot)),
    tx.pure.u64(call.newIndex), tx.pure.vector("u8", bytes(call.proof)),
  ] });
  return tx;
}

export function buildPrivateTransfer(call: TransferCall): Transaction {
  validateCommon(call); validateU64(call.expiryMs, "expiry"); validateU64(call.newIndex, "new index");
  validate32({ dealCommitment: call.dealCommitment, dealNullifier: call.dealNullifier, inputNullifier: call.inputNullifier, paymentCommitment: call.paymentCommitment, changeCommitment: call.changeCommitment, newRoot: call.newRoot });
  const tx = new Transaction();
  tx.moveCall({ target: `${call.packageId}::pool::transfer_private`, typeArguments: [call.coinType], arguments: [
    tx.object(call.poolId), tx.object("0x6"), tx.pure.vector("u8", bytes(call.dealCommitment)), tx.pure.vector("u8", bytes(call.dealNullifier)),
    tx.pure.vector("u8", bytes(call.inputNullifier)), tx.pure.vector("u8", bytes(call.paymentCommitment)), tx.pure.vector("u8", bytes(call.changeCommitment)),
    tx.pure.u64(call.expiryMs), tx.pure.vector("u8", bytes(call.newRoot)), tx.pure.u64(call.newIndex), tx.pure.vector("u8", bytes(call.proof)),
  ] });
  return tx;
}

export function buildWithdraw(call: WithdrawCall): Transaction {
  validateCommon(call); validateU64(call.amount, "amount", true);
  if (!/^0x[0-9a-f]{64}$/i.test(call.recipient)) fail("POOL_ARGUMENT_INVALID", "recipient must be a 32-byte Sui address");
  validate32({ root: call.root, noteNullifier: call.noteNullifier });
  const tx = new Transaction();
  tx.moveCall({ target: `${call.packageId}::pool::withdraw`, typeArguments: [call.coinType], arguments: [
    tx.object(call.poolId), tx.pure.vector("u8", bytes(call.root)), tx.pure.vector("u8", bytes(call.noteNullifier)),
    tx.pure.address(call.recipient), tx.pure.u64(call.amount), tx.pure.vector("u8", bytes(call.proof)),
  ] });
  return tx;
}
export function writeClient(endpoint: string): SuiGrpcClient { return new SuiGrpcClient({ baseUrl: endpoint, network: "testnet" }); }
