import { SuiGrpcClient } from "@mysten/sui/grpc";
import { fail } from "./errors.js";
import { ProtocolEngine } from "./protocol-engine.js";
import { RoleStore } from "./store.js";

const hexVector = (value: unknown, name: string): string => {
  if (typeof value !== "string") return fail("CHAIN_EVENT_INVALID", `${name} is missing from a pool event`);
  const bytes = /^(?:0x)?[0-9a-f]{64}$/i.test(value) ? Buffer.from(value.replace(/^0x/, ""), "hex") : Buffer.from(value, "base64");
  if (bytes.length !== 32) return fail("CHAIN_EVENT_INVALID", `${name} is not 32 bytes`); return bytes.toString("hex");
};
const integer = (value: unknown, name: string): bigint => { if (typeof value !== "string" && typeof value !== "number") return fail("CHAIN_EVENT_INVALID", `${name} is missing`); try { return BigInt(value); } catch (error) { return fail("CHAIN_EVENT_INVALID", `${name} is invalid`, error); } };
interface IndexedTransaction {
  checkpoint?: string | bigint | null; digest: string; status: { success: boolean };
  transaction?: { sender?: string | null } | null;
  effects?: { changedObjects: Array<{ objectId: string }> } | null;
  events?: Array<{ packageId: string; module: string; eventType: string; json?: Record<string, unknown> | null }> | null;
}
const transaction = (result: unknown): IndexedTransaction => {
  const value = result as { Transaction?: IndexedTransaction; FailedTransaction?: IndexedTransaction };
  return value.Transaction ?? value.FailedTransaction ?? fail("CHAIN_TRANSACTION_INVALID", "transaction response is empty");
};

export interface LiveIndexState { leaves: bigint[]; root: bigint; nextLeaf: bigint; lastCheckpoint: bigint; transactions: string[]; activity?: { deposits: number; exits: number; distinctDepositingAddresses: number; reducedPrivacy: boolean }; }

