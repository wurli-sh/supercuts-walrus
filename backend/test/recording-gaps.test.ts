import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCapabilityManifest } from "../src/capability.js";
import { ownerPrivacyRule } from "../src/buyer-setup.js";
import { DemoEventLog, dealBelongsToRun, runStartedAt } from "../src/events.js";
import { roleHomeBusyRecovery } from "../src/role-lock.js";
import {
  createSettlementPlan,
  type SettlementMemoryV1,
} from "../src/settlement.js";
import type { AgentMandate } from "../src/mandate.js";

const now = Date.now();
const manifest = (
  capabilityId: string,
  capability: string,
  sellerId = "0xseller",
) =>
  createCapabilityManifest({
    capabilityId,
    sellerId,
    capability,
    description: "artifact",
    inputSchema: {},
    outputSchema: {},
    supportedRails: ["x402", "shielded"],
    priceBand: { minimum: "10", maximum: "50" },
    asset: "0x2::sui::SUI",
    endpoint: "https://seller.example/artifact",
    expiresAt: now + 600_000,
  });
const mandate = {
  version: "supercuts.mandate.v2",
  allowedCommands: [],
  allowedCounterparties: ["0xseller", "0xother"],
  allowedAssets: ["0x2::sui::SUI"],
  perDealCeiling: "100",
  totalRunBudget: "1000",
  expiresAt: now + 600_000,
  requiredPrivacy: "any",
  requireSettlementPlan: true,
  allowedRails: ["shielded", "x402"],
  allowPublicX402: true,
} as unknown as AgentMandate;

test("a class-scoped owner privacy rule survives a seller rotating its capability ID", () => {
  const catalog = [
    manifest("confidential-analysis-v2", "sui.confidential-analysis"),
    manifest("market-brief", "sui.market-brief"),
  ];
  const rule = ownerPrivacyRule(
    catalog,
    { capabilityClass: "sui.confidential-analysis" },
    now,
  );
  assert.deepEqual(rule.memory.scope, {
    capabilityClass: "sui.confidential-analysis",
    network: "sui:testnet",
    asset: "0x2::sui::SUI",
  });
  assert.deepEqual(rule.matched, ["confidential-analysis-v2"]);
  const rotated = manifest(
    "deepbook-competitor-analysis",
    "sui.confidential-analysis",
    "0xother",
  );
  const plan = createSettlementPlan({
    operationId: "rotated",
    mandate,
    manifests: [rotated],
    requestedRail: "x402",
    now,
    recalled: [
      {
        blobId: "class-rule",
        distance: 0.1,
        memory: {
          ...rule.memory,
          provenance: "owner_policy",
        } as SettlementMemoryV1,
      },
    ],
  });
  assert.equal(plan.rail, "shielded");
  assert.ok(plan.reasonCodes.includes("MEMORY_PRIVACY_OVERRODE_RAIL"));
  const publicPlan = createSettlementPlan({
    operationId: "public",
    mandate,
    manifests: [manifest("market-brief", "sui.market-brief")],
    requestedRail: "x402",
    now,
    recalled: [
      {
        blobId: "class-rule",
        distance: 0.1,
        memory: {
          ...rule.memory,
          provenance: "owner_policy",
        } as SettlementMemoryV1,
      },
    ],
  });
  assert.equal(
    publicPlan.rail,
    "x402",
    "the class rule leaves other classes on their requested rail",
  );
});

test("an owner privacy rule names exactly one capability ID or one class that the catalog offers", () => {
  const catalog = [manifest("a", "sui.confidential-analysis")];
  assert.deepEqual(
    ownerPrivacyRule(catalog, { capabilityId: "a" }, now).memory.scope,
    {
      capabilityId: "a",
      counterparty: "0xseller",
      network: "sui:testnet",
      asset: "0x2::sui::SUI",
    },
  );
  assert.throws(
    () => ownerPrivacyRule(catalog, { capabilityClass: "sui.unknown" }, now),
    /POLICY_CAPABILITY_INVALID|signed seller capability/,
  );
  assert.throws(
    () =>
      ownerPrivacyRule(
        catalog,
        { capabilityId: "a", capabilityClass: "sui.confidential-analysis" },
        now,
      ),
    /exactly one/,
  );
  assert.throws(() => ownerPrivacyRule(catalog, {}, now), /exactly one/);
  assert.notEqual(
    ownerPrivacyRule(catalog, { capabilityId: "a" }, now).operationId,
    ownerPrivacyRule(
      catalog,
      { capabilityClass: "sui.confidential-analysis" },
      now,
    ).operationId,
  );
});

test("a deal read from an earlier run does not join this run's recorded evidence", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "supercuts-run-")),
    "events.jsonl",
  );
  assert.equal(runStartedAt(path), undefined, "no stream yet");
  const log = new DemoEventLog(path, "run-1");
  log.append({
    actor: "operator",
    stage: "run",
    status: "started",
    publicDetails: {},
    evidenceHashes: [],
    explorerLinks: [],
  });
  const started = runStartedAt(path)!;
  assert.ok(Number.isSafeInteger(started));
  assert.equal(
    dealBelongsToRun(started - 1, started),
    false,
    "created before the run",
  );
  assert.equal(dealBelongsToRun(started, started), true);
  assert.equal(dealBelongsToRun(undefined, started), false);
  assert.equal(
    dealBelongsToRun(started - 1, undefined),
    true,
    "no event stream means nothing to protect",
  );
});

test("a busy role home tells the owner which process holds it and how to free it", () => {
  const text = roleHomeBusyRecovery(4242);
  assert.match(text, /4242/);
  assert.match(text, /codex app-server/);
  assert.match(text, /restart/i);
});

test("entry points accept the engines floor and reject Node 20 before loading node:sqlite", async () => {
  const { nodeVersionSupported } = await import("../src/node-guard.js");
  assert.equal(nodeVersionSupported("20.19.2"), false);
  assert.equal(nodeVersionSupported("22.12.0"), false);
  assert.equal(nodeVersionSupported("22.13.0"), true);
  assert.equal(nodeVersionSupported("v24.18.0"), true);
});
