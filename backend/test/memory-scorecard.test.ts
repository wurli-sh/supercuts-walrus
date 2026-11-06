import assert from "node:assert/strict";
import test from "node:test";
import { buildScorecard, spentSince } from "../src/memory-scorecard.js";
import type {
  RecalledSettlementMemory,
  SettlementMemoryV1,
} from "../src/settlement.js";

const now = 2_000_000_000_000,
  day = 86_400_000;
let seq = 0;
const outcome = (
  counterparty: string,
  result: "succeeded" | "failed" | "unresolved",
  createdAt: number,
  extra: Partial<SettlementMemoryV1["signal"]> = {},
  provenance: SettlementMemoryV1["provenance"] = "verified_outcome",
): RecalledSettlementMemory => {
  seq++;
  return {
    blobId: `blob-${seq}`,
    distance: 0.1,
    memory: {
      version: "supercuts.settlement-memory.v1",
      kind: "outcome",
      provenance,
      scope: {
        counterparty,
        capabilityClass: "artifact.generation",
        capabilityId: `${counterparty}-cap`,
        asset: "0x2::sui::SUI",
        network: "sui:testnet",
      },
      createdAt,
      evidenceHash: seq.toString(16).padStart(64, "0"),
      signal: { outcome: result, rail: "x402", ...extra },
    },
  };
};

test("scorecard starts at an uninformed prior", () => {
  const card = buildScorecard([], { counterparty: "seller-a" }, now);
  assert.equal(card.observations, 0);
  assert.equal(card.reliability, 0.5);
  assert.deepEqual(card.citedBlobIds, []);
});

test("scorecard accumulates verified outcomes instead of trusting only the latest", () => {
  const history = [
    outcome("seller-a", "succeeded", now - 5_000),
    outcome("seller-a", "succeeded", now - 4_000),
    outcome("seller-a", "succeeded", now - 3_000),
    outcome("seller-a", "succeeded", now - 2_000),
    outcome("seller-a", "failed", now - 1_000),
  ];
  const card = buildScorecard(history, { counterparty: "seller-a" }, now);
  assert.equal(card.successes, 4);
  assert.equal(card.failures, 1);
  assert.equal(card.lastOutcome, "failed");
  assert.ok(
    card.reliability > 0.6 && card.reliability < 0.8,
    `reliability ${card.reliability}`,
  );
  assert.equal(card.citedBlobIds.length, 5);
});

test("scorecard ignores other sellers, untrusted provenance, and duplicate evidence", () => {
  const duplicate = outcome("seller-a", "failed", now - 1_000);
  const history = [
    duplicate,
    { ...duplicate, blobId: "copy" },
    outcome("seller-b", "failed", now - 1_000),
    outcome("seller-a", "failed", now - 1_000, {}, "agent_observation"),
    { blobId: "legacy", distance: 0.1, legacy: true },
  ];
  const card = buildScorecard(history, { counterparty: "seller-a" }, now);
  assert.equal(card.failures, 1);
  assert.equal(card.observations, 1);
});

test("old outcomes decay so a seller can recover", () => {
  const stale = buildScorecard(
    [
      outcome("seller-a", "failed", now - 60 * day),
      outcome("seller-a", "succeeded", now - 1_000),
    ],
    { counterparty: "seller-a" },
    now,
  );
  const fresh = buildScorecard(
    [
      outcome("seller-a", "failed", now - 1_000),
      outcome("seller-a", "succeeded", now - 1_000),
    ],
    { counterparty: "seller-a" },
    now,
  );
  assert.ok(stale.reliability > fresh.reliability);
});

test("scorecard reports median latency and rolling spend, including paid failures", () => {
  const history = [
    outcome("seller-a", "succeeded", now - 2 * day, {
      amount: "40",
      latencyMs: 900,
    }),
    outcome("seller-a", "succeeded", now - 1_000, {
      amount: "30",
      latencyMs: 300,
    }),
    outcome("seller-a", "succeeded", now - 500, {
      amount: "20",
      latencyMs: 600,
    }),
    outcome("seller-a", "failed", now - 100, { amount: "99" }),
  ];
  const card = buildScorecard(history, { counterparty: "seller-a" }, now);
  assert.equal(card.medianLatencyMs, 600);
  assert.equal(
    spentSince(history, { counterparty: "seller-a" }, now - day),
    149n,
  );
  assert.equal(
    spentSince(
      history,
      { capabilityClass: "artifact.generation" },
      now - 3 * day,
    ),
    189n,
  );
});

test("stage-level outcomes without a deal rail do not count as extra deals", () => {
  const deal = outcome("seller-a", "succeeded", now - 1_000);
  const stage = outcome("seller-a", "succeeded", now - 900);
  delete (stage.memory!.signal as { rail?: string }).rail;
  const card = buildScorecard([deal, stage], { counterparty: "seller-a" }, now);
  assert.equal(card.observations, 1);
  assert.deepEqual(card.citedBlobIds, [deal.blobId]);
});
