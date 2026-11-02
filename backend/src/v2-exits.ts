import { randomInt } from "node:crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fail } from "./errors.js";
import type { RoleStore } from "./store.js";

const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface QueuedExit {
  operationId: string;
  commitment: string;
  payoutAddress: string;
  amount: bigint;
  exactExit: boolean;
  windowStart: number;
  executeAt: number;
  windowEnd: number;
  status: "queued" | "submitted" | "finalized";
}

/** Owner-side queue. Only the address and proof are sent to a separate relayer. */
export class V2ExitQueue {
  constructor(private readonly store: RoleStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS v2_exit_queue (
      operation_id TEXT PRIMARY KEY, commitment TEXT NOT NULL UNIQUE, payout_address TEXT NOT NULL UNIQUE,
      amount TEXT NOT NULL, exact_exit INTEGER NOT NULL, window_start INTEGER NOT NULL, execute_at INTEGER NOT NULL,
      window_end INTEGER NOT NULL, status TEXT NOT NULL, transaction_digest TEXT UNIQUE
    )`);
  }

  queue(request: { operationId: string; commitment: string; amount: bigint; exactExit: boolean; windowStart: number; windowEnd: number }, approved: boolean, now = Date.now()): QueuedExit {
    if (!approved) fail("OWNER_APPROVAL_REQUIRED", "owner approval is required to schedule a withdrawal");
    if (!request.operationId || request.operationId.length > 256 || !/^[0-9a-f]{64}$/i.test(request.commitment)) fail("EXIT_REQUEST_INVALID", "operation ID or note commitment is invalid");
    if (request.amount <= 0n || request.amount > (1n << 64n) - 1n || (!request.exactExit && request.amount !== 1_000_000n)) fail("EXIT_AMOUNT_INVALID", "standard exit must be 1,000,000 MIST; exact exit reveals its amount");
    if (!Number.isSafeInteger(request.windowStart) || !Number.isSafeInteger(request.windowEnd) || request.windowStart < now || request.windowEnd <= request.windowStart || request.windowEnd - request.windowStart > MAX_WINDOW_MS) fail("EXIT_WINDOW_INVALID", "exit window must be in the future and no longer than seven days");
    const prior = this.get(request.operationId);
    if (prior) {
      if (prior.commitment !== request.commitment || prior.amount !== request.amount || prior.exactExit !== request.exactExit || prior.windowStart !== request.windowStart || prior.windowEnd !== request.windowEnd) fail("OPERATION_ID_CONFLICT", "exit operation ID is already bound to another request");
      return prior;
    }
    // Node's randomInt uses a cryptographic random source and avoids modulo bias.
    const executeAt = randomInt(request.windowStart, request.windowEnd);
    const payout = Ed25519Keypair.generate();
    const payoutAddress = payout.toSuiAddress();
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.putSecretOnce(`v2-exit-payout:${request.operationId}`, Buffer.from(payout.getSecretKey()));
      this.store.db.prepare("INSERT INTO v2_exit_queue(operation_id,commitment,payout_address,amount,exact_exit,window_start,execute_at,window_end,status) VALUES(?,?,?,?,?,?,?,?,'queued')")
        .run(request.operationId, request.commitment, payoutAddress, request.amount.toString(), Number(request.exactExit), request.windowStart, executeAt, request.windowEnd);
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
    return this.get(request.operationId)!;
  }

  get(operationId: string): QueuedExit | undefined {
    const row = this.store.db.prepare("SELECT operation_id,commitment,payout_address,amount,exact_exit,window_start,execute_at,window_end,status FROM v2_exit_queue WHERE operation_id=?").get(operationId) as {
      operation_id: string; commitment: string; payout_address: string; amount: string; exact_exit: number; window_start: number; execute_at: number; window_end: number; status: QueuedExit["status"];
    } | undefined;
    return row && { operationId: row.operation_id, commitment: row.commitment, payoutAddress: row.payout_address, amount: BigInt(row.amount), exactExit: Boolean(row.exact_exit), windowStart: row.window_start, executeAt: row.execute_at, windowEnd: row.window_end, status: row.status };
  }

  due(now = Date.now()): QueuedExit[] {
    const rows = this.store.db.prepare("SELECT operation_id FROM v2_exit_queue WHERE status='queued' AND execute_at<=? AND window_end>? ORDER BY execute_at").all(now, now) as Array<{ operation_id: string }>;
    return rows.map((row) => this.get(row.operation_id)!);
  }

  assertDue(operationId: string, now = Date.now()): QueuedExit {
    const exit = this.get(operationId) ?? fail("OPERATION_ID_CONFLICT", "exit has no journal entry");
    if (exit.status !== "queued" || now < exit.executeAt || now >= exit.windowEnd) fail("EXIT_WINDOW_CLOSED", "exit can only be submitted inside its scheduled window");
    return exit;
  }

  recordSubmission(operationId: string, digest: string): void {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(digest)) fail("EXIT_DIGEST_INVALID", "relayer transaction digest is invalid");
    const row = this.store.db.prepare("SELECT status,transaction_digest FROM v2_exit_queue WHERE operation_id=?").get(operationId) as { status: string; transaction_digest: string | null } | undefined;
    if (!row) return fail("OPERATION_ID_CONFLICT", "exit submission has no journal entry");
    if (row.transaction_digest && row.transaction_digest !== digest) fail("OPERATION_ID_CONFLICT", "exit submission conflicts with the journal");
    this.store.db.prepare("UPDATE v2_exit_queue SET status='submitted',transaction_digest=? WHERE operation_id=? AND status='queued'").run(digest, operationId);
  }

  recordFinalized(operationId: string, digest: string): void {
    const row = this.store.db.prepare("SELECT transaction_digest FROM v2_exit_queue WHERE operation_id=?").get(operationId) as { transaction_digest: string | null } | undefined;
    if (!row || row.transaction_digest !== digest) fail("OPERATION_ID_CONFLICT", "finality does not match the journaled relayer transaction");
    this.store.db.prepare("UPDATE v2_exit_queue SET status='finalized' WHERE operation_id=?").run(operationId);
  }
}
