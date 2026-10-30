import { fail } from "./errors.js";

export type PoolEvent =
  | { kind: "deposit"; checkpoint: bigint; transactionIndex: bigint; eventIndex: number; oldRoot: string; newRoot: string; leafIndex: bigint; noteCommitment: string }
  | { kind: "transfer"; checkpoint: bigint; transactionIndex: bigint; eventIndex: number; oldRoot: string; newRoot: string; firstLeafIndex: bigint; paymentCommitment: string; changeCommitment: string; dealNullifier: string; inputNullifier: string }
  | { kind: "withdraw"; checkpoint: bigint; transactionIndex: bigint; eventIndex: number; root: string; noteNullifier: string; recipient: string; amount: bigint };

export interface PoolIndex { root: string; nextLeaf: bigint; spent: Set<string>; deals: Set<string>; checkpoint: bigint; }
export function createPoolIndex(root: string, checkpoint: bigint): PoolIndex { return { root, nextLeaf: 0n, spent: new Set(), deals: new Set(), checkpoint }; }

export function applyPoolEvent(index: PoolIndex, event: PoolEvent): void {
  if (event.checkpoint < index.checkpoint) fail("CHAIN_ORDER_INVALID", "event precedes indexed checkpoint");
  if (event.kind === "deposit") {
    if (event.oldRoot !== index.root || event.leafIndex !== index.nextLeaf) fail("POOL_TRANSITION_INVALID", "deposit root or leaf index does not match index");
    index.root = event.newRoot; index.nextLeaf += 1n;
  } else if (event.kind === "transfer") {
    if (event.oldRoot !== index.root || event.firstLeafIndex !== index.nextLeaf) fail("POOL_TRANSITION_INVALID", "transfer root or leaf index does not match index");
    if (index.spent.has(event.inputNullifier) || index.deals.has(event.dealNullifier)) fail("POOL_REPLAY", "pool event reuses a consumed identity");
    index.root = event.newRoot; index.nextLeaf += 2n; index.spent.add(event.inputNullifier); index.deals.add(event.dealNullifier);
  } else {
    if (!index.spent.add(event.noteNullifier)) fail("POOL_REPLAY", "withdrawal reuses a spent nullifier");
  }
  index.checkpoint = event.checkpoint;
}

export function assertPoolState(index: PoolIndex, state: { root: string; nextLeaf: bigint }): void {
  if (index.root !== state.root || index.nextLeaf !== state.nextLeaf) fail("POOL_STATE_MISMATCH", "event-derived tree does not match the pool object");
}
