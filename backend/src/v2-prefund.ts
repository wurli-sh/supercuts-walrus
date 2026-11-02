import { fail } from "./errors.js";
import type { RoleStore } from "./store.js";

export interface PrefundPlan { operationId: string; amount: bigint; scheduledAt: number; status: "queued" | "finalized"; transactionDigest?: string; }

/** Buyer-side scheduling; the callback must be the live, finalized deposit path. */
export class V2PrefundQueue {
  constructor(private readonly store: RoleStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS v2_prefund_queue (
      operation_id TEXT PRIMARY KEY, amount TEXT NOT NULL, scheduled_at INTEGER NOT NULL,
      status TEXT NOT NULL, transaction_digest TEXT UNIQUE
    )`);
  }

  queue(operationId: string, amount: bigint, scheduledAt: number, approved: boolean, now = Date.now()): PrefundPlan {
    if (!approved) fail("OWNER_APPROVAL_REQUIRED", "owner approval is required to schedule prefunding");
    if (!operationId || operationId.length > 256 || (amount !== 10_000_000n && amount !== 100_000_000n) || !Number.isSafeInteger(scheduledAt) || scheduledAt < now) fail("PREFUND_PLAN_INVALID", "v2 prefunding needs a standard amount and future time");
    const prior = this.get(operationId);
    if (prior) {
      if (prior.amount !== amount || prior.scheduledAt !== scheduledAt) fail("OPERATION_ID_CONFLICT", "prefunding operation ID identifies another plan");
      return prior;
    }
    this.store.db.prepare("INSERT INTO v2_prefund_queue(operation_id,amount,scheduled_at,status) VALUES(?,?,?,'queued')").run(operationId, amount.toString(), scheduledAt);
    return this.get(operationId)!;
  }

  get(operationId: string): PrefundPlan | undefined {
    const row = this.store.db.prepare("SELECT operation_id,amount,scheduled_at,status,transaction_digest FROM v2_prefund_queue WHERE operation_id=?").get(operationId) as { operation_id: string; amount: string; scheduled_at: number; status: PrefundPlan["status"]; transaction_digest: string | null } | undefined;
    return row && { operationId: row.operation_id, amount: BigInt(row.amount), scheduledAt: row.scheduled_at, status: row.status, ...(row.transaction_digest ? { transactionDigest: row.transaction_digest } : {}) };
  }

  async runDue(now: number, deposit: (amount: bigint, operationId: string) => Promise<{ transactionDigest: string; finalized: boolean }>): Promise<PrefundPlan[]> {
    const rows = this.store.db.prepare("SELECT operation_id FROM v2_prefund_queue WHERE status='queued' AND scheduled_at<=? ORDER BY scheduled_at").all(now) as Array<{ operation_id: string }>;
    const finalized: PrefundPlan[] = [];
    for (const row of rows) {
      const plan = this.get(row.operation_id)!;
      const receipt = await deposit(plan.amount, plan.operationId);
      if (!receipt.finalized || !receipt.transactionDigest) fail("PREFUND_NOT_FINAL", "prefunding callback did not return a finalized live deposit");
      this.store.db.prepare("UPDATE v2_prefund_queue SET status='finalized',transaction_digest=? WHERE operation_id=? AND status='queued'").run(receipt.transactionDigest, plan.operationId);
      finalized.push(this.get(plan.operationId)!);
    }
    return finalized;
  }
}
