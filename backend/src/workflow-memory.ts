import { createHash } from "node:crypto";
import { fail } from "./errors.js";
import { MemoryFact, RailPolicy, selectRail, validateMemoryFact } from "./memory.js";
import { RoleStore } from "./store.js";

export interface MemoryWriter { remember(fact: MemoryFact): Promise<string>; }
export interface RecalledRule { hiddenAmountRequired?: boolean; seller?: string; maxAmount?: bigint; }

export class WorkflowMemory {
  constructor(private readonly store: RoleStore, private readonly memory: MemoryWriter) {}
  async record(fact: MemoryFact): Promise<string> {
    validateMemoryFact(fact);
    const factHash = createHash("sha256").update(JSON.stringify({ kind: fact.kind, subject: fact.subject, observation: fact.observation, operationId: fact.operationId, createdAt: fact.createdAt })).digest("hex");
    const existing = this.store.db.prepare("SELECT fact_hash, blob_id, status FROM memory_jobs WHERE operation_id = ?").get(fact.operationId) as { fact_hash: string | null; blob_id: string | null; status: string } | undefined;
    if (existing && existing.fact_hash !== factHash) fail("MEMORY_OPERATION_CONFLICT", "memory operation ID already identifies another fact");
    if (existing?.status === "complete" && existing.blob_id) return existing.blob_id;
    if (existing) fail(existing.status === "unresolved" ? "MEMORY_JOB_UNRESOLVED" : "MEMORY_JOB_PENDING", "memory write cannot be repeated without reconciling its prior job");
    const inserted = this.store.db.prepare("INSERT OR IGNORE INTO memory_jobs(operation_id, kind, fact_hash, blob_id, status, created_at) VALUES (?, ?, ?, NULL, 'pending', ?)").run(fact.operationId, fact.kind, factHash, Date.now());
    if (inserted.changes !== 1) fail("MEMORY_JOB_PENDING", "another process started this memory write");
    try {
      const blobId = await this.memory.remember(fact);
      if (!blobId) fail("MEMORY_BLOB_MISSING", "completed memory write returned no blob ID");
      this.store.db.prepare("UPDATE memory_jobs SET blob_id = ?, status = 'complete' WHERE operation_id = ? AND status = 'pending'").run(blobId, fact.operationId);
      return blobId;
    } catch (error) {
      this.store.db.prepare("UPDATE memory_jobs SET status = 'unresolved' WHERE operation_id = ? AND status = 'pending'").run(fact.operationId);
      throw error;
    }
  }
  completed(): Array<{ operationId: string; blobId: string }> {
    return this.store.db.prepare("SELECT operation_id, blob_id FROM memory_jobs WHERE status = 'complete' ORDER BY created_at").all()
      .map((row) => { const value = row as { operation_id: string; blob_id: string }; return { operationId: value.operation_id, blobId: value.blob_id }; });
  }
}

export function policyFromRecall(rules: RecalledRule[]): RailPolicy {
  if (!rules.length) return { hiddenAmountRequired: false, recalledRulesAvailable: false, contradictory: false };
  const privacy = rules.map((rule) => rule.hiddenAmountRequired).filter((value): value is boolean => value !== undefined);
  return { hiddenAmountRequired: privacy.includes(true), recalledRulesAvailable: true, contradictory: privacy.includes(true) && privacy.includes(false) };
}

export function decideRailFromRecall(rules: RecalledRule[], requested: "shielded" | "x402"): "shielded" | "x402" {
  return selectRail(policyFromRecall(rules), requested);
}
