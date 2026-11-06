import type {
  RecalledSettlementMemory,
  SettlementMemoryScope,
  SettlementMemoryV1,
} from "./settlement.js";

/** Learned view of one counterparty, derived only from trusted Walrus Memory outcomes. */
export interface SellerScorecard {
  counterparty: string;
  observations: number;
  successes: number;
  failures: number;
  unresolved: number;
  /** Recency-weighted Beta(1,1) posterior mean; 0.5 when nothing has been learned. */
  reliability: number;
  lastOutcome?: "succeeded" | "failed" | "unresolved";
  lastOutcomeAt?: number;
  medianLatencyMs?: number;
  citedBlobIds: string[];
}

export const DEFAULT_HALF_LIFE_MS = 7 * 86_400_000;
const TRUSTED = new Set(["owner_policy", "verified_outcome"]);

/** True when every field the filter names matches the memory scope. */
export function scopeWithin(
  scope: SettlementMemoryScope,
  filter: SettlementMemoryScope,
): boolean {
  return (
    Object.entries(filter) as Array<
      [keyof SettlementMemoryScope, string | undefined]
    >
  ).every(([key, value]) => value === undefined || scope[key] === value);
}

/**
 * Trusted deal-level outcome memories for the filter, deduplicated by evidence (one deal may be recalled twice).
 * Only completed deals and verified seller faults carry `signal.rail`; stage events (agreement, settlement,
 * delivery) stay as evidence but are not counted as additional deals.
 */
export function trustedOutcomes(
  recalled: readonly RecalledSettlementMemory[],
  filter: SettlementMemoryScope,
): Array<{ blobId: string; memory: SettlementMemoryV1 }> {
  const seen = new Set<string>(),
    result: Array<{ blobId: string; memory: SettlementMemoryV1 }> = [];
  for (const item of recalled) {
    const memory = item.memory;
    if (
      !memory ||
      memory.kind !== "outcome" ||
      memory.signal.rail === undefined ||
      !TRUSTED.has(memory.provenance) ||
      !memory.signal.outcome ||
      !scopeWithin(memory.scope, filter)
    )
      continue;
    const key = memory.evidenceHash ?? item.blobId;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ blobId: item.blobId, memory });
  }
  return result.sort(
    (a, b) =>
      a.memory.createdAt - b.memory.createdAt ||
      a.blobId.localeCompare(b.blobId),
  );
}

export function buildScorecard(
  recalled: readonly RecalledSettlementMemory[],
  filter: SettlementMemoryScope & { counterparty: string },
  now: number,
  halfLifeMs = DEFAULT_HALF_LIFE_MS,
): SellerScorecard {
  const outcomes = trustedOutcomes(recalled, filter);
  let alpha = 1,
    beta = 1,
    successes = 0,
    failures = 0,
    unresolved = 0;
  const latencies: number[] = [];
  for (const { memory } of outcomes) {
    const weight = Math.pow(
      0.5,
      Math.max(0, now - memory.createdAt) / halfLifeMs,
    );
    if (memory.signal.outcome === "succeeded") {
      successes++;
      alpha += weight;
    } else if (memory.signal.outcome === "failed") {
      failures++;
      beta += weight;
    } else {
      unresolved++;
      beta += weight / 2;
    }
    if (memory.signal.latencyMs !== undefined)
      latencies.push(memory.signal.latencyMs);
  }
  latencies.sort((a, b) => a - b);
  const last = outcomes.at(-1)?.memory;
  return {
    counterparty: filter.counterparty,
    observations: outcomes.length,
    successes,
    failures,
    unresolved,
    reliability: alpha / (alpha + beta),
    ...(last
      ? { lastOutcome: last.signal.outcome!, lastOutcomeAt: last.createdAt }
      : {}),
    ...(latencies.length
      ? { medianLatencyMs: latencies[Math.floor((latencies.length - 1) / 2)]! }
      : {}),
    citedBlobIds: outcomes.map((item) => item.blobId),
  };
}

/** Sum of verified paid amounts since `since` within the filter scope; a paid-but-failed deal still spent money. */
export function spentSince(
  recalled: readonly RecalledSettlementMemory[],
  filter: SettlementMemoryScope,
  since: number,
): bigint {
  return trustedOutcomes(recalled, filter)
    .filter(
      ({ memory }) =>
        memory.signal.amount !== undefined && memory.createdAt >= since,
    )
    .reduce((total, { memory }) => total + BigInt(memory.signal.amount!), 0n);
}
