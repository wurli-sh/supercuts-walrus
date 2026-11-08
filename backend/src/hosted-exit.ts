import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail } from "./errors.js";
import { executeMandated, loadMandate } from "./mandate.js";
import { Phase3App } from "./phase3.js";
import { SellerDatabase } from "./seller-database.js";
import { captureSellerHome, decryptSellerSnapshot, encryptSellerSnapshot, restoreSellerHome } from "./seller-state.js";
import { V2ExitQueue } from "./v2-exits.js";

const STANDARD_EXIT_MIST = 1_000_000n;
const validId = (value: string): boolean => /^[a-zA-Z0-9._:-]{1,128}$/.test(value);
export const hostedExitOperationId = (sessionId: string): string => `remote-exit-${sessionId}`;

export interface HostedExitView {
  sellerId: string;
  runId: string;
  sessionId: string;
  operationId: string;
  status: "queued" | "submitted" | "finalized";
  amount: string;
  executeAt: number;
  windowEnd: number;
}

async function withSeller<T>(db: SellerDatabase, stateKey: string, sellerId: string, use: (app: Phase3App, home: string, revision: number, artifacts: Record<string, string>) => Promise<T>): Promise<T> {
  const stored = await db.getSnapshot(sellerId) ?? fail("SELLER_STATE_MISSING", "confidential seller snapshot is missing");
  const snapshot = decryptSellerSnapshot(stored.payload, stateKey);
  if (snapshot.sellerId !== sellerId) fail("SELLER_IDENTITY_MISMATCH", "seller snapshot belongs to another role");
  const root = mkdtempSync(join(tmpdir(), "supercuts-hosted-exit-")), home = join(root, "seller");
  let app: Phase3App | undefined;
  try {
    restoreSellerHome(home, snapshot);
    app = new Phase3App(home);
    if (app.profile.role !== "seller" || app.profile.mock || app.profile.verifierVersion !== 2) fail("LIVE_PROFILE_REQUIRED", "hosted exit needs the confidential seller's live v2 role");
    const encoded = app.store.getSecret("live:sui-private-key")?.toString() ?? fail("LIVE_CREDENTIAL_MISSING", "seller signer is missing from its own snapshot");
    const decoded = decodeSuiPrivateKey(encoded);
    if (decoded.scheme !== "ED25519" || Ed25519Keypair.fromSecretKey(decoded.secretKey).toSuiAddress().toLowerCase() !== sellerId.toLowerCase()) fail("SELLER_IDENTITY_MISMATCH", "seller snapshot signer differs from the configured seller");
    return await use(app, home, stored.revision, snapshot.artifacts);
  } finally { app?.close(); rmSync(root, { recursive: true, force: true }); }
}

function matchingPayment(app: Phase3App, sessionId: string, runId: string): string {
  const delivery = app.store.db.prepare("SELECT run_id FROM remote_deliveries WHERE session_id=?").get(sessionId) as { run_id: string } | undefined;
  if (!delivery || delivery.run_id !== runId) fail("DELIVERY_NOT_FOUND", "seller has no delivered analysis for this run and session");
  const note = app.store.db.prepare("SELECT commitment FROM notes WHERE operation_id=? AND role='payment'").get(sessionId) as { commitment: string } | undefined ?? fail("NOTE_NOT_FOUND", "seller has not recovered the matching payment note");
  return note.commitment;
}

function view(app: Phase3App, sellerId: string, runId: string, sessionId: string): HostedExitView {
  const commitment = matchingPayment(app, sessionId, runId);
  const operationId = hostedExitOperationId(sessionId);
  const queued = new V2ExitQueue(app.store).get(operationId) ?? fail("DEMO_EVIDENCE_MISMATCH", "seller has no queued standard exit");
  if (queued.commitment !== commitment || queued.exactExit || queued.amount !== STANDARD_EXIT_MIST || !app.store.getSecret(`v2-exit-request:${operationId}`)) fail("DEMO_EVIDENCE_MISMATCH", "seller has no prepared standard exit for the recovered payment note");
  return { sellerId, runId, sessionId, operationId, status: queued.status, amount: queued.amount.toString(), executeAt: queued.executeAt, windowEnd: queued.windowEnd };
}

export async function queueHostedExit(db: SellerDatabase, stateKey: string, input: { sellerId: string; runId: string; sessionId: string; windowStart: number; windowEnd: number }): Promise<HostedExitView> {
  if (!validId(input.runId) || !validId(input.sessionId) || !/^0x[0-9a-f]{64}$/i.test(input.sellerId)) fail("SELLER_REQUEST_INVALID", "seller, run, or session ID is invalid");
  return withSeller(db, stateKey, input.sellerId, async (app, home, revision, artifacts) => {
    const commitment = matchingPayment(app, input.sessionId, input.runId), operationId = hostedExitOperationId(input.sessionId);
    if (!new V2ExitQueue(app.store).get(operationId)) {
      if (!Number.isSafeInteger(input.windowStart) || input.windowStart < Date.now() + 60_000) fail("EXIT_WINDOW_INVALID", "standard delayed exit must start at least one minute from now");
      await executeMandated(app, loadMandate(home), "wallet.exit.queue", { "operation-id": operationId, commitment, amount: STANDARD_EXIT_MIST.toString(), "window-start": String(input.windowStart), "window-end": String(input.windowEnd) });
      await db.putSnapshot(encryptSellerSnapshot(await captureSellerHome(home, input.sellerId, artifacts), stateKey), revision);
    }
    return view(app, input.sellerId, input.runId, input.sessionId);
  });
}

