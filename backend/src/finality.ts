import { fail } from "./errors.js";

interface ChainTransaction {
  digest?: string;
  checkpoint?: string | number | bigint | { sequenceNumber?: string | number | bigint } | null;
  status?: { success?: boolean };
  effects?: { transactionDigest?: string; status?: { success?: boolean } };
}

function checkpoint(value: ChainTransaction["checkpoint"]): string | undefined {
  const raw = value && typeof value === "object" ? value.sequenceNumber : value;
  if (raw === undefined || raw === null) return undefined;
  try {
    const parsed = BigInt(raw);
    return parsed >= 0n ? parsed.toString() : undefined;
  } catch { return undefined; }
}

export function assertSuiFinality(result: unknown, digest: string): string {
  const envelope = result as { Transaction?: ChainTransaction; FailedTransaction?: ChainTransaction } | null;
  const tx = envelope?.Transaction ?? envelope?.FailedTransaction;
  const observed = tx?.digest ?? tx?.effects?.transactionDigest;
  const sequence = checkpoint(tx?.checkpoint);
  if (!tx || observed !== digest || tx.effects?.transactionDigest && tx.effects.transactionDigest !== digest || tx.status?.success !== true || !sequence) return fail("TRANSACTION_FINALITY_FAILED", "Sui did not confirm the journaled successful transaction at a checkpoint");
  return sequence;
}

export function assertTatumFinality(result: unknown, digest: string, expectedCheckpoint: string): void {
  const tx = (result as { transaction?: ChainTransaction } | null)?.transaction;
  if (tx?.digest !== digest || checkpoint(tx.checkpoint) !== expectedCheckpoint || tx.effects?.status?.success !== true) fail("TATUM_TRANSACTION_MISMATCH", "Tatum did not confirm the same successful finalized transaction");
}
