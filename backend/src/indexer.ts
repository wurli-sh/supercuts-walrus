import { fail } from "./errors.js";

export type PoolEvent =
  | { kind: "deposit"; checkpoint: bigint; transactionIndex: bigint; eventIndex: number; oldRoot: string; newRoot: string; leafIndex: bigint; noteCommitment: string }
  | { kind: "transfer"; checkpoint: bigint; transactionIndex: bigint; eventIndex: number; oldRoot: string; newRoot: string; firstLeafIndex: bigint; paymentCommitment: string; changeCommitment: string; dealNullifier: string; inputNullifier: string }
  | { kind: "withdraw"; checkpoint: bigint; transactionIndex: bigint; eventIndex: number; root: string; noteNullifier: string; recipient: string; amount: bigint }
  | { kind: "withdraw_v2"; checkpoint: bigint; transactionIndex: bigint; eventIndex: number; oldRoot: string; newRoot: string; leafIndex: bigint; noteNullifier: string; changeCommitment: string; recipient: string; amount: bigint; exactExit: boolean };

export interface PoolIndex {
  root: string; nextLeaf: bigint; spent: Set<string>; deals: Set<string>; checkpoint: bigint;
  acceptedRoots: Set<string>;
  lastPosition?: { checkpoint: bigint; transactionIndex: bigint; eventIndex: number };
}
export function createPoolIndex(root: string, checkpoint: bigint): PoolIndex { return { root, nextLeaf: 0n, spent: new Set(), deals: new Set(), acceptedRoots: new Set([root]), checkpoint }; }

function assertEventOrder(index: PoolIndex, event: PoolEvent): void {
  if (event.checkpoint < index.checkpoint || event.transactionIndex < 0n || !Number.isSafeInteger(event.eventIndex) || event.eventIndex < 0) fail("CHAIN_ORDER_INVALID", "event position is invalid or precedes the deployment anchor");
  const previous = index.lastPosition;
  if (previous) {
    const ordered = event.checkpoint > previous.checkpoint
      || (event.checkpoint === previous.checkpoint && event.transactionIndex > previous.transactionIndex)
      || (event.checkpoint === previous.checkpoint && event.transactionIndex === previous.transactionIndex && event.eventIndex > previous.eventIndex);
    if (!ordered) fail("CHAIN_ORDER_INVALID", "event positions must be unique and strictly increasing");
  }
}

export function applyPoolEvent(index: PoolIndex, event: PoolEvent): void {
  assertEventOrder(index, event);
  if (event.kind === "deposit") {
    if (event.oldRoot !== index.root || event.leafIndex !== index.nextLeaf) fail("POOL_TRANSITION_INVALID", "deposit root or leaf index does not match index");
    index.root = event.newRoot; index.acceptedRoots.add(event.newRoot); index.nextLeaf += 1n;
  } else if (event.kind === "transfer") {
    if (event.oldRoot !== index.root || event.firstLeafIndex !== index.nextLeaf) fail("POOL_TRANSITION_INVALID", "transfer root or leaf index does not match index");
    if (index.spent.has(event.inputNullifier) || index.deals.has(event.dealNullifier)) fail("POOL_REPLAY", "pool event reuses a consumed identity");
    index.root = event.newRoot; index.acceptedRoots.add(event.newRoot); index.nextLeaf += 2n; index.spent.add(event.inputNullifier); index.deals.add(event.dealNullifier);
  } else if (event.kind === "withdraw_v2") {
    if (event.oldRoot !== index.root || event.leafIndex !== index.nextLeaf) fail("POOL_TRANSITION_INVALID", "v2 exit root or leaf index does not match index");
    if (index.spent.has(event.noteNullifier)) fail("POOL_REPLAY", "v2 exit reuses a spent nullifier");
    if (!event.exactExit && event.amount !== 1_000_000n) fail("POOL_TRANSITION_INVALID", "v2 standard exit amount is invalid");
    index.root = event.newRoot; index.acceptedRoots.add(event.newRoot); index.nextLeaf += 1n; index.spent.add(event.noteNullifier);
  } else {
    if (!index.acceptedRoots.has(event.root)) fail("POOL_TRANSITION_INVALID", "withdrawal references a root that was never accepted");
    if (index.spent.has(event.noteNullifier)) fail("POOL_REPLAY", "withdrawal reuses a spent nullifier");
    index.spent.add(event.noteNullifier);
  }
  index.checkpoint = event.checkpoint;
  index.lastPosition = { checkpoint: event.checkpoint, transactionIndex: event.transactionIndex, eventIndex: event.eventIndex };
}

export function assertPoolState(index: PoolIndex, state: { root: string; nextLeaf: bigint }): void {
  if (index.root !== state.root || index.nextLeaf !== state.nextLeaf) fail("POOL_STATE_MISMATCH", "event-derived tree does not match the pool object");
}
