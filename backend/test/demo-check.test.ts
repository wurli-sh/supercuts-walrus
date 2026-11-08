import assert from "node:assert/strict";
import test from "node:test";
import { analyzeDealEvents } from "../src/demo-check.js";
import type { DemoEvent } from "../src/events.js";

let sequence = 0;
const event = (actor: string, stage: string, publicDetails: Record<string, unknown>): DemoEvent => ({ schema: "supercuts.demo.v1", sequence: ++sequence, runId: "run", timestamp: "t", actor: actor as DemoEvent["actor"], stage, status: "complete", mode: "live", publicDetails, evidenceHashes: [], explorerLinks: [] });
const privateDigest = "GxWTPv6c1UPG9ESGkV1nGVSBZL5D3D9iLGMEhTG16HSo", publicDigest = "9E3Cro2qxNzqMvj2EjvonigJn5gW8HTmN97K2H6y1w52";
function run(options: { publicFirst?: boolean; overrideCode?: boolean; changedRail?: boolean; exit?: boolean; exitDigest?: string } = {}): DemoEvent[] {
  sequence = 0;
  const privateDeal = [
    event("supercuts", "settlement-plan", { planHash: "p1", rail: "shielded", reasonCodes: ["MEMORY_PRIVACY_APPLIED", ...(options.overrideCode === false ? [] : ["MEMORY_PRIVACY_OVERRODE_RAIL"])], blobIds: ["policy"] }),
    event("supercuts", "memory-influence", { planHash: "p1", changedRail: options.changedRail ?? true, withoutMemory: { rail: "x402" }, withMemory: { rail: "shielded" } }),
    event("supercuts", "deal-lifecycle", { dealId: "d1", state: "complete", rail: "shielded", paymentDigest: privateDigest }),
  ];
  const publicDeal = [
    event("supercuts", "settlement-plan", { planHash: "p2", rail: "x402", reasonCodes: [], blobIds: [] }),
    event("supercuts", "deal-lifecycle", { dealId: "d2", state: "payment_pending", rail: "x402" }),
    event("supercuts", "deal-lifecycle", { dealId: "d2", state: "complete", rail: "x402", paymentDigest: publicDigest }),
  ];
  const ordered = options.publicFirst ? [...publicDeal, ...privateDeal] : [...privateDeal, ...publicDeal];
  const exit = options.exit === false ? [] : [event("confidential-seller", "delayed-exit", { state: "queued", paymentDigest: options.exitDigest ?? privateDigest, operationId: "deal-exit-s1" })];
  return [...ordered, ...exit].map((item, index) => ({ ...item, sequence: index + 1 }));
}

test("a private-first run with a memory rail override and a seller exit passes analysis", () => {
  const result = analyzeDealEvents(run());
  assert.equal(result.privateDeal.dealId, "d1");
  assert.equal(result.privateDeal.paymentDigest, privateDigest);
  assert.equal(result.publicDeal.dealId, "d2");
  assert.equal(result.privacyPlanHash, "p1");
  assert.deepEqual(result.privacyPlanBlobIds, ["policy"]);
  assert.equal(result.exit.operationId, "deal-exit-s1");
});

test("analysis rejects public-first order, a missing override, and an exit for another payment", () => {
  const rejects = (events: DemoEvent[], code: string) => assert.throws(() => analyzeDealEvents(events), (error: Error & { code?: string }) => error.code === code);
  rejects(run({ publicFirst: true }), "DEMO_SEQUENCE_INVALID");
  rejects(run({ overrideCode: false }), "DEMO_PRIVACY_EVIDENCE_MISSING");
  rejects(run({ changedRail: false }), "DEMO_PRIVACY_EVIDENCE_MISSING");
  rejects(run({ exit: false }), "DEMO_ACCEPTANCE_INCOMPLETE");
  rejects(run({ exitDigest: publicDigest }), "DEMO_ACCEPTANCE_INCOMPLETE");
});
