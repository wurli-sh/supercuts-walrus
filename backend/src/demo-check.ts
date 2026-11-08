import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DealJournal } from "./deal.js";
import { fail } from "./errors.js";
import { readDemoEvents, type DemoEvent } from "./events.js";
import { inspectHostedDealExit } from "./hosted-exit.js";
import { Phase3App } from "./phase3.js";
import type { SellerDatabase } from "./seller-database.js";
import { V2ExitQueue } from "./v2-exits.js";

interface DealSummary {
  dealId: string;
  paymentDigest: string;
  firstSequence: number;
  finalSequence: number;
}
export interface DealRunAnalysis {
  privateDeal: DealSummary;
  publicDeal: DealSummary;
  privacyPlanHash: string;
  privacyPlanBlobIds: string[];
  exit: {
    operationId: string;
    paymentDigest: string;
    sequence: number;
    amount?: string;
    executeAt?: number;
    windowEnd?: number;
  };
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

/**
 * The recorded demo story, from the buyer's deal.execute event stream alone:
 * a confidential deal first, whose requested public rail was overridden to shielded by a recalled
 * owner privacy rule, then a public x402 deal, then the confidential seller's queued exit for
 * exactly the private payment.
 */
export function analyzeDealEvents(events: DemoEvent[]): DealRunAnalysis {
  const deals = new Map<
    string,
    DealSummary & { rail: unknown; state: unknown }
  >();
  for (const event of events.filter(
    (item) =>
      item.stage === "deal-lifecycle" &&
      typeof item.publicDetails.dealId === "string",
  )) {
    const dealId = String(event.publicDetails.dealId),
      prior = deals.get(dealId);
    deals.set(dealId, {
      dealId,
      firstSequence: prior?.firstSequence ?? event.sequence,
      finalSequence: event.sequence,
      rail: event.publicDetails.rail,
      state: event.publicDetails.state,
      paymentDigest: String(event.publicDetails.paymentDigest ?? ""),
    });
  }
  const complete = [...deals.values()].filter(
    (deal) => deal.state === "complete" && deal.paymentDigest,
  );
  const privateDeal = complete.find((deal) => deal.rail === "shielded"),
    publicDeal = complete.find((deal) => deal.rail === "x402");
  if (!privateDeal || !publicDeal)
    fail(
      "DEMO_ACCEPTANCE_INCOMPLETE",
      "recording needs one completed shielded deal and one completed x402 deal",
    );
  if (privateDeal!.firstSequence >= publicDeal!.firstSequence)
    fail(
      "DEMO_SEQUENCE_INVALID",
      "the confidential deal must run before the public deal",
    );
  const before = (event: DemoEvent) =>
    event.sequence < privateDeal!.finalSequence;
  const plan = events.find(
    (event) =>
      before(event) &&
      event.stage === "settlement-plan" &&
      event.publicDetails.rail === "shielded" &&
      strings(event.publicDetails.reasonCodes).includes(
        "MEMORY_PRIVACY_APPLIED",
      ) &&
      strings(event.publicDetails.reasonCodes).includes(
        "MEMORY_PRIVACY_OVERRODE_RAIL",
      ) &&
      events.some(
        (influence) =>
          before(influence) &&
          influence.stage === "memory-influence" &&
          influence.publicDetails.planHash === event.publicDetails.planHash &&
          influence.publicDetails.changedRail === true &&
          (
            influence.publicDetails.withoutMemory as
              | { rail?: unknown }
              | undefined
          )?.rail === "x402" &&
          (influence.publicDetails.withMemory as { rail?: unknown } | undefined)
            ?.rail === "shielded",
      ),
  );
  if (
    !plan ||
    typeof plan.publicDetails.planHash !== "string" ||
    !strings(plan.publicDetails.blobIds).length
  )
    fail(
      "DEMO_PRIVACY_EVIDENCE_MISSING",
      "the confidential deal must show a requested x402 rail overridden to shielded by a cited memory",
    );
  const exit = events.find(
    (event) =>
      event.actor === "confidential-seller" &&
      event.stage === "delayed-exit" &&
      event.status === "complete" &&
      event.publicDetails.state === "queued" &&
      event.publicDetails.paymentDigest === privateDeal!.paymentDigest &&
      event.sequence > privateDeal!.finalSequence &&
      typeof event.publicDetails.operationId === "string",
  );
  if (!exit)
    fail(
      "DEMO_ACCEPTANCE_INCOMPLETE",
      "the confidential seller must queue a delayed exit for the private payment after delivery",
    );
  return {
    privateDeal: privateDeal!,
    publicDeal: publicDeal!,
    privacyPlanHash: String(plan!.publicDetails.planHash),
    privacyPlanBlobIds: strings(plan!.publicDetails.blobIds),
    exit: {
      operationId: String(exit!.publicDetails.operationId),
      paymentDigest: privateDeal!.paymentDigest,
      sequence: exit!.sequence,
      ...(typeof exit!.publicDetails.amount === "string"
        ? { amount: exit!.publicDetails.amount }
        : {}),
      ...(typeof exit!.publicDetails.executeAt === "number"
        ? { executeAt: exit!.publicDetails.executeAt }
        : {}),
      ...(typeof exit!.publicDetails.windowEnd === "number"
        ? { windowEnd: exit!.publicDetails.windowEnd }
        : {}),
    },
  };
}

const ownerOnly = (path: string): boolean =>
  existsSync(path) && (statSync(path).mode & 0o077) === 0;

/** Reconciles the analyzed story with the buyer journal and the confidential seller's own state. */
export async function verifyDealRun(input: {
  buyerHome: string;
  eventPath: string;
  seller:
    | { home: string }
    | { hosted: { db: SellerDatabase; stateKey: string; sellerId: string } };
}): Promise<Record<string, unknown>> {
  const { buyerHome, eventPath } = input;
  if (
    !ownerOnly(buyerHome) ||
    !ownerOnly(eventPath) ||
    ("home" in input.seller && !ownerOnly(input.seller.home))
  )
    fail(
      "DEMO_PERMISSIONS",
      "role homes and the event stream must be owner-only",
    );
  const raw = readFileSync(eventPath, "utf8");
  if (
    /(?:suiprivkey|BEGIN [A-Z ]*PRIVATE KEY|approval.?token|note.?opening|full.?prompt)/i.test(
      raw,
    )
  )
    fail(
      "SECRET_SCAN_FAILED",
      "event bundle contains forbidden secret material",
    );
  const events = readDemoEvents(eventPath);
  if (
    !events.length ||
    events.some(
      (event) => event.mode !== "live" || event.runId !== events[0]!.runId,
    )
  )
    fail(
      "DEMO_EVENTS_INVALID",
      "recording needs one nonempty live event stream for a single run",
    );
  const analysis = analyzeDealEvents(events);
  const profile = JSON.parse(
    readFileSync(join(buyerHome, "profile.json"), "utf8"),
  ) as { role?: string; mock?: boolean; verifierVersion?: number };
  if (profile.role !== "buyer" || profile.mock || profile.verifierVersion !== 2)
    fail("LIVE_PROFILE_REQUIRED", "the recording needs a live v2 buyer home");
  const buyer = new Phase3App(buyerHome);
  try {
    const journal = new DealJournal(buyer.store);
    for (const [deal, rail] of [
      [analysis.privateDeal, "shielded"],
      [analysis.publicDeal, "x402"],
    ] as const) {
      const row = buyer.store.db
        .prepare("SELECT operation_id FROM deal_operations WHERE deal_id=?")
        .get(deal.dealId) as { operation_id: string } | undefined;
      if (!row)
        fail(
          "DEMO_EVIDENCE_MISMATCH",
          `deal ${deal.dealId} is absent from the buyer journal`,
        );
      const view = journal.get(row!.operation_id),
        evidence = journal.evidence(deal.dealId);
      if (
        view.state !== "complete" ||
        view.rail !== rail ||
        view.paymentDigest !== deal.paymentDigest ||
        !evidence.paymentFinalized ||
        evidence.ciphertextReadback !== "verified"
      )
        fail(
          "DEMO_EVIDENCE_MISMATCH",
          `${rail} deal differs from the verified buyer journal`,
        );
      if (evidence.inventory !== "indexed")
        fail(
          "DEMO_OUTCOME_MEMORY_PENDING",
          `${rail} deal outcome memory is not indexed yet; keep the buyer MCP or memory worker running, or run deal.reconcile`,
        );
      if (rail === "shielded" && view.planHash !== analysis.privacyPlanHash)
        fail(
          "DEMO_PRIVACY_EVIDENCE_MISSING",
          "the rail override belongs to another plan than the settled confidential deal",
        );
    }
    const policies = (
      buyer.store.db
        .prepare(
          "SELECT blob_id FROM memory_jobs WHERE operation_id LIKE 'owner-privacy-%' AND status='complete' AND blob_id IS NOT NULL",
        )
        .all() as Array<{ blob_id: string }>
    ).map((row) => row.blob_id);
    if (
      !analysis.privacyPlanBlobIds.some((blobId) => policies.includes(blobId))
    )
      fail(
        "DEMO_PRIVACY_EVIDENCE_MISSING",
        "the override must cite the owner's saved Walrus Memory privacy rule",
      );
    const funded = buyer.store.db
      .prepare(
        "SELECT 1 FROM live_signed_transactions AS tx JOIN live_operation_context AS context ON context.operation_id=tx.operation_id WHERE tx.status='finalized' AND context.kind='deposit'",
      )
      .get();
    if (!funded)
      fail(
        "DEMO_EVIDENCE_MISMATCH",
        "the buyer has no finalized shielded pool deposit",
      );
  } finally {
    buyer.close();
  }
  if ("home" in input.seller) {
    const seller = new Phase3App(input.seller.home);
    try {
      if (
        seller.profile.role !== "seller" ||
        seller.profile.mock ||
        seller.profile.verifierVersion !== 2
      )
        fail(
          "LIVE_PROFILE_REQUIRED",
          "the exit must belong to a separate live v2 seller",
        );
      const queued = new V2ExitQueue(seller.store).get(
        analysis.exit.operationId,
      );
      if (
        !queued ||
        !seller.store.db
          .prepare("SELECT 1 FROM notes WHERE commitment=? AND role='payment'")
          .get(queued.commitment)
      )
        fail(
          "DEMO_EVIDENCE_MISMATCH",
          "the recorded exit is not queued against a recovered seller payment note",
        );
    } finally {
      seller.close();
    }
  } else {
    const { db, stateKey, sellerId } = input.seller.hosted;
    const queued = await inspectHostedDealExit(db, stateKey, {
      sellerId,
      paymentDigest: analysis.exit.paymentDigest,
    });
    if (
      queued.operationId !== analysis.exit.operationId ||
      (analysis.exit.amount !== undefined &&
        queued.amount !== analysis.exit.amount) ||
      (analysis.exit.executeAt !== undefined &&
        queued.executeAt !== analysis.exit.executeAt)
    )
      fail(
        "DEMO_EVIDENCE_MISMATCH",
        "the recorded hosted exit differs from the seller's encrypted state",
      );
  }
  return {
    healthy: true,
    secretScan: "pass",
    order: "private-then-public",
    privateDeal: analysis.privateDeal.dealId,
    publicDeal: analysis.publicDeal.dealId,
    privacyPlanHash: analysis.privacyPlanHash,
    exit: analysis.exit.operationId,
  };
}
