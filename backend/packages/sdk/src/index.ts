import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const SEAM_PROTOCOL = 1 as const;
export const SDK_VERSION = "0.1.0" as const;
export type Role = "buyer" | "seller" | "auditor";
export type Rail = "shielded" | "x402";
export type OperationId = string & { readonly __brand: "OperationId" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type TransactionDigest = string & { readonly __brand: "TransactionDigest" };
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface CapabilityManifest {
  protocol: "supercuts.capability.v1"; capabilityId: string; sellerId: string; capability: string; description: string;
  inputSchema: Readonly<Record<string, unknown>>; outputSchema: Readonly<Record<string, unknown>>; supportedRails: Rail[];
  priceBand: { minimum: string; maximum: string }; asset: string; endpoint: string; expiresAt: number; manifestHash: string;
}
export interface ProcurementTask { taskId: string; request: string; privacy: "public" | "confidential"; maximumAmount: bigint; asset: string; requiredCapability: string; }
export interface SettlementIntent { operationId: OperationId; dealId: string; rail: Rail; amount: bigint; asset: string; counterparty: string; requestId: string; }
export interface DeliveryReceipt { requestId: string; operationId: OperationId; artifactSha256: string; deliveredAt: number; observation: "artifact-delivered"; }
export interface MemoryFact { kind: "task" | "capability_choice" | "offer" | "agreed_cost" | "seller_responsiveness" | "settlement_rail" | "delivery_hash" | "latency" | "retry_behavior" | "outcome" | "privacy_policy"; subject: string; observation: string; operationId: OperationId; createdAt: number; }
export interface SettlementMemoryV1 { version: "supercuts.settlement-memory.v1"; kind: "privacy_rule" | "budget_limit" | "reliability" | "quality" | "outcome"; provenance?: "agent_observation"; scope: { counterparty?: string; capabilityId?: string; capabilityClass?: string; network?: "sui:testnet"; asset?: string }; createdAt: number; evidenceHash?: string; observation?: string; signal: { requiresShielded?: boolean; maximumAmount?: string; reliability?: number; quality?: number; outcome?: "succeeded" | "failed" | "unresolved" } }
export interface SettlementCitation { blobId: string; kind: SettlementMemoryV1["kind"] | "legacy"; provenance: "owner_policy" | "verified_outcome" | "agent_observation" | "legacy_untrusted"; distance: number; }
export interface SettlementPlanV1 { version: "supercuts.settlement-plan.v1"; planHash: string; operationId: string; status: "approved" | "review_required"; mandateHash: string; manifestHash: string; capabilityId: string; capabilityClass: string; sellerId: string; endpoint: string; network: "sui:testnet"; asset: string; rail: Rail; openingAmount: string; maximumAmount: string; manifestMinimum: string; manifestMaximum: string; riskLevel: "low" | "medium" | "review_required"; createdAt: number; expiresAt: number; citations: SettlementCitation[]; reasonCodes: string[]; approvedFromPlanHash?: string; }
export interface DemoEvent { schema: "supercuts.demo.v1"; sequence: number; runId: string; timestamp: string; actor: string; stage: string; status: string; mode: "live" | "recorded-funded-run"; publicDetails: Readonly<Record<string, unknown>>; evidenceHashes: string[]; explorerLinks: string[]; }

export interface AuthorizationIntent {
  challengeId: string; intentHash: string; role: Role; command: string;
  summary: string; parameters: Record<string, string | boolean>; expiresAt: number;
}
export interface ApprovalDecision { approved: boolean; reason?: string; }
export interface ApprovalProvider { approve(intent: Readonly<AuthorizationIntent>): Promise<ApprovalDecision>; }
export interface SupercutsSdkConfig { home: string; approvalProvider?: ApprovalProvider; seamPath?: string; timeoutMs?: number; }
export interface MockInitializeOptions {
  role: Role; mock: true; artifactManifest?: string; maxAmount?: bigint;
  allowedCounterparties?: string[]; requireShielded?: boolean; maxMemoryDistance?: number;
}
export interface LiveInitializeOptions {
  role: Role; mock?: false; deploymentConfig: string; suiKeyFile: string; tatumKeyFile: string;
  writeGrpc: string; tatumGrpc: string; snarkjsPath?: string; converterPath?: string; rapidsnarkPath?: string;
  memoryConfigFile?: string; walrusPublisher?: string; walrusAggregator?: string;
  maxAmount?: bigint; allowedCounterparties?: string[]; requireShielded?: boolean; maxMemoryDistance?: number;
}
export type InitializeOptions = MockInitializeOptions | LiveInitializeOptions;
export interface DoctorReport { role: Role; network: "testnet"; packageId: string; poolId: string; asset: string; verifierVersion: number; artifactManifestSha256: string; keyPermissions: "owner-only"; rpc: string; healthy: true; }
export interface Status { role: Role; network: "testnet"; operations: number; mock: boolean; }
export interface WalletBalance { available: bigint; notes: number; }
export interface QueuedExit { operationId: string; commitment: string; payoutAddress: string; amount: bigint; exactExit: boolean; windowStart: number; executeAt: number; windowEnd: number; status: "queued" | "submitted" | "finalized"; visibility?: string; }
export interface TransactionReceipt { transactionDigest: TransactionDigest; finalized: boolean; evidence: string; amount?: bigint; commitment?: string; }
export interface OfferState { sessionId: SessionId; revision: number; state: string; termsHash?: string; transcriptCommitment: string; }
export interface PaymentQuote { rail: Rail; amount: bigint; counterparty: string; asset: string; policyDecision: "allowed"; visibility: string; }
export interface PaymentReceipt {
  operationId: OperationId; status: "broadcast" | "finalized" | "unresolved"; rail: Rail;
  amount: bigint; counterparty: string; asset: string; requestId: string; transactionDigest: TransactionDigest;
  policyDecision: "allowed"; tatumVerified: boolean; visibility: string; evidence: string;
}
export interface MemoryStatus { namespace: string; completed: number; jobs: Array<{ operationId: string; blobId: string; status: string }>; }
export interface Capability { capabilityId: string; seller: string; service: string; terms: string; blobId: string; visibility: "public-capability"; }
export interface DisclosureReference { package: string; packageHash: string; auditor: string; dealId: string; }
export interface AuditResult { dealId: string; agreementVerified: boolean; paymentVerified: boolean; transactionDigest: TransactionDigest; evidence: string; }

export class SupercutsSdkError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, readonly recovery?: string) { super(message); this.name = "SupercutsSdkError"; }
}
export class SeamUnavailable extends Error { constructor(message: string) { super(message); this.name = "SeamUnavailable"; } }
export function operationId(value: string): OperationId { if (!value || value.length > 256) throw new TypeError("operation ID must contain 1..256 characters"); return value as OperationId; }
export function sessionId(value: string): SessionId { if (!value || value.length > 256) throw new TypeError("session ID must contain 1..256 characters"); return value as SessionId; }