export class LivePoolIndex {
  constructor(
    private readonly store: RoleStore, private readonly client: SuiGrpcClient,
    private readonly engine: ProtocolEngine, private readonly packageId: string,
    private readonly poolId: string, private readonly deploymentCheckpoint: bigint,
    private readonly moduleName: "pool" | "pool_v2" = "pool",
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS live_pool_leaves (leaf_index TEXT PRIMARY KEY, commitment TEXT NOT NULL, transaction_digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS live_pool_sync (singleton INTEGER PRIMARY KEY CHECK(singleton=1), root TEXT NOT NULL, next_leaf TEXT NOT NULL, checkpoint TEXT NOT NULL, synced_at INTEGER NOT NULL);
    `);
  }
  cached(): LiveIndexState | undefined {
    const sync = this.store.db.prepare("SELECT root,next_leaf,checkpoint FROM live_pool_sync WHERE singleton=1").get() as { root: string; next_leaf: string; checkpoint: string } | undefined;
    if (!sync) return undefined;
    const rows = this.store.db.prepare("SELECT leaf_index,commitment,transaction_digest FROM live_pool_leaves ORDER BY CAST(leaf_index AS INTEGER)").all() as Array<{ leaf_index: string; commitment: string; transaction_digest: string }>;
    const leaves: bigint[] = []; for (const row of rows) { if (BigInt(row.leaf_index) !== BigInt(leaves.length)) fail("POOL_CACHE_INVALID", "cached leaves are not contiguous"); leaves.push(BigInt(`0x${row.commitment}`)); }
    return { leaves, root: BigInt(`0x${sync.root}`), nextLeaf: BigInt(sync.next_leaf), lastCheckpoint: BigInt(sync.checkpoint), transactions: rows.map((row) => row.transaction_digest) };
  }
  async sync(): Promise<LiveIndexState> {
    const leaves: bigint[] = [], transactions: string[] = [], leafTransactions: string[] = [];
    const depositingAddresses = new Set<string>(); let deposits = 0, exits = 0;
    let cursor: string | null = null, checkpoint = this.deploymentCheckpoint, expectedRoot = BigInt(`0x${this.engine.deployment.initialRoot.replace(/^0x/, "")}`), guard = 0;
    do {
      if (++guard > 100_000) fail("CHAIN_PAGINATION_INVALID", "pool history pagination did not terminate");
      const page: Awaited<ReturnType<SuiGrpcClient["listTransactions"]>> = await this.client.listTransactions({ filter: { function: `${this.packageId}::${this.moduleName}` }, limit: 50, after: cursor, order: "ascending", include: { effects: true, events: true, transaction: true } });
      for (const result of page.transactions) {
        const tx = transaction(result); if (!tx.checkpoint || BigInt(tx.checkpoint) < this.deploymentCheckpoint || !tx.status.success) continue;
        if (!tx.effects?.changedObjects.some((object) => object.objectId.toLowerCase() === this.poolId.toLowerCase())) continue;
        let touched = false;
        for (const event of tx.events ?? []) {
          if (event.packageId.toLowerCase() !== this.packageId.toLowerCase() || event.module !== this.moduleName || !event.json) continue;
          const value = event.json, name = event.eventType.split("::").pop();
          if (name === "DepositEvent") {
            const oldRoot = BigInt(`0x${hexVector(value.old_root, "old_root")}`), leafIndex = integer(value.leaf_index, "leaf_index"); if (oldRoot !== expectedRoot || leafIndex !== BigInt(leaves.length)) fail("POOL_TRANSITION_INVALID", "deposit event does not continue the pinned pool history");
            deposits++; if (tx.transaction?.sender) depositingAddresses.add(tx.transaction.sender.toLowerCase());
            leaves.push(BigInt(`0x${hexVector(value.note_commitment, "note_commitment")}`)); leafTransactions.push(tx.digest); expectedRoot = BigInt(`0x${hexVector(value.new_root, "new_root")}`); touched = true;
          } else if (name === "TransferEvent") {
            const oldRoot = BigInt(`0x${hexVector(value.old_root, "old_root")}`), first = integer(value.first_leaf_index, "first_leaf_index"); if (oldRoot !== expectedRoot || first !== BigInt(leaves.length)) fail("POOL_TRANSITION_INVALID", "transfer event does not continue the pinned pool history");
            leaves.push(BigInt(`0x${hexVector(value.payment_commitment, "payment_commitment")}`), BigInt(`0x${hexVector(value.change_commitment, "change_commitment")}`)); leafTransactions.push(tx.digest, tx.digest); expectedRoot = BigInt(`0x${hexVector(value.new_root, "new_root")}`); touched = true;
          } else if (name === "WithdrawEvent" && this.moduleName === "pool_v2") {
            exits++;
            const oldRoot = BigInt(`0x${hexVector(value.old_root, "old_root")}`), leafIndex = integer(value.leaf_index, "leaf_index");
            if (oldRoot !== expectedRoot || leafIndex !== BigInt(leaves.length)) fail("POOL_TRANSITION_INVALID", "v2 withdrawal event does not continue the pinned pool history");
            leaves.push(BigInt(`0x${hexVector(value.change_commitment, "change_commitment")}`));
            leafTransactions.push(tx.digest);
            expectedRoot = BigInt(`0x${hexVector(value.new_root, "new_root")}`);
            touched = true;
          } else if (name === "WithdrawEvent") { exits++; touched = true; }
        }
        if (touched) { checkpoint = BigInt(tx.checkpoint); transactions.push(tx.digest); }
      }
      cursor = page.hasNextPage ? page.endCursor : null; if (page.hasNextPage && !cursor) fail("CHAIN_PAGINATION_INVALID", "pool history has another page without a cursor");
    } while (cursor);
    const computed = this.engine.tree(leaves).root; if (computed !== expectedRoot) fail("POOL_STATE_MISMATCH", "event leaves do not reproduce the event root");
    const object = (await this.client.getObject({ objectId: this.poolId, include: { json: true } })).object; const state = object.json;
    if (!state || typeof state !== "object") fail("POOL_STATE_MISMATCH", "pool object has no JSON state");
    const poolState = state as Record<string, unknown>;
    const chainRoot = BigInt(`0x${hexVector(poolState.root, "pool.root")}`), chainIndex = integer(poolState.next_leaf, "pool.next_leaf");
    if (chainRoot !== computed || chainIndex !== BigInt(leaves.length)) fail("POOL_STATE_MISMATCH", "event-derived tree differs from the live pool object");
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db.exec("DELETE FROM live_pool_leaves"); const insert = this.store.db.prepare("INSERT INTO live_pool_leaves(leaf_index,commitment,transaction_digest) VALUES(?,?,?)");
      leaves.forEach((leaf, index) => insert.run(String(index), leaf.toString(16).padStart(64, "0"), leafTransactions[index] ?? "deployment"));
      this.store.db.prepare("INSERT INTO live_pool_sync(singleton,root,next_leaf,checkpoint,synced_at) VALUES(1,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET root=excluded.root,next_leaf=excluded.next_leaf,checkpoint=excluded.checkpoint,synced_at=excluded.synced_at").run(computed.toString(16).padStart(64, "0"), String(leaves.length), String(checkpoint), Date.now());
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
    return { leaves, root: computed, nextLeaf: BigInt(leaves.length), lastCheckpoint: checkpoint, transactions,
      activity: { deposits, exits, distinctDepositingAddresses: depositingAddresses.size, reducedPrivacy: depositingAddresses.size < 5 } };
  }
}