export async function inspectHostedExit(db: SellerDatabase, stateKey: string, input: { sellerId: string; runId: string; sessionId: string }): Promise<HostedExitView> {
  if (!validId(input.runId) || !validId(input.sessionId) || !/^0x[0-9a-f]{64}$/i.test(input.sellerId)) fail("SELLER_REQUEST_INVALID", "seller, run, or session ID is invalid");
  return withSeller(db, stateKey, input.sellerId, async (app) => view(app, input.sellerId, input.runId, input.sessionId));
}

/** Exit for a composite `deal.execute` payment, which has no legacy delivery session or run ID. */
export const hostedDealExitOperationId = (requestId: string): string => `deal-exit-${requestId}`;
const digestPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface HostedDealExitView {
  sellerId: string;
  paymentDigest: string;
  requestId: string;
  commitment: string;
  operationId: string;
  status: "queued" | "submitted" | "finalized";
  amount: string;
  executeAt: number;
  windowEnd: number;
}

/** The seller's verifier claimed the buyer's digest for one request; that request owns the recovered payment note. */
function claimedPayment(app: Phase3App, paymentDigest: string): { requestId: string; commitment: string } {
  const hasClaims = Boolean(app.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='seller_payment_claims'").get());
  const claim = hasClaims ? app.store.db.prepare("SELECT request_id FROM seller_payment_claims WHERE digest=?").get(paymentDigest) as { request_id: string } | undefined : undefined;
  if (!claim) fail("PAYMENT_NOT_CLAIMED", "this seller has not verified a payment with that digest");
  const note = app.store.db.prepare("SELECT commitment FROM notes WHERE operation_id=? AND role='payment'").get(claim!.request_id) as { commitment: string } | undefined ?? fail("NOTE_NOT_FOUND", "seller has not recovered the matching payment note");
  return { requestId: claim!.request_id, commitment: note.commitment };
}

function dealView(app: Phase3App, sellerId: string, paymentDigest: string): HostedDealExitView {
  const { requestId, commitment } = claimedPayment(app, paymentDigest), operationId = hostedDealExitOperationId(requestId);
  const queued = new V2ExitQueue(app.store).get(operationId) ?? fail("DEMO_EVIDENCE_MISMATCH", "seller has no queued standard exit");
  if (queued.commitment !== commitment || queued.exactExit || queued.amount !== STANDARD_EXIT_MIST || !app.store.getSecret(`v2-exit-request:${operationId}`)) fail("DEMO_EVIDENCE_MISMATCH", "seller has no prepared standard exit for the recovered payment note");
  return { sellerId, paymentDigest, requestId, commitment, operationId, status: queued.status, amount: queued.amount.toString(), executeAt: queued.executeAt, windowEnd: queued.windowEnd };
}

function validDealInput(input: { sellerId: string; paymentDigest: string }): void {
  if (!digestPattern.test(input.paymentDigest) || !/^0x[0-9a-f]{64}$/i.test(input.sellerId)) fail("SELLER_REQUEST_INVALID", "seller ID or payment digest is invalid");
}

export async function queueHostedDealExit(db: SellerDatabase, stateKey: string, input: { sellerId: string; paymentDigest: string; windowStart: number; windowEnd: number }): Promise<HostedDealExitView> {
  validDealInput(input);
  return withSeller(db, stateKey, input.sellerId, async (app, home, revision, artifacts) => {
    const { requestId, commitment } = claimedPayment(app, input.paymentDigest), operationId = hostedDealExitOperationId(requestId);
    if (!new V2ExitQueue(app.store).get(operationId)) {
      if (!Number.isSafeInteger(input.windowStart) || input.windowStart < Date.now() + 60_000) fail("EXIT_WINDOW_INVALID", "standard delayed exit must start at least one minute from now");
      await executeMandated(app, loadMandate(home), "wallet.exit.queue", { "operation-id": operationId, commitment, amount: STANDARD_EXIT_MIST.toString(), "window-start": String(input.windowStart), "window-end": String(input.windowEnd) });
      await db.putSnapshot(encryptSellerSnapshot(await captureSellerHome(home, input.sellerId, artifacts), stateKey), revision);
    }
    return dealView(app, input.sellerId, input.paymentDigest);
  });
}

export async function inspectHostedDealExit(db: SellerDatabase, stateKey: string, input: { sellerId: string; paymentDigest: string }): Promise<HostedDealExitView> {
  validDealInput(input);
  return withSeller(db, stateKey, input.sellerId, async (app) => dealView(app, input.sellerId, input.paymentDigest));
}