interface SeamEnvelope { protocol: number; requestId: string | null; ok: boolean; result?: unknown; error?: { code?: string; message?: string; retryable?: boolean; recovery?: string } }
interface SeamRequest { protocol: 1; requestId: string; method: string; home?: string; params?: Record<string, unknown>; }

function defaultSeamPath(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@supercuts/backend/package.json")), "dist", "seam.js");
}
class Seam {
  readonly #path: string; readonly #timeout: number;
  constructor(private readonly config: SupercutsSdkConfig) { this.#path = config.seamPath ?? defaultSeamPath(); this.#timeout = config.timeoutMs ?? 300_000; }
  async call<T>(method: string, params?: Record<string, unknown>, withHome = true): Promise<T> {
    const request: SeamRequest = { protocol: SEAM_PROTOCOL, requestId: randomUUID(), method, ...(withHome ? { home: this.config.home } : {}), ...(params ? { params } : {}) };
    return await new Promise<T>((resolve, reject) => {
      const child = spawn(process.execPath, [this.#path], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
      let stdout = "", stderrBytes = 0, done = false;
      const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new SeamUnavailable(`${method} exceeded ${this.#timeout}ms`)); }, this.#timeout);
      const finish = (error?: Error, value?: T) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value as T); };
      child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { stdout += chunk; if (stdout.length > 2 * 1024 * 1024) { child.kill("SIGKILL"); finish(new SeamUnavailable("seam response exceeded 2 MiB")); } });
      child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; });
      child.on("error", (error) => finish(new SeamUnavailable(`could not start Supercuts seam: ${error.message}`)));
      child.on("close", () => {
        if (done) return;
        let response: SeamEnvelope; try { response = JSON.parse(stdout) as SeamEnvelope; } catch { return finish(new SeamUnavailable(`seam returned invalid JSON (${stderrBytes} stderr bytes)`)); }
        if (response.protocol !== SEAM_PROTOCOL || response.requestId !== request.requestId) return finish(new SeamUnavailable("seam protocol or request identity mismatch"));
        if (!response.ok) return finish(new SupercutsSdkError(response.error?.code ?? "INTERNAL_ERROR", response.error?.message ?? "Supercuts returned no detail", Boolean(response.error?.retryable), response.error?.recovery));
        if (response.result === undefined) return finish(new SeamUnavailable("seam success response omitted its result"));
        finish(undefined, response.result as T);
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
}

type Arguments = Record<string, unknown>;
abstract class RoleClient {
  protected readonly seam: Seam;
  protected constructor(protected readonly config: SupercutsSdkConfig) { this.seam = new Seam(config); }
  async doctor(): Promise<DoctorReport> { return this.read("doctor"); }
  async status(): Promise<Status> { return this.read("status"); }
  protected async ensureCompatible(): Promise<void> { const version = await this.seam.call<{ protocol: number; packageVersion: string }>("version", undefined, false); if (version.protocol !== SEAM_PROTOCOL || version.packageVersion !== SDK_VERSION) throw new SeamUnavailable(`Supercuts seam ${version.packageVersion}/protocol ${version.protocol} is incompatible with SDK ${SDK_VERSION}/protocol ${SEAM_PROTOCOL}`); }
  protected async read<T>(command: string, args: Arguments = {}): Promise<T> { return this.seam.call("command.execute", { command, arguments: args }); }
  protected async mutate<T>(command: string, args: Arguments): Promise<T> {
    const provider = this.config.approvalProvider;
    if (!provider) throw new SupercutsSdkError("SDK_APPROVAL_PROVIDER_REQUIRED", `${command} requires an ApprovalProvider`, false);
    const intent = await this.seam.call<AuthorizationIntent>("authorization.preview", { command, arguments: args });
    const decision = await provider.approve(Object.freeze(intent));
    if (!decision.approved) throw new SupercutsSdkError("AUTHORIZATION_DENIED", decision.reason ?? "the approval provider denied this intent", false);
    const approval = await this.seam.call<{ token: string }>("authorization.approve", { challengeId: intent.challengeId });
    return this.seam.call("command.execute", { command, arguments: args, approvalToken: approval.token });
  }
}

const paymentArgs = (input: { operationId: OperationId; amount: bigint; counterparty: string; asset?: string; requestId?: string; broadcastOnly?: boolean; planHash?: string }): Arguments => ({
  "operation-id": input.operationId, amount: input.amount.toString(), counterparty: input.counterparty,
  ...(input.asset ? { asset: input.asset } : {}), ...(input.requestId ? { "request-id": input.requestId } : {}), ...(input.broadcastOnly ? { "broadcast-only": true } : {}), ...(input.planHash ? { "plan-hash": input.planHash } : {}),
});
const payment = (value: any): PaymentReceipt => ({ ...value, amount: BigInt(value.amount) }) as PaymentReceipt;
const queuedExit = (value: any): QueuedExit => ({ ...value, amount: BigInt(value.amount) }) as QueuedExit;
const exitArgs = (input: { operationId: OperationId; commitment: string; amount: bigint; exactExit?: boolean; windowStart: number; windowEnd: number }): Arguments => ({ "operation-id": input.operationId, commitment: input.commitment, amount: input.amount.toString(), "exact-exit": input.exactExit === true, "window-start": String(input.windowStart), "window-end": String(input.windowEnd) });

export class BuyerClient extends RoleClient {
  static async connect(config: SupercutsSdkConfig): Promise<BuyerClient> { const client = new BuyerClient(config); await client.ensureCompatible(); const report = await client.doctor(); if (report.role !== "buyer") throw new SupercutsSdkError("SDK_ROLE_MISMATCH", `expected buyer profile, found ${report.role}`, false); return client; }
  async discoverSellers(capabilities: Capability[]): Promise<Capability[]> { const value = await this.read<{ capabilities: Capability[] }>("capability.discover", { capabilities }); return value.capabilities; }
  async discoverCapabilities(manifests: CapabilityManifest[]): Promise<CapabilityManifest[]> { const value = await this.read<{ capabilities: CapabilityManifest[] }>("capability.discover", { capabilities: manifests }); return value.capabilities; }
  async discoverCapabilityBlobs(blobIds: string[]): Promise<Array<CapabilityManifest & { blobId: string }>> { const value = await this.read<{ capabilities: Array<CapabilityManifest & { blobId: string }> }>("capability.discover", { "blob-ids": blobIds }); return value.capabilities; }
  async planSettlement(input: { operationId: OperationId; manifest: CapabilityManifest; alternatives?: CapabilityManifest[]; requestedAmount?: bigint; privacyHint?: "any" | "shielded" }): Promise<SettlementPlanV1> { return this.mutate("settlement.plan", { "operation-id": input.operationId, manifest: input.manifest, ...(input.alternatives ? { alternatives: input.alternatives } : {}), ...(input.requestedAmount !== undefined ? { "requested-amount": input.requestedAmount.toString() } : {}), ...(input.privacyHint ? { "privacy-hint": input.privacyHint } : {}) }); }
  async deposit(amount: bigint, id: OperationId = operationId(randomUUID())): Promise<TransactionReceipt> { const value = await this.mutate<any>("wallet.deposit", { amount: amount.toString(), "operation-id": id }); return { ...value, amount: BigInt(value.amount) }; }
  async balance(): Promise<WalletBalance> { const value = await this.read<any>("wallet.balance"); return { ...value, available: BigInt(value.available) }; }
  async recover(): Promise<{ recovered: number; source: string }> { return this.mutate("wallet.recover", {}); }
  async withdraw(commitment: string, recipient?: string, id: OperationId = operationId(randomUUID())): Promise<TransactionReceipt> { const value = await this.mutate<any>("wallet.withdraw", { commitment, "operation-id": id, ...(recipient ? { recipient } : {}) }); return { ...value, amount: BigInt(value.amount) }; }
  async queueExit(input: Parameters<typeof exitArgs>[0]): Promise<QueuedExit> { return queuedExit(await this.mutate("wallet.exit.queue", exitArgs(input))); }
  async exitStatus(id: OperationId): Promise<QueuedExit> { return queuedExit(await this.read("wallet.exit.status", { "operation-id": id })); }
  async finalizeExit(id: OperationId, digest: string, approvalId: OperationId = operationId(randomUUID())): Promise<Record<string, unknown>> { return this.mutate("wallet.exit.finalize", { "operation-id": approvalId, "exit-id": id, digest }); }
  async openOffer(session?: SessionId): Promise<OfferState> { return this.mutate("offer.open", session ? { session } : {}); }
  async propose(session: SessionId, revision: number, terms: Readonly<Record<string, JsonValue>>): Promise<OfferState> { return this.mutate("offer.propose", { session, revision, terms: JSON.stringify(terms) }); }
  async accept(session: SessionId, revision: number, terms: Readonly<Record<string, JsonValue>>): Promise<OfferState> { return this.mutate("offer.accept", { session, revision, terms: JSON.stringify(terms) }); }
  async acceptCryptographicAgreement(session: SessionId, agreement: Readonly<Record<string, JsonValue>>, plan?: { planHash: string; manifest: CapabilityManifest }): Promise<{ sessionId: string; revision: string; state: "accepted"; dealCommitment: string; expiry: string; paymentAmount: string }> { return this.mutate("offer.accept", { session, agreement: Buffer.from(JSON.stringify(agreement)).toString("base64url"), ...(plan ? { "plan-hash": plan.planHash, manifest: plan.manifest } : {}) }); }
  async showOffer(session: SessionId): Promise<OfferState> { return this.read("offer.show", { session }); }
  async quote(input: { rail: Rail; amount: bigint; counterparty: string; asset?: string }): Promise<PaymentQuote> { const value = await this.read<any>("pay.quote", { rail: input.rail, amount: input.amount.toString(), counterparty: input.counterparty, ...(input.asset ? { asset: input.asset } : {}) }); return { ...value, amount: BigInt(value.amount) }; }
  async settleShielded(input: Parameters<typeof paymentArgs>[0]): Promise<PaymentReceipt> { return payment(await this.mutate("pay.shielded", paymentArgs(input))); }
  async settleAcceptedShielded(operationId: OperationId, session: SessionId, planHash?: string): Promise<PaymentReceipt> { return payment(await this.mutate("pay.shielded", { "operation-id": operationId, session, ...(planHash ? { "plan-hash": planHash } : {}) })); }
  async payX402(input: Parameters<typeof paymentArgs>[0]): Promise<PaymentReceipt> { return payment(await this.mutate("pay.x402", paymentArgs(input))); }
  async payX402Resource(id: OperationId, resourceUrl: string, planHash?: string): Promise<PaymentReceipt & { response: Uint8Array; responseSha256: string }> { const value = await this.mutate<any>("pay.x402", { "operation-id": id, "resource-url": resourceUrl, ...(planHash ? { "plan-hash": planHash } : {}) }); return { ...value, amount: BigInt(value.amount), response: Buffer.from(value.response, "base64"), responseSha256: String(value.responseSha256) } as PaymentReceipt & { response: Uint8Array; responseSha256: string }; }
  async paymentStatus(operationId: OperationId, reconcile = false): Promise<PaymentReceipt> { return payment(await this.read("pay.status", { "operation-id": operationId, ...(reconcile ? { reconcile: true } : {}) })); }
  async reconcilePayment(operationId: OperationId): Promise<PaymentReceipt> { return this.paymentStatus(operationId, true); }
  async fetchResource(input: { requestId: string; operationId: OperationId; response: Uint8Array }): Promise<{ requestId: string; responseHash: string; body: Uint8Array; deliveryStatus: string }> { const value = await this.read<any>("resource.fetch", { "request-id": input.requestId, "operation-id": input.operationId, response: Buffer.from(input.response).toString("base64") }); return { ...value, body: Buffer.from(value.body, "base64") }; }
  async remember(operationId: OperationId, fact: string): Promise<{ operationId: string; namespace: string; blobId: string; status: string }> { return this.mutate("memory.remember", { "operation-id": operationId, fact }); }
  async rememberSettlement(operationId: OperationId, memory: Omit<SettlementMemoryV1, "provenance">): Promise<{ operationId: string; namespace: string; blobId: string; status: string; provenance: "agent_observation" }> { return this.mutate("memory.remember", { "operation-id": operationId, memory }); }
  async recall(query: string): Promise<{ namespace: string; citations: SettlementCitation[]; effect: string }> { return this.read("memory.recall", { query }); }
  async memoryStatus(): Promise<MemoryStatus> { return this.read("memory.status"); }
  async requestDisclosure(input: { dealId: string; auditor: string; paymentDigest: TransactionDigest; transcriptRoot: string }): Promise<DisclosureReference> { return this.mutate("disclose", { "deal-id": input.dealId, auditor: input.auditor, "payment-digest": input.paymentDigest, "transcript-root": input.transcriptRoot }); }
}

export class SellerClient extends RoleClient {
  static async connect(config: SupercutsSdkConfig): Promise<SellerClient> { const client = new SellerClient(config); await client.ensureCompatible(); const report = await client.doctor(); if (report.role !== "seller") throw new SupercutsSdkError("SDK_ROLE_MISMATCH", `expected seller profile, found ${report.role}`, false); return client; }
  async publishCapability(input: { capabilityId?: string; seller: string; service: string; terms: string }): Promise<Capability> { return this.mutate("capability.publish", { ...(input.capabilityId ? { "capability-id": input.capabilityId } : {}), seller: input.seller, service: input.service, terms: input.terms }); }
  async publishManifest(manifest: CapabilityManifest, id: OperationId = operationId(randomUUID())): Promise<CapabilityManifest & { blobId: string; visibility: "public-capability" }> { return this.mutate("capability.publish", { manifest, "operation-id": id }); }
  async counter(session: SessionId, revision: number, terms: Readonly<Record<string, JsonValue>>): Promise<OfferState> { return this.mutate("offer.counter", { session, revision, terms: JSON.stringify(terms) }); }
  async prepareCryptographicAgreement(session: SessionId, draft: Readonly<Record<string, JsonValue>>): Promise<{ sessionId: string; revision: string; state: "counter"; dealCommitment: string; agreement: string }> { return this.mutate("offer.counter", { session, agreement: Buffer.from(JSON.stringify(draft)).toString("base64url") }); }
  async showOffer(session: SessionId): Promise<OfferState> { return this.read("offer.show", { session }); }
  async paymentStatus(operationId: OperationId): Promise<PaymentReceipt> { return payment(await this.read("pay.status", { "operation-id": operationId })); }
  async recoverPayment(commitment: string, amount: bigint): Promise<{ recovered: number; source: string }> { return this.mutate("wallet.recover", { commitment, amount: amount.toString() }); }
  async balance(): Promise<WalletBalance> { const value = await this.read<any>("wallet.balance"); return { ...value, available: BigInt(value.available) }; }
  async withdraw(commitment: string, recipient?: string, id: OperationId = operationId(randomUUID())): Promise<TransactionReceipt> { const value = await this.mutate<any>("wallet.withdraw", { commitment, "operation-id": id, ...(recipient ? { recipient } : {}) }); return { ...value, amount: BigInt(value.amount) }; }
  async queueExit(input: Parameters<typeof exitArgs>[0]): Promise<QueuedExit> { return queuedExit(await this.mutate("wallet.exit.queue", exitArgs(input))); }
  async exitStatus(id: OperationId): Promise<QueuedExit> { return queuedExit(await this.read("wallet.exit.status", { "operation-id": id })); }
  async finalizeExit(id: OperationId, digest: string, approvalId: OperationId = operationId(randomUUID())): Promise<Record<string, unknown>> { return this.mutate("wallet.exit.finalize", { "operation-id": approvalId, "exit-id": id, digest }); }
  async serveResource(requestId: string, body: Uint8Array): Promise<{ requestId: string; responseHash: string; deliveryStatus: string }> { return this.mutate("resource.serve", { "request-id": requestId, body: Buffer.from(body).toString("base64") }); }
  async fetchResource(input: { requestId: string; operationId: OperationId; response: Uint8Array }): Promise<{ requestId: string; responseHash: string; body: Uint8Array; deliveryStatus: string }> { const value = await this.read<any>("resource.fetch", { "request-id": input.requestId, "operation-id": input.operationId, response: Buffer.from(input.response).toString("base64") }); return { ...value, body: Buffer.from(value.body, "base64") }; }
  async remember(operationId: OperationId, fact: string): Promise<{ operationId: string; namespace: string; blobId: string; status: string }> { return this.mutate("memory.remember", { "operation-id": operationId, fact }); }
  async recall(query: string): Promise<{ namespace: string; citations: SettlementCitation[]; effect: string }> { return this.read("memory.recall", { query }); }
  async memoryStatus(): Promise<MemoryStatus> { return this.read("memory.status"); }
}

export class AuditorClient extends RoleClient {
  static async connect(config: SupercutsSdkConfig): Promise<AuditorClient> { const client = new AuditorClient(config); await client.ensureCompatible(); const report = await client.doctor(); if (report.role !== "auditor") throw new SupercutsSdkError("SDK_ROLE_MISMATCH", `expected auditor profile, found ${report.role}`, false); return client; }
  async verify(input: { package: string; auditor: string; dealId: string }): Promise<AuditResult> { return this.read("audit.verify", { package: input.package, auditor: input.auditor, "deal-id": input.dealId }); }
}

export async function initializeProfile(config: Omit<SupercutsSdkConfig, "approvalProvider">, options: InitializeOptions): Promise<{ role: Role; home: string; network: "testnet"; mock: boolean }> {
  const seam = new Seam(config);
  const version = await seam.call<{ protocol: number; packageVersion: string }>("version", undefined, false);
  if (version.protocol !== SEAM_PROTOCOL || version.packageVersion !== SDK_VERSION) throw new SeamUnavailable("installed Supercuts backend is incompatible with this SDK");
  const live = options.mock === true ? {} : { "deployment-config": options.deploymentConfig, "sui-key-file": options.suiKeyFile, "tatum-key-file": options.tatumKeyFile, "write-grpc": options.writeGrpc, "tatum-grpc": options.tatumGrpc, ...(options.snarkjsPath ? { snarkjs: options.snarkjsPath } : {}), ...(options.converterPath ? { converter: options.converterPath } : {}), ...(options.rapidsnarkPath ? { rapidsnark: options.rapidsnarkPath } : {}), ...(options.memoryConfigFile ? { "memory-config-file": options.memoryConfigFile } : {}), ...(options.walrusPublisher ? { "walrus-publisher": options.walrusPublisher } : {}), ...(options.walrusAggregator ? { "walrus-aggregator": options.walrusAggregator } : {}) };
  return seam.call("initialize", { role: options.role, ...(options.mock ? { mock: true } : live), ...(options.mock && options.artifactManifest ? { "artifact-manifest": options.artifactManifest } : {}), ...(options.maxAmount !== undefined ? { "max-amount": options.maxAmount.toString() } : {}), ...(options.allowedCounterparties ? { "allow-counterparty": options.allowedCounterparties.join(",") } : {}), ...(options.requireShielded ? { "require-shielded": true } : {}), ...(options.maxMemoryDistance !== undefined ? { "max-memory-distance": String(options.maxMemoryDistance) } : {}) });
}
