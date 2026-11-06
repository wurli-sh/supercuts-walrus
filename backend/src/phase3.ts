import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadStateKey } from "./config.js";
import { fail, SupercutsError } from "./errors.js";
import { RoleStore } from "./store.js";
import { DealJournal } from "./deal.js";
import { LiveRuntime, type LiveRuntimeProfile } from "./live-runtime.js";
import { V2ExitQueue } from "./v2-exits.js";
import { validateCapabilityManifest, type CapabilityManifest, type CapabilityRail } from "./capability.js";
import { ManualMemory, openMemoryText, withMemoryDefaults, type ManualMemoryConfig } from "./memwal.js";
import { WorkflowMemory } from "./workflow-memory.js";
import { buildScorecard, type SellerScorecard } from "./memory-scorecard.js";
import { canonicalJson, createSettlementPlan, explainMemoryInfluence, isRelevantMemory, settlementMandateHash, settlementPlanHash, validateSettlementMemory, validateSettlementPlan, type MemoryInfluence, type PlanningMandate, type RecalledSettlementMemory, type SettlementMemoryV1, type SettlementPlanV1 } from "./settlement.js";

export type Role = "buyer" | "seller" | "auditor";
export interface Profile {
  version: 1 | 2; role: Role; network: "testnet"; mock: boolean;
  packageId: string; poolId: string; coinType: string; verifierVersion: number;
  artifactManifest: string; artifactManifestSha256: string;
  policy: { maxAmount: string; allowedAssets: string[]; allowedCounterparties: string[]; requiredPrivacy: "any" | "shielded"; expiresAt: number; maxMemoryDistance?: number };
  live?: LiveRuntimeProfile["live"];
}
export interface CommandResult { schemaVersion: "supercuts.v1"; ok: true; command: string; data: Record<string, unknown>; }
export interface AuthorizationIntent {
  challengeId: string; intentHash: string; role: Role; command: string;
  summary: string; parameters: Record<string, string | boolean>; expiresAt: number;
}
export interface ApprovalToken { token: string; expiresAt: number; intentHash: string; }

const PACKAGE = "0xf887433ddfd1068f6df3020cd757939b99ceb418f0d8b9924092b01c7aee846e";
const POOL = "0x873e37b4745316f21a2780893f5fc36f87da559b08923fb4dad6237cd2e95d98";
const V2_PACKAGE = "0x32d104c1ab422d497df4ae3a6861258694949c86428f886ca338e07bd055cf76";
const V2_POOL = "0x8fd22140c906495bb5334a497dcdd9112479c638e21c5df4b4cfb66f633a106b";
const V2_RELAYER = "0x405f473ed1f7f609b16d3d7dabc7cd04831cfc73b4a7fcebe9fa502d72e357a3";
const COIN = "0x2::sui::SUI";
const WRITE = new Set(["wallet.deposit", "wallet.recover", "wallet.withdraw", "wallet.exit.queue", "wallet.exit.finalize", "offer.open", "offer.propose", "offer.counter", "offer.accept", "pay.shielded", "pay.x402", "resource.serve", "memory.remember", "disclose", "capability.publish", "settlement.plan", "settlement.approve-review", "memory.policy"]);
const ROLE_COMMANDS: Record<Role, ReadonlySet<string>> = {
  buyer: new Set(["status", "doctor", "capability.discover", "settlement.plan", "settlement.approve-review", "memory.policy", "wallet.deposit", "wallet.balance", "wallet.recover", "wallet.withdraw", "wallet.exit.queue", "wallet.exit.status", "wallet.exit.finalize", "offer.open", "offer.propose", "offer.accept", "offer.show", "pay.quote", "pay.shielded", "pay.x402", "pay.status", "resource.fetch", "memory.remember", "memory.recall", "memory.status", "memory.inventory", "remote.catalog", "remote.rank-briefs", "remote.negotiate", "remote.quote", "remote.purchase-brief", "remote.agreement", "remote.settle-analysis", "remote.delivery", "remote.events", "remote.research", "disclose"]),
  seller: new Set(["status", "doctor", "capability.publish", "wallet.balance", "wallet.recover", "wallet.withdraw", "wallet.exit.queue", "wallet.exit.status", "wallet.exit.finalize", "offer.counter", "offer.show", "pay.status", "resource.serve", "resource.fetch", "memory.remember", "memory.recall", "memory.status", "memory.inventory"]),
  auditor: new Set(["status", "doctor", "audit.verify"]),
};

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function required(args: Record<string, string | boolean>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value) fail("ARGUMENT_REQUIRED", `--${name} is required`);
  return value as string;
}
function amount(args: Record<string, string | boolean>): bigint {
  const value = required(args, "amount");
  if (!/^[1-9][0-9]*$/.test(value)) fail("AMOUNT_INVALID", "amount must be a positive integer");
  return BigInt(value);
}
function matchesPlannedEndpoint(planned: string, actual: string, requestId: string): boolean {
  if (planned === actual) return true;
  try {
    const base = new URL(planned), resource = new URL(actual);
    return base.origin === resource.origin && !base.search && !base.hash && !resource.search && !resource.hash &&
      resource.pathname === `${base.pathname.replace(/\/$/, "")}/${encodeURIComponent(requestId)}`;
  } catch { return false; }
}
const memoryQuery = (manifest: CapabilityManifest): string => `${manifest.capabilityId} ${manifest.capability} ${manifest.sellerId}`;
function record(store: RoleStore, scope: string, id: string, value: unknown): void {
  store.db.prepare("INSERT INTO app_records(scope,id,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
    .run(scope, id, json(value), Date.now());
}
function get<T>(store: RoleStore, scope: string, id: string): T | undefined {
  const row = store.db.prepare("SELECT value FROM app_records WHERE scope=? AND id=?").get(scope, id) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as T : undefined;
}
function all<T>(store: RoleStore, scope: string): T[] {
  return (store.db.prepare("SELECT value FROM app_records WHERE scope=? ORDER BY updated_at,id").all(scope) as Array<{ value: string }>).map((row) => JSON.parse(row.value) as T);
}

export function parseArgs(values: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < values.length; i++) {
    const token = values[i]!;
    if (!token.startsWith("--") || token.length <= 2 || token.length > 130) fail("ARGUMENT_INVALID", "arguments must be named --options of at most 128 characters");
    const key = token.slice(2);
    if (!/^[a-z][a-z0-9-]*$/.test(key) || key in result) fail("ARGUMENT_INVALID", `invalid or repeated option --${key}`);
    const next = values[i + 1];
    if (next && !next.startsWith("--")) { if (Buffer.byteLength(next) > 1024 * 1024) fail("ARGUMENT_INVALID", `--${key} exceeds 1 MiB`); result[key] = next; i++; } else result[key] = true;
  }
  return result;
}

export function homePath(args: Record<string, string | boolean>, env = process.env): string {
  const selected = args.home ?? env.SUPERCUTS_HOME;
  return resolve(typeof selected === "string" ? selected : join(env.HOME ?? process.cwd(), ".supercuts"));
}

export function initialize(home: string, args: Record<string, string | boolean>): CommandResult {
  const role = required(args, "role") as Role;
  if (!(["buyer", "seller", "auditor"] as string[]).includes(role)) fail("ROLE_INVALID", "role must be buyer, seller, or auditor");
  if (existsSync(join(home, "profile.json"))) fail("PROFILE_EXISTS", `${home} is already initialized`);
  mkdirSync(home, { recursive: true, mode: 0o700 }); chmodSync(home, 0o700);
  const isMock = args.mock === true;
  const deploymentPath = isMock ? undefined : resolve(required(args, "deployment-config"));
  const deployment = deploymentPath ? JSON.parse(readFileSync(deploymentPath, "utf8")) as Record<string, unknown> : undefined;
  if (deployment && (deployment.network !== "testnet" || deployment.testOnly !== true || deployment.coinType !== COIN || !((deployment.packageId === PACKAGE && deployment.poolId === POOL && deployment.verifierVersion === 1) || (deployment.packageId === V2_PACKAGE && deployment.poolId === V2_POOL && deployment.verifierVersion === 2)))) fail("DEPLOYMENT_ID_MISMATCH", "live initialization requires a pinned Testnet pool deployment");
  const manifestValue = String(deployment?.artifactManifest ?? "");
  const manifest = isMock ? (typeof args["artifact-manifest"] === "string" ? resolve(args["artifact-manifest"]) : "mock:pinned-phase1") : (() => { if (!manifestValue) return fail("CONFIG_INVALID", "deployment artifactManifest is missing"); if (isAbsolute(manifestValue)) return manifestValue; const candidates = [resolve(manifestValue), resolve(dirname(deploymentPath!), "..", manifestValue)]; return candidates.find(existsSync) ?? fail("PROVING_ARTIFACT_MISSING", "deployment artifact manifest could not be resolved"); })();
  const manifestHash = manifest.startsWith("mock:") ? hash(manifest) : hash(readFileSync(manifest));
  const endpoint = (name: string): string => { const value = required(args, name); return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`; };
  const credential = (name: string): Buffer => { const path = resolve(required(args, name)); if ((statSync(path).mode & 0o077) !== 0) fail("CREDENTIAL_PERMISSIONS", `${name} must be owner-only`); const value = readFileSync(path); if (!value.length || value.length > 4096) fail("CREDENTIAL_INVALID", `${name} is empty or too large`); return Buffer.from(value.toString().trim()); };
  const liveCredentials = deployment ? { sui: credential("sui-key-file"), tatum: credential("tatum-key-file"), ...(typeof args["memory-config-file"] === "string" ? { memory: credential("memory-config-file") } : {}) } : undefined;
  if (liveCredentials?.memory) {
    let memoryConfig: ManualMemoryConfig; try { memoryConfig = withMemoryDefaults(JSON.parse(liveCredentials.memory.toString()) as Partial<ManualMemoryConfig>, role); } catch (error) { return fail("LIVE_MEMORY_CONFIG_INVALID", `memory config is invalid: ${error instanceof TypeError ? error.message : "not valid JSON"}`, error); }
    liveCredentials.memory = Buffer.from(JSON.stringify(memoryConfig));
    let embedding: URL; try { embedding = new URL(memoryConfig.embeddingApiBase); } catch (error) { return fail("LIVE_MEMORY_CONFIG_INVALID", "embeddingApiBase is invalid", error); }
    if (!["localhost", "127.0.0.1", "::1"].includes(embedding.hostname)) fail("LIVE_MEMORY_EMBEDDING_UNTRUSTED", "live memory embeddings must use the loopback 1536-dimension adapter");
  }
  const artifactRoot = manifest.startsWith("mock:") ? "" : resolve(manifest, "..");
  const circuitsRoot = artifactRoot ? resolve(artifactRoot, deployment?.verifierVersion === 2 ? "../.." : "..") : "";
  const repositoryRoot = circuitsRoot ? resolve(circuitsRoot, "..") : "";
  const live = deployment ? {
    coinTypeHash: String(deployment.coinTypeHash), deploymentDomain: String(deployment.deploymentDomain), initialRoot: String(deployment.initialRoot), deploymentCheckpoint: String(deployment.deploymentCheckpoint),
    writeGrpcEndpoint: endpoint("write-grpc"), tatumGrpcEndpoint: endpoint("tatum-grpc"), artifactRoot,
    ...(typeof args["walrus-publisher"] === "string" ? { walrusPublisherUrl: endpoint("walrus-publisher") } : {}),
    ...(typeof args["walrus-aggregator"] === "string" ? { walrusAggregatorUrl: endpoint("walrus-aggregator") } : {}),
    snarkjsPath: typeof args["snarkjs"] === "string" ? resolve(args["snarkjs"]) : resolve(circuitsRoot, "node_modules/.bin/snarkjs"), converterPath: typeof args.converter === "string" ? resolve(args.converter) : resolve(repositoryRoot, "target/debug/supercuts-groth16"),
    ...(typeof args.rapidsnark === "string" ? { rapidsnarkPath: resolve(args.rapidsnark) } : {}),
    artifacts: Object.fromEntries(Object.entries(deployment.artifacts as Record<string, { zkeySha256: string; verifyingKeySha256: string }>).map(([name, item]) => [name, { zkeySha256: item.zkeySha256, verifyingKeySha256: item.verifyingKeySha256 }])) as LiveRuntimeProfile["live"]["artifacts"],
  } : undefined;
  const profile: Profile = {
    version: isMock ? 1 : 2, role, network: "testnet", mock: isMock, packageId: deployment ? String(deployment.packageId) : PACKAGE, poolId: deployment ? String(deployment.poolId) : POOL, coinType: deployment ? String(deployment.coinType) : COIN, verifierVersion: deployment ? Number(deployment.verifierVersion) : 1,
    artifactManifest: manifest, artifactManifestSha256: manifestHash,
    policy: {
      maxAmount: typeof args["max-amount"] === "string" ? args["max-amount"] : "1000000000",
      allowedAssets: [COIN],
      allowedCounterparties: typeof args["allow-counterparty"] === "string" ? args["allow-counterparty"].split(",") : ["seller-a", "seller-b"],
      requiredPrivacy: args["require-shielded"] === true ? "shielded" : "any",
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      maxMemoryDistance: (() => { const value = typeof args["max-memory-distance"] === "string" ? Number(args["max-memory-distance"]) : 0.35; if (!Number.isFinite(value) || value < 0 || value > 1) return fail("POLICY_MEMORY_DISTANCE_INVALID", "max-memory-distance must be in [0,1]"); return value; })(),
    }, ...(live ? { live } : {}),
  };
  writeFileSync(join(home, "profile.json"), `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  const mandate = {
    version: "supercuts.mandate.v1", owner: "local-operator", role,
    allowedCommands: [...ROLE_COMMANDS[role]].filter((name) => name !== "settlement.approve-review" && name !== "memory.policy"), allowedCounterparties: profile.policy.allowedCounterparties,
    allowedAssets: profile.policy.allowedAssets, perDealCeiling: profile.policy.maxAmount,
    totalRunBudget: (BigInt(profile.policy.maxAmount) * 100n).toString(), requiredPrivacy: profile.policy.requiredPrivacy,
    expiresAt: profile.policy.expiresAt,
  };
  writeFileSync(join(home, "mandate.json"), `${JSON.stringify(mandate, null, 2)}\n`, { mode: 0o600 });
  const stateKey = randomBytes(32); writeFileSync(join(home, "state.key"), stateKey, { mode: 0o600 });
  if (live) {
    const store = new RoleStore(join(home, "state.sqlite"), stateKey);
    try {
      store.putSecretOnce("live:sui-private-key", liveCredentials!.sui); store.putSecretOnce("live:tatum-api-key", liveCredentials!.tatum); if (liveCredentials!.memory) store.putSecretOnce("live:memory-config", liveCredentials!.memory); store.putSecretOnce("identity:babyjub-seed", randomBytes(32));
      const pair = generateKeyPairSync("x25519"); store.putSecretOnce("identity:x25519-private", pair.privateKey.export({ type: "pkcs8", format: "der" })); store.putSecretOnce("identity:x25519-public", pair.publicKey.export({ type: "spki", format: "der" }));
    } finally { store.close(); }
  }
  return output("init", { role, home, network: profile.network, mock: profile.mock });
}

export class Phase3App {
  readonly profile: Profile; readonly store: RoleStore; readonly #authorizationKey: Buffer;
  constructor(readonly home: string) {
    const profilePath = join(home, "profile.json");
    if (!existsSync(profilePath)) fail("PROFILE_NOT_FOUND", `run supercuts init for ${home}`);
    if ((statSync(home).mode & 0o077) !== 0 || (statSync(profilePath).mode & 0o077) !== 0) fail("STATE_PERMISSIONS", "profile and state directory must be owner-only");
    this.profile = JSON.parse(readFileSync(profilePath, "utf8")) as Profile;
    this.store = new RoleStore(join(home, "state.sqlite"), loadStateKey(join(home, "state.key")));
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS app_records(scope TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS authorization_intents(challenge_id TEXT PRIMARY KEY,intent_hash TEXT NOT NULL,command TEXT NOT NULL,parameters TEXT NOT NULL,expires_at INTEGER NOT NULL,approved INTEGER NOT NULL DEFAULT 0,used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS authorized_operations(operation_id TEXT PRIMARY KEY,intent_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
    `);
    const existingAuthorizationKey = this.store.getSecret("authorization:mac-key");
    if (existingAuthorizationKey) this.#authorizationKey = existingAuthorizationKey;
    else { this.#authorizationKey = randomBytes(32); this.store.putSecretOnce("authorization:mac-key", this.#authorizationKey); }
  }
  close(): void { this.store.close(); }

  private normalizedIntent(command: string, args: Record<string, string | boolean>): { parameters: Record<string, string | boolean>; intentHash: string } {
    const parameters = Object.fromEntries(Object.entries(args).filter(([key]) => !["authorize", "approval-token", "home"].includes(key)).sort(([a], [b]) => a.localeCompare(b)));
    return { parameters, intentHash: hash(canonical({ domain: "supercuts-authorization-v1", role: this.profile.role, packageId: this.profile.packageId, poolId: this.profile.poolId, command, parameters })) };
  }
  preview(command: string, args: Record<string, string | boolean>, ttlMs = 60_000): AuthorizationIntent {
    if (!ROLE_COMMANDS[this.profile.role].has(command)) fail("ROLE_FORBIDDEN", `${this.profile.role} cannot invoke ${command}`);
    if (!WRITE.has(command)) fail("AUTHORIZATION_NOT_REQUIRED", `${command} is read-only`);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 300_000) fail("AUTHORIZATION_TTL_INVALID", "authorization TTL must be between 1 and 300 seconds");
    const { parameters, intentHash } = this.normalizedIntent(command, args);
    const serialized = canonical(parameters);
    if (Buffer.byteLength(serialized) > 64 * 1024) fail("AUTHORIZATION_INTENT_TOO_LARGE", "authorization intent exceeds 64 KiB");
    this.store.db.prepare("DELETE FROM authorization_intents WHERE expires_at < ? OR (used=1 AND expires_at < ?)").run(Date.now(), Date.now() + 1);
    const pending = this.store.db.prepare("SELECT COUNT(*) AS count FROM authorization_intents WHERE used=0 AND expires_at>=?").get(Date.now()) as { count: number };
    if (pending.count >= 1024) fail("AUTHORIZATION_LIMIT", "too many pending authorization intents");
    const challengeId = `auth_${randomBytes(18).toString("base64url")}`, expiresAt = Date.now() + ttlMs;
    this.store.db.prepare("INSERT INTO authorization_intents(challenge_id,intent_hash,command,parameters,expires_at) VALUES(?,?,?,?,?)")
      .run(challengeId, intentHash, command, serialized, expiresAt);
    return { challengeId, intentHash, role: this.profile.role, command, summary: `${this.profile.role} authorizes ${command}`, parameters, expiresAt };
  }
  approve(challengeId: string): ApprovalToken {
    const row = this.store.db.prepare("SELECT intent_hash,expires_at,approved,used FROM authorization_intents WHERE challenge_id=?").get(challengeId) as { intent_hash: string; expires_at: number; approved: number; used: number } | undefined;
    if (!row) return fail("AUTHORIZATION_NOT_FOUND", "authorization challenge was not found");
    if (row.used) fail("AUTHORIZATION_REPLAY", "authorization challenge was already consumed");
    if (Date.now() > row.expires_at) fail("AUTHORIZATION_EXPIRED", "authorization challenge has expired");
    this.store.db.prepare("UPDATE authorization_intents SET approved=1 WHERE challenge_id=?").run(challengeId);
    const payload = Buffer.from(canonical({ challengeId, intentHash: row.intent_hash, expiresAt: row.expires_at })).toString("base64url");
    const signature = createHmac("sha256", this.#authorizationKey).update(payload).digest("base64url");
    return { token: `${payload}.${signature}`, expiresAt: row.expires_at, intentHash: row.intent_hash };
  }
  private validateApproval(command: string, args: Record<string, string | boolean>): void {
    const normalized = this.normalizedIntent(command, args), operationId = typeof args["operation-id"] === "string" ? args["operation-id"] : undefined;
    const authorizationOperationId = operationId && (command === "settlement.plan" || command === "settlement.approve-review") ? `${command}:${operationId}` : operationId;
    if (authorizationOperationId) {
      const durable = this.store.db.prepare("SELECT intent_hash FROM authorized_operations WHERE operation_id=?").get(authorizationOperationId) as { intent_hash: string } | undefined;
      if (durable) {
        if (durable.intent_hash !== normalized.intentHash) fail("OPERATION_ID_CONFLICT", "operation ID already identifies another authorized intent");
        return;
      }
    }
    const encoded = args["approval-token"];
    if (typeof encoded !== "string") return fail("LOCAL_AUTH_REQUIRED", `${command} requires a bound approval token`);
    const pieces = encoded.split(".");
    if (pieces.length !== 2) fail("AUTHORIZATION_INVALID", "approval token has an invalid shape");
    const [payload, provided] = pieces as [string, string];
    const wanted = createHmac("sha256", this.#authorizationKey).update(payload).digest();
    let supplied: Buffer; try { supplied = Buffer.from(provided, "base64url"); } catch { return fail("AUTHORIZATION_INVALID", "approval token signature is invalid"); }
    if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) fail("AUTHORIZATION_INVALID", "approval token signature is invalid");
    let token: { challengeId: string; intentHash: string; expiresAt: number };
    try { token = JSON.parse(Buffer.from(payload, "base64url").toString()) as typeof token; } catch (error) { return fail("AUTHORIZATION_INVALID", "approval token payload is invalid", error); }
    if (token.intentHash !== normalized.intentHash || Date.now() > token.expiresAt) fail(token.intentHash === normalized.intentHash ? "AUTHORIZATION_EXPIRED" : "AUTHORIZATION_INTENT_MISMATCH", "approval token does not authorize this exact request");
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.store.db.prepare("SELECT intent_hash,command,expires_at,approved,used FROM authorization_intents WHERE challenge_id=?").get(token.challengeId) as { intent_hash: string; command: string; expires_at: number; approved: number; used: number } | undefined;
      if (!row || !row.approved || row.command !== command || row.intent_hash !== token.intentHash) return fail("AUTHORIZATION_INVALID", "approval token is not backed by an approved intent");
      if (row.used && !operationId) fail("AUTHORIZATION_REPLAY", "approval token was already consumed");
      if (Date.now() > row.expires_at) fail("AUTHORIZATION_EXPIRED", "approval token has expired");
      this.store.db.prepare("UPDATE authorization_intents SET used=1 WHERE challenge_id=?").run(token.challengeId);
      if (authorizationOperationId) this.store.db.prepare("INSERT INTO authorized_operations(operation_id,intent_hash,created_at) VALUES(?,?,?)").run(authorizationOperationId, normalized.intentHash, Date.now());
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
  }
  private allow(command: string, args: Record<string, string | boolean>): void {
    if (!ROLE_COMMANDS[this.profile.role].has(command)) fail("ROLE_FORBIDDEN", `${this.profile.role} cannot invoke ${command}`);
    if (WRITE.has(command) && args.authorize !== true) this.validateApproval(command, args);
  }
  private paymentPolicy(args: Record<string, string | boolean>, rail: "shielded" | "x402"): { amount: bigint; counterparty: string; asset: string } {
    const value = amount(args), counterparty = required(args, "counterparty"), asset = typeof args.asset === "string" ? args.asset : this.profile.coinType;
    if (Date.now() > this.profile.policy.expiresAt) fail("POLICY_EXPIRED", "payment policy has expired");
    if (value > BigInt(this.profile.policy.maxAmount)) fail("POLICY_AMOUNT_EXCEEDED", "payment exceeds the configured cap");
    if (!this.profile.policy.allowedAssets.includes(asset)) fail("POLICY_ASSET_FORBIDDEN", "asset is not allowed by policy");
    if (!this.profile.policy.allowedCounterparties.includes(counterparty)) fail("POLICY_COUNTERPARTY_FORBIDDEN", "counterparty is not allowed by policy");
    if (this.profile.policy.requiredPrivacy === "shielded" && rail !== "shielded") fail("POLICY_PRIVACY_REQUIRED", "policy requires shielded settlement");
    return { amount: value, counterparty, asset };
  }
  private doctor(): Record<string, unknown> {
    if (this.profile.packageId !== PACKAGE || this.profile.poolId !== POOL || this.profile.coinType !== COIN || this.profile.verifierVersion !== 1) fail("DEPLOYMENT_ID_MISMATCH", "profile deployment identifiers differ from the pinned Phase 1 deployment; signing and proving are disabled");
    const actual = this.profile.artifactManifest.startsWith("mock:") ? hash(this.profile.artifactManifest) : hash(readFileSync(this.profile.artifactManifest));
    if (actual !== this.profile.artifactManifestSha256) fail("ARTIFACT_HASH_MISMATCH", "artifact manifest differs from the pinned hash; signing and proving are disabled");
    return { role: this.profile.role, network: this.profile.network, packageId: this.profile.packageId, poolId: this.profile.poolId, asset: this.profile.coinType, verifierVersion: this.profile.verifierVersion, artifactManifestSha256: actual, keyPermissions: "owner-only", rpc: "mock-not-funded", healthy: true };
  }

  private planningMandate(args: Record<string, string | boolean>): PlanningMandate {
    let raw: unknown;
    if (typeof args["mandate-json"] === "string") {
      try { raw = JSON.parse(Buffer.from(args["mandate-json"], "base64url").toString()); } catch (error) { return fail("MANDATE_INVALID", "encoded planning mandate is invalid", error); }
    } else {
      try { raw = JSON.parse(readFileSync(join(this.home, "mandate.json"), "utf8")); } catch (error) { return fail("MANDATE_INVALID", "owner mandate could not be loaded", error); }
    }
    const mandate = raw as PlanningMandate;
    if (!mandate || !["supercuts.mandate.v1", "supercuts.mandate.v2"].includes(mandate.version) || !Array.isArray(mandate.allowedCounterparties) || !Array.isArray(mandate.allowedAssets) || !/^(?:0|[1-9][0-9]*)$/.test(mandate.perDealCeiling) || !Number.isSafeInteger(mandate.expiresAt) || mandate.version === "supercuts.mandate.v2" && mandate.allowPublicX402 !== undefined && typeof mandate.allowPublicX402 !== "boolean") fail("MANDATE_INVALID", "planning mandate has an invalid shape");
    return mandate;
  }

  private storedPlan(planHash: string): SettlementPlanV1 {
    const row = this.store.db.prepare("SELECT plan_json FROM settlement_plans WHERE plan_hash=?").get(planHash) as { plan_json: string } | undefined;
    if (!row) return fail("SETTLEMENT_PLAN_NOT_FOUND", "settlement plan hash was not found in this role home");
    let plan: unknown; try { plan = JSON.parse(row.plan_json); } catch (error) { return fail("SETTLEMENT_PLAN_CORRUPT", "stored settlement plan is invalid JSON", error); }
    validateSettlementPlan(plan); if (plan.planHash !== planHash) fail("SETTLEMENT_PLAN_HASH_MISMATCH", "requested hash does not resolve to the identical stored plan"); return plan;
  }

  private persistPlan(plan: SettlementPlanV1): SettlementPlanV1 {
    validateSettlementPlan(plan); const serialized = canonicalJson(plan);
    const existing = this.store.db.prepare("SELECT plan_hash,plan_json FROM settlement_plans WHERE operation_id=?").get(plan.operationId) as { plan_hash: string; plan_json: string } | undefined;
    if (existing) { if (existing.plan_hash !== plan.planHash || existing.plan_json !== serialized) fail("OPERATION_ID_CONFLICT", "planning operation already identifies another immutable plan"); return this.storedPlan(existing.plan_hash); }
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db.prepare("INSERT INTO settlement_plans(plan_hash,operation_id,plan_json,status,expires_at,created_at) VALUES(?,?,?,?,?,?)").run(plan.planHash, plan.operationId, serialized, plan.status, plan.expiresAt, plan.createdAt);
      this.store.db.prepare("INSERT INTO settlement_decision_traces(plan_hash,mandate_hash,manifest_hash,risk_level,reason_codes,citations,created_at) VALUES(?,?,?,?,?,?,?)").run(plan.planHash, plan.mandateHash, plan.manifestHash, plan.riskLevel, JSON.stringify(plan.reasonCodes), JSON.stringify(plan.citations.map(({ blobId, distance }) => ({ blobId, distance }))), plan.createdAt);
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
    return plan;
  }

  private recalledMockMemories(): RecalledSettlementMemory[] {
    return [...all<Record<string, unknown>>(this.store, "memory"), ...all<Record<string, unknown>>(this.store, "verified-memory")].map((item) => {
      if (item.memory && typeof item.memory === "object") return { blobId: String(item.blobId), distance: 0, memory: this.authenticatedMemory(String(item.blobId), item.memory as SettlementMemoryV1) };
      return { blobId: String(item.blobId), distance: 0, legacy: true };
    });
  }

  /** Trusted provenance needs local authority or this owner's memory-key signature (portable across machines). */
  private authenticatedMemory(blobId: string, memory: SettlementMemoryV1, signedByOwner = false): SettlementMemoryV1 {
    if (memory.provenance !== "owner_policy" && memory.provenance !== "verified_outcome") return memory;
    if (signedByOwner && (memory.provenance !== "verified_outcome" || memory.evidenceHash)) { this.registerMemoryAuthority(blobId, memory); return memory; }
    const authority = this.store.db.prepare("SELECT fact_hash,provenance,evidence_hash FROM memory_authority WHERE blob_id=?").get(blobId) as { fact_hash: string; provenance: string; evidence_hash: string | null } | undefined;
    if (authority?.fact_hash === hash(canonicalJson(memory)) && authority.provenance === memory.provenance && (memory.provenance !== "verified_outcome" || authority.evidence_hash === memory.evidenceHash)) return memory;
    return { ...memory, provenance: "legacy_untrusted" };
  }

  private registerMemoryAuthority(blobId: string, memory: SettlementMemoryV1): void {
    if (memory.provenance !== "owner_policy" && memory.provenance !== "verified_outcome") return;
    this.store.db.prepare("INSERT INTO memory_authority(blob_id,fact_hash,provenance,evidence_hash,created_at) VALUES(?,?,?,?,?) ON CONFLICT(blob_id) DO NOTHING")
      .run(blobId, hash(canonicalJson(memory)), memory.provenance, memory.evidenceHash ?? null, Date.now());
  }

  private async planSettlement(args: Record<string, string | boolean>): Promise<Record<string, unknown>> {
    let primary: CapabilityManifest, alternatives: CapabilityManifest[] = [];
    const parseArgument = (value: string): unknown => { try { return JSON.parse(Buffer.from(value, "base64url").toString()); } catch { return JSON.parse(value); } };
    try { primary = parseArgument(required(args, "manifest")) as CapabilityManifest; } catch (error) { return fail("CAPABILITY_INVALID", "primary manifest is not JSON", error); }
    validateCapabilityManifest(primary);
    if (typeof args.alternatives === "string") { try { alternatives = parseArgument(args.alternatives) as CapabilityManifest[]; } catch (error) { return fail("CAPABILITY_LIST_INVALID", "alternative manifests are not JSON", error); } }
    if (!Array.isArray(alternatives)) fail("CAPABILITY_LIST_INVALID", "alternatives must be an array"); for (const item of alternatives) validateCapabilityManifest(item);
    const operationId = required(args, "operation-id"), mandate = this.planningMandate(args);
    const persisted = this.store.db.prepare("SELECT plan_hash FROM settlement_plans WHERE operation_id=?").get(operationId) as { plan_hash: string } | undefined;
    if (persisted) {
      const existing = this.storedPlan(persisted.plan_hash), manifests = [primary, ...alternatives];
      const requestedAmount = typeof args["requested-amount"] === "string" ? BigInt(args["requested-amount"]) : BigInt(existing.manifestMinimum);
      const boundedAmount = requestedAmount < BigInt(existing.manifestMinimum) ? BigInt(existing.manifestMinimum) : requestedAmount > BigInt(existing.maximumAmount) ? BigInt(existing.maximumAmount) : requestedAmount;
      const requestedRail = args["requested-rail"] === "x402" || args["requested-rail"] === "shielded" ? args["requested-rail"] : undefined;
      if (existing.mandateHash !== settlementMandateHash(mandate) || !manifests.some((manifest) => manifest.manifestHash === existing.manifestHash) || requestedRail && requestedRail !== existing.rail || args["privacy-hint"] === "shielded" && existing.rail !== "shielded" || boundedAmount.toString() !== existing.openingAmount) {
        fail("OPERATION_ID_CONFLICT", "planning operation already identifies another immutable plan");
      }
      return existing as unknown as Record<string, unknown>;
    }
    const manifests = [primary, ...alternatives], recalled = await this.recallSettlementMemories(manifests.map(memoryQuery));
    const input = { operationId, mandate, manifests, ...(typeof args["requested-amount"] === "string" ? { requestedAmount: args["requested-amount"] } : {}), ...(args["privacy-hint"] === "shielded" ? { privacyHint: "shielded" as const } : {}), ...(args["requested-rail"] === "x402" || args["requested-rail"] === "shielded" ? { requestedRail: args["requested-rail"] as CapabilityRail } : {}), recalled, maxMemoryDistance: this.profile.policy.maxMemoryDistance ?? 0.35 };
    const plan = this.persistPlan(createSettlementPlan(input));
    if (!get(this.store, "memory-influence", plan.planHash)) record(this.store, "memory-influence", plan.planHash, explainMemoryInfluence(input, plan));
    return plan as unknown as Record<string, unknown>;
  }

  /** Recall settlement memories for several scoped queries; plaintext stays in this process. */
  private async recallSettlementMemories(queries: string[], limit = 20): Promise<RecalledSettlementMemory[]> {
    const local = this.localVerifiedOutcomes(), merge = (recalled: RecalledSettlementMemory[]) => [...local, ...recalled.filter((item) => !local.some((other) => other.blobId === item.blobId))]; // the local authoritative copy wins
    const encoded = this.profile.mock ? undefined : this.store.getSecret("live:memory-config");
    if (!encoded) return merge(this.recalledMockMemories());
    let config: ManualMemoryConfig; try { config = JSON.parse(encoded.toString()) as ManualMemoryConfig; } catch (error) { return fail("LIVE_MEMORY_CONFIG_INVALID", "encrypted memory config is invalid", error); }
    const manual = new ManualMemory(this.store, config), byBlob = new Map<string, RecalledSettlementMemory>();
    try {
      for (const query of [...new Set(queries)]) for (const item of await manual.recall(query, limit)) {
        const prior = byBlob.get(item.blobId); if (prior && prior.distance <= item.distance) continue;
        let memory: SettlementMemoryV1 | undefined; try { const opened = openMemoryText(item.text); validateSettlementMemory(opened.memory); memory = this.authenticatedMemory(item.blobId, opened.memory, Boolean(opened.signedBy && opened.signedBy === manual.signerAddress)); } catch { /* malformed or legacy memory remains advisory */ }
        byBlob.set(item.blobId, { blobId: item.blobId, distance: item.distance, ...(memory ? { memory } : { legacy: true }) });
      }
    } finally { manual.destroy(); }
    return merge([...byBlob.values()]);
  }

  /**
   * Verified outcomes this runtime wrote itself, including ones still queued for Walrus. They are authoritative
   * for spend and reliability on this machine; semantic recall alone can miss or lag them.
   */
  private localVerifiedOutcomes(): RecalledSettlementMemory[] {
    const rows = this.store.db.prepare("SELECT operation_id,blob_id FROM memory_jobs WHERE operation_id LIKE 'verified:deal:%' OR operation_id LIKE 'verified:deal-failure:%' ORDER BY created_at").all() as Array<{ operation_id: string; blob_id: string | null }>;
    return rows.flatMap((row) => {
      const payload = this.store.getSecret(`memory-outbox:${row.operation_id}`); if (!payload) return [];
      try { const memory = JSON.parse(payload.toString()) as unknown; validateSettlementMemory(memory, "verified_outcome"); return [{ blobId: row.blob_id ?? `local:${row.operation_id}`, distance: 0, memory }]; } catch { return []; }
    });
  }

  /**
   * Orders candidate sellers by what Walrus Memory has verified about them, instead of by price alone.
   * Sellers outside the owner mandate are dropped first so memory can never widen authority.
   */
  async rankDealCandidates(operationId: string, candidates: CapabilityManifest[], mandate: PlanningMandate, request: { budgetMaximum?: string; requestedRail?: CapabilityRail; privacyHint?: "any" | "shielded" } = {}): Promise<{ ordered: CapabilityManifest[]; scorecards: Array<SellerScorecard & { capabilityId: string; priceMinimum: string }> }> {
    const permitted = candidates.filter((item) => mandate.allowedCounterparties.includes(item.sellerId) && (!mandate.allowedCapabilityIds || mandate.allowedCapabilityIds.includes(item.capabilityId)) && (!mandate.allowedCapabilityClasses || mandate.allowedCapabilityClasses.includes(item.capability)));
    const allowed = permitted.length ? permitted : candidates;
    const recalled = await this.recallSettlementMemories(allowed.map(memoryQuery)), now = Date.now(), maxDistance = this.profile.policy.maxMemoryDistance ?? 0.35;
    const relevant = recalled.filter((item) => isRelevantMemory(item, maxDistance));
    // Only rank sellers that the deal could actually plan and pay: budget, rail, privacy, and price bounds.
    const payable = allowed.filter((manifest) => {
      try {
        const plan = createSettlementPlan({ operationId: `rank:${operationId}`, mandate, manifests: [manifest], requestedAmount: manifest.priceBand.minimum, recalled, maxMemoryDistance: maxDistance, now, ...(request.requestedRail ? { requestedRail: request.requestedRail } : {}), ...(request.privacyHint ? { privacyHint: request.privacyHint } : {}) });
        if (request.budgetMaximum !== undefined && BigInt(plan.maximumAmount) > BigInt(request.budgetMaximum)) return false;
        return request.requestedRail ? plan.rail === request.requestedRail : mandate.version !== "supercuts.mandate.v2" || !manifest.supportedRails.includes("shielded") || plan.rail === "shielded";
      } catch { return false; }
    });
    const pool = payable.length ? payable : allowed;
    const scored = pool.map((manifest) => ({ manifest, card: buildScorecard(relevant, { counterparty: manifest.sellerId, capabilityClass: manifest.capability }, now) }));
    const review = (card: SellerScorecard) => Number(card.lastOutcome === "unresolved" || card.observations > 0 && card.reliability < 0.5);
    scored.sort((a, b) => review(a.card) - review(b.card) || b.card.reliability - a.card.reliability || (BigInt(a.manifest.priceBand.minimum) < BigInt(b.manifest.priceBand.minimum) ? -1 : BigInt(a.manifest.priceBand.minimum) > BigInt(b.manifest.priceBand.minimum) ? 1 : 0) || a.manifest.capabilityId.localeCompare(b.manifest.capabilityId));
    const result = { ordered: scored.map((item) => item.manifest), scorecards: scored.map((item) => ({ ...item.card, capabilityId: item.manifest.capabilityId, priceMinimum: item.manifest.priceBand.minimum })) };
    record(this.store, "deal-ranking", operationId, { candidates: pool, scorecards: result.scorecards, chosen: result.ordered[0]?.capabilityId, createdAt: now });
    return result;
  }

  /** Stores the counterfactual (same mandate, no memory, every candidate) next to the binding deal plan. */
  recordDealMemoryInfluence(dealOperationId: string, plan: SettlementPlanV1, mandate: PlanningMandate, request: { requestedRail?: CapabilityRail; privacyHint?: "any" | "shielded" } = {}): MemoryInfluence | undefined {
    const ranking = get<{ candidates: CapabilityManifest[]; scorecards: Array<{ citedBlobIds: string[] }> }>(this.store, "deal-ranking", dealOperationId);
    if (!ranking) return undefined;
    const existing = get<MemoryInfluence>(this.store, "memory-influence", `deal:${dealOperationId}`); if (existing) return existing;
    const influence = explainMemoryInfluence({ operationId: plan.operationId, mandate, manifests: ranking.candidates, requestedAmount: plan.openingAmount, ...request }, plan);
    const cited = [...new Set([...influence.citedBlobIds, ...ranking.scorecards.flatMap((item) => item.citedBlobIds)])].sort();
    const value = { ...influence, citedBlobIds: cited };
    record(this.store, "memory-influence", `deal:${dealOperationId}`, value);
    return value;
  }

  memoryInfluence(id: string): MemoryInfluence | undefined { return get<MemoryInfluence>(this.store, "memory-influence", id); }

  /**
   * Owner view of what Supercuts has learned: fresh scorecards recalled from Walrus Memory for every seller
   * it has ranked, plus how often memory changed a payment decision. Counts and blob IDs only, never plaintext.
   */
  async memoryInsights(): Promise<Record<string, unknown>> {
    const rankings = all<{ candidates: CapabilityManifest[]; createdAt: number }>(this.store, "deal-ranking");
    const manifests = [...new Map(rankings.flatMap((item) => item.candidates).map((item) => [item.capabilityId, item])).values()];
    const recalled = manifests.length ? await this.recallSettlementMemories(manifests.map(memoryQuery)) : [], now = Date.now(), maxDistance = this.profile.policy.maxMemoryDistance ?? 0.35;
    const relevant = recalled.filter((item) => isRelevantMemory(item, maxDistance));
    const sellers = manifests.map((manifest) => { const card = buildScorecard(relevant, { counterparty: manifest.sellerId, capabilityClass: manifest.capability }, now); return { capabilityId: manifest.capabilityId, capabilityClass: manifest.capability, priceMinimum: manifest.priceBand.minimum, ...card }; }).sort((a, b) => b.reliability - a.reliability || a.capabilityId.localeCompare(b.capabilityId));
    const influences = (this.store.db.prepare("SELECT value FROM app_records WHERE scope='memory-influence' AND id LIKE 'deal:%'").all() as Array<{ value: string }>).map((row) => JSON.parse(row.value) as MemoryInfluence);
    const jobs = this.store.db.prepare("SELECT status, COUNT(*) AS count FROM memory_jobs GROUP BY status").all() as Array<{ status: string; count: number }>;
    const indexed = (this.store.db.prepare("SELECT COUNT(*) AS count FROM memory_inventory WHERE deleted=0").get() as { count: number }).count;
    return { version: "supercuts.memory-insights.v1", memories: { byStatus: Object.fromEntries(jobs.map((row) => [row.status, row.count])), indexed, recalled: recalled.length }, decisions: { deals: influences.length, changedSeller: influences.filter((item) => item.changedSeller).length, changedRail: influences.filter((item) => item.changedRail).length, changedRisk: influences.filter((item) => item.changedRisk).length, changedMaximum: influences.filter((item) => item.changedMaximum).length }, sellers };
  }

  private typedMemory(args: Record<string, string | boolean>, provenance: "agent_observation" | "owner_policy" | "verified_outcome"): SettlementMemoryV1 {
    const encoded = required(args, "memory"); let supplied: Record<string, unknown>;
    try { supplied = JSON.parse(Buffer.from(encoded, "base64url").toString()) as Record<string, unknown>; }
    catch { try { supplied = JSON.parse(encoded) as Record<string, unknown>; } catch (error) { return fail("SETTLEMENT_MEMORY_INVALID", "typed memory is not JSON", error); } }
    const memory = { ...supplied, version: "supercuts.settlement-memory.v1", provenance } as unknown; validateSettlementMemory(memory, provenance); return memory;
  }

  private async rememberTyped(args: Record<string, string | boolean>, provenance: "agent_observation" | "owner_policy" | "verified_outcome"): Promise<Record<string, unknown>> {
    const operationId = required(args, "operation-id"), memory = this.typedMemory(args, provenance);
    if (this.profile.mock) {
      const blobId = `mockwalrus_${hash(canonicalJson({ operationId, memory })).slice(0, 40)}`, item = { operationId, namespace: `supercuts:${this.profile.role}`, blobId, memory, status: "complete" };
      const existing = get<Record<string, unknown>>(this.store, "memory", operationId); if (existing && canonicalJson(existing.memory) !== canonicalJson(memory)) fail("MEMORY_OPERATION_CONFLICT", "memory operation ID identifies another envelope");
      record(this.store, "memory", operationId, item); this.registerMemoryAuthority(blobId, memory); return { operationId, namespace: item.namespace, blobId, status: "complete", kind: memory.kind, provenance };
    }
    const encoded = this.store.getSecret("live:memory-config") ?? fail("LIVE_MEMORY_CONFIG_MISSING", "live Mainnet memory requires an owner-only --memory-config-file"); let config: ManualMemoryConfig;
    try { config = JSON.parse(encoded.toString()) as ManualMemoryConfig; } catch (error) { return fail("LIVE_MEMORY_CONFIG_INVALID", "encrypted memory config is invalid", error); }
    const manual = new ManualMemory(this.store, config);
    try {
      const factHash = hash(canonicalJson(memory)), existing = this.store.db.prepare("SELECT fact_hash,blob_id,status FROM memory_jobs WHERE operation_id=?").get(operationId) as { fact_hash: string; blob_id: string | null; status: string } | undefined;
      if (existing) { if (existing.fact_hash !== factHash) fail("MEMORY_OPERATION_CONFLICT", "memory operation ID identifies another envelope"); if (existing.status === "complete" && existing.blob_id) return { operationId, namespace: config.namespace, blobId: existing.blob_id, status: "complete", kind: memory.kind, provenance }; return fail("MEMORY_JOB_PENDING", "memory job is not complete"); }
      this.store.db.prepare("INSERT INTO memory_jobs(operation_id,kind,fact_hash,blob_id,status,created_at) VALUES(?,?,?,NULL,'pending',?)").run(operationId, memory.kind, factHash, Date.now());
      try { const blobId = await manual.remember(memory); this.store.db.prepare("UPDATE memory_jobs SET blob_id=?,status='complete' WHERE operation_id=?").run(blobId, operationId); this.registerMemoryAuthority(blobId, memory); return { operationId, namespace: config.namespace, blobId, status: "complete", kind: memory.kind, provenance }; }
      catch (error) { this.store.db.prepare("UPDATE memory_jobs SET status='unresolved' WHERE operation_id=?").run(operationId); throw error; }
    } finally { manual.destroy(); }
  }

  private enqueueVerifiedOutcome(event: string, operationId: string, evidence: Record<string, unknown>, planHash?: string, fallback?: { counterparty?: string; asset?: string }, telemetry: Pick<SettlementMemoryV1["signal"], "amount" | "latencyMs" | "rail"> = {}): void {
    const plan = planHash ? this.storedPlan(planHash) : undefined, jobId = `verified:${event}:${operationId}`, evidenceHash = hash(canonicalJson(evidence));
    const prior = this.store.getSecret(`memory-outbox:${jobId}`);
    if (prior) {
      const saved = JSON.parse(prior.toString()) as SettlementMemoryV1;
      validateSettlementMemory(saved, "verified_outcome");
      if (saved.evidenceHash !== evidenceHash || plan && (saved.scope.capabilityId !== plan.capabilityId || saved.scope.counterparty !== plan.sellerId || saved.scope.asset !== plan.asset)) fail("MEMORY_OPERATION_CONFLICT", "verified outcome ID identifies different evidence or scope");
      return;
    }
    const memory: SettlementMemoryV1 = { version: "supercuts.settlement-memory.v1", kind: "outcome", provenance: "verified_outcome", scope: { ...(plan ? { capabilityId: plan.capabilityId, capabilityClass: plan.capabilityClass, counterparty: plan.sellerId, network: plan.network, asset: plan.asset } : { ...(fallback?.counterparty ? { counterparty: fallback.counterparty } : {}), ...(fallback?.asset ? { asset: fallback.asset } : {}), network: "sui:testnet" as const }) }, createdAt: Date.now(), evidenceHash, signal: { outcome: String(evidence.status ?? "") === "unresolved" ? "unresolved" : String(evidence.status ?? "") === "failed" ? "failed" : "succeeded", ...telemetry } };
    validateSettlementMemory(memory, "verified_outcome"); const factHash = hash(canonicalJson(memory));
    if (this.profile.mock) { const blobId = `mockwalrus_${factHash.slice(0, 40)}`; record(this.store, "verified-memory", jobId, { operationId: jobId, namespace: `supercuts:${this.profile.role}`, blobId, memory, status: "complete" }); this.registerMemoryAuthority(blobId, memory); return; }
    this.store.putSecretOnce(`memory-outbox:${jobId}`, Buffer.from(canonicalJson(memory)));
    this.store.db.prepare("INSERT OR IGNORE INTO memory_jobs(operation_id,kind,fact_hash,blob_id,status,created_at) VALUES(?,?,?,NULL,'pending',?)").run(jobId, memory.kind, factHash, Date.now());
  }

  /** Queues a verified seller fault as a Walrus outcome memory so later discovery demotes that seller. */
  recordVerifiedDealFailure(operationId: string, planHash: string, fault: { stage: string; code: string; paymentDigest?: string }): void {
    if (this.profile.mock || this.profile.role !== "buyer") fail("DEAL_LIVE_REQUIRED", "verified deal failures require a live buyer role");
    if (this.store.getSecret(`memory-outbox:verified:deal-failure:${operationId}`)) return;
    const plan = this.storedPlan(planHash);
    this.enqueueVerifiedOutcome("deal-failure", operationId, { status: "failed", stage: fault.stage, code: fault.code, ...(fault.paymentDigest ? { paymentDigest: fault.paymentDigest } : {}) }, planHash, undefined, { rail: plan.rail, ...(fault.paymentDigest ? { amount: plan.openingAmount } : {}) });
  }

  recordVerifiedDealOutcome(operationId: string, planHash: string, paymentDigest: string, artifactSha256: string): { payloadHash: string; queued: true } {
    if (this.profile.mock || this.profile.role !== "buyer") fail("DEAL_LIVE_REQUIRED", "verified deal outcome requires a live buyer role");
    const jobId = `verified:deal:${operationId}`;
    const plan = this.storedPlan(planHash), timings = this.store.db.prepare("SELECT COALESCE(SUM(duration_ms),0) AS total FROM deal_timings WHERE operation_id=? AND stage IN ('negotiation','payment','delivery')").get(operationId) as { total: number };
    this.enqueueVerifiedOutcome("deal", operationId, { status: "succeeded", paymentDigest, artifactSha256 }, planHash, undefined, { amount: plan.openingAmount, rail: plan.rail, ...(Number.isSafeInteger(timings.total) && timings.total > 0 ? { latencyMs: timings.total } : {}) });
    const payload = this.store.getSecret(`memory-outbox:${jobId}`) ?? fail("DEAL_MEMORY_INVALID", "verified outcome payload is missing");
    return { payloadHash: hash(payload), queued: true };
  }

  recoverStaleMemorySubmissions(): void {
    if (this.profile.mock || this.profile.role !== "buyer") return;
    this.store.db.prepare("UPDATE memory_jobs SET status='unresolved' WHERE status='submitting' AND (claimed_at IS NULL OR claimed_at<?)").run(Date.now() - 300_000);
    this.syncDealOutcomeJobs();
  }

  syncDealOutcomeJobs(): void {
    if (this.profile.mock || this.profile.role !== "buyer") return;
    const journal = new DealJournal(this.store);
    const rows = this.store.db.prepare("SELECT d.operation_id,d.payload_hash,d.blob_id,j.blob_id AS job_blob_id,j.status AS job_status,j.created_at FROM deal_memory_outbox d JOIN memory_jobs j ON j.operation_id='verified:deal:' || d.operation_id WHERE d.event_kind='outcome' AND d.status!='indexed'").all() as Array<{ operation_id: string; payload_hash: string; blob_id: string | null; job_blob_id: string | null; job_status: string; created_at: number }>;
    for (const row of rows) {
      const view = journal.get(row.operation_id);
      if (view.evidence.payment !== "finalized" || view.evidence.delivery !== "verified") fail("DEAL_OUTCOME_INVARIANT", "outcome job lacks verified payment or delivery");
      if (row.job_status === "unresolved") { journal.setOutcomeUnresolved(row.operation_id); continue; }
      if (row.job_status !== "complete" || !row.job_blob_id) continue;
      if (row.blob_id && row.blob_id !== row.job_blob_id) fail("DEAL_MEMORY_CONFLICT", "outcome memory blob differs from the job");
      const encoded = this.store.getSecret("live:memory-config") ?? fail("LIVE_MEMORY_CONFIG_MISSING", "buyer memory configuration is missing");
      const namespace = (JSON.parse(encoded.toString()) as ManualMemoryConfig).namespace;
      const inventory = this.store.db.prepare("SELECT status,deleted,expires_at FROM memory_inventory WHERE blob_id=? AND namespace=?").get(row.job_blob_id, namespace) as { status: string; deleted: number; expires_at: string | null } | undefined;
      const indexed = Boolean(inventory && !inventory.deleted && inventory.status === "active" && (!inventory.expires_at || Date.parse(inventory.expires_at) > Date.now()));
      journal.recordOutcome(row.operation_id, row.payload_hash, row.job_blob_id, indexed);
      if (indexed) {
        journal.recordTiming(row.operation_id, "memory_index", Date.now() - row.created_at);
        if (journal.get(row.operation_id).state === "outcome_pending") journal.advance(row.operation_id, "outcome_pending", "complete");
      }
    }
  }

  async processMemoryOutbox(): Promise<void> {
    if (this.profile.mock || this.profile.role !== "buyer") return;
    this.recoverStaleMemorySubmissions();
    await this.execute("memory.status", {});
    await this.execute("memory.inventory", {});
    this.syncDealOutcomeJobs();
  }

  async reconcileDealOutcome(operationId: string): Promise<{ resolved: boolean; state: string; blobId?: string }> {
    if (this.profile.mock || this.profile.role !== "buyer") fail("DEAL_LIVE_REQUIRED", "deal memory reconciliation requires a live buyer role");
    const journal = new DealJournal(this.store), view = journal.get(operationId);
    if (view.evidence.payment !== "finalized" || view.evidence.delivery !== "verified") fail("DEAL_DELIVERY_UNVERIFIED", "deal must have verified payment and delivery");
    if (view.state === "complete") return { resolved: true, state: "complete", ...(journal.outcomeStatus(operationId)?.blobId ? { blobId: journal.outcomeStatus(operationId)!.blobId! } : {}) };
    const jobId = `verified:deal:${operationId}`;
    const row = (this.store.db.prepare("SELECT fact_hash,status FROM memory_jobs WHERE operation_id=?").get(jobId) as { fact_hash: string; status: string } | undefined) ?? fail("DEAL_MEMORY_INVALID", "verified outcome job is missing");
    const encoded = this.store.getSecret(`memory-outbox:${jobId}`) ?? fail("DEAL_MEMORY_INVALID", "verified outcome payload is missing");
    const memory = JSON.parse(encoded.toString()) as SettlementMemoryV1;
    validateSettlementMemory(memory, "verified_outcome");
    if (row.fact_hash !== hash(canonicalJson(memory))) fail("DEAL_MEMORY_CONFLICT", "outcome job differs from its saved payload");
    journal.queueOutcome(operationId, hash(encoded));
    this.syncDealOutcomeJobs();
    if (row.status !== "unresolved") return { resolved: false, state: row.status };
    const configBytes = this.store.getSecret("live:memory-config") ?? fail("LIVE_MEMORY_CONFIG_MISSING", "buyer memory configuration is missing");
    const config = JSON.parse(configBytes.toString()) as ManualMemoryConfig;
    const manual = new ManualMemory(this.store, config);
    let blobId: string | undefined;
    try {
      const query = [memory.scope.capabilityId, memory.scope.counterparty, memory.signal.outcome].filter(Boolean).join(" ");
      const recalled = await manual.recall(query, 100);
      blobId = recalled.find((item) => { try { return canonicalJson(openMemoryText(item.text).memory) === canonicalJson(memory); } catch { return false; } })?.blobId;
      if (blobId) await manual.listMetadata(config);
    } finally { manual.destroy(); }
    if (!blobId) return { resolved: false, state: "unresolved" };
    this.store.db.prepare("UPDATE memory_jobs SET blob_id=?,status='complete' WHERE operation_id=? AND status='unresolved'").run(blobId, jobId);
    this.registerMemoryAuthority(blobId, memory);
    const outcome = journal.outcomeStatus(operationId) ?? fail("DEAL_MEMORY_INVALID", "deal outcome journal is missing");
    if (outcome.payloadHash !== hash(encoded)) fail("DEAL_MEMORY_CONFLICT", "deal outcome differs from its saved payload");
    journal.recordOutcome(operationId, outcome.payloadHash, blobId, false);
    this.syncDealOutcomeJobs();
    return { resolved: journal.get(operationId).state === "complete", state: journal.get(operationId).state, blobId };
  }

  private approveReview(args: Record<string, string | boolean>): Record<string, unknown> {
    const original = this.storedPlan(required(args, "plan-hash")); if (original.status !== "review_required") fail("SETTLEMENT_REVIEW_NOT_REQUIRED", "only a review-required plan can be approved");
    if (Date.now() >= original.expiresAt) fail("SETTLEMENT_PLAN_EXPIRED", "review-required plan has expired");
    const operationId = required(args, "operation-id"), createdAt = Date.now();
    const copy: Omit<SettlementPlanV1, "planHash"> = { ...original, operationId, status: "approved", riskLevel: "medium", createdAt, expiresAt: Math.min(createdAt + 300_000, original.expiresAt), reasonCodes: [...new Set([...original.reasonCodes, "OWNER_REVIEW_APPROVED" as const])], approvedFromPlanHash: original.planHash };
    delete (copy as Partial<SettlementPlanV1>).planHash; return this.persistPlan({ ...copy, planHash: settlementPlanHash(copy) }) as unknown as Record<string, unknown>;
  }

  private bindAcceptedAgreement(args: Record<string, string | boolean>, accepted: Record<string, unknown>): void {
    if (typeof args["plan-hash"] !== "string") return;
    const plan = this.storedPlan(args["plan-hash"]), mandate = this.planningMandate(args), session = String(accepted.sessionId), amount = String(accepted.paymentAmount), counterparty = String(accepted.counterparty);
    if (plan.status !== "approved" || plan.rail !== "shielded" || Date.now() >= plan.expiresAt || plan.mandateHash !== settlementMandateHash(mandate)) fail("SETTLEMENT_PLAN_BINDING_MISMATCH", "accepted agreement is not authorized by an active shielded plan");
    if (counterparty !== plan.sellerId || BigInt(amount) < BigInt(plan.manifestMinimum) || BigInt(amount) > BigInt(plan.maximumAmount) || accepted.capabilityId !== plan.capabilityId || accepted.manifestHash !== plan.manifestHash) fail("SETTLEMENT_PLAN_BINDING_MISMATCH", "accepted agreement differs from the planned capability, seller, or amount bounds");
    const bindingHash = hash(canonicalJson({ domain: "supercuts-settlement-agreement-v1", session, planHash: plan.planHash, amount, counterparty, capabilityId: accepted.capabilityId ?? plan.capabilityId, manifestHash: accepted.manifestHash ?? plan.manifestHash }));
    const existing = this.store.db.prepare("SELECT plan_hash,binding_hash FROM settlement_agreement_bindings WHERE session_id=? OR plan_hash=?").get(session, plan.planHash) as { plan_hash: string; binding_hash: string } | undefined;
    if (existing && (existing.plan_hash !== plan.planHash || existing.binding_hash !== bindingHash)) fail("SETTLEMENT_PLAN_BINDING_MISMATCH", "session or plan is already bound to another agreement");
    if (!existing) this.store.db.prepare("INSERT INTO settlement_agreement_bindings(session_id,plan_hash,binding_hash,created_at) VALUES(?,?,?,?)").run(session, plan.planHash, bindingHash, Date.now());
  }

  private bindSettlementPlan(command: "pay.x402" | "pay.shielded", args: Record<string, string | boolean>, actual: { amount: string; counterparty: string; asset: string; endpoint?: string; requestId: string; session?: string; requirementsHash?: string }): SettlementPlanV1 | undefined {
    const mandate = this.planningMandate(args), supplied = typeof args["plan-hash"] === "string" ? args["plan-hash"] : undefined;
    if (!supplied) { if ((mandate as PlanningMandate & { requireSettlementPlan?: boolean }).requireSettlementPlan) fail("SETTLEMENT_PLAN_REQUIRED", "owner mandate requires an approved settlement plan"); return undefined; }
    const plan = this.storedPlan(supplied), rail = command === "pay.x402" ? "x402" : "shielded", now = Date.now();
    if (plan.status !== "approved" || plan.riskLevel === "review_required") fail("SETTLEMENT_PLAN_REVIEW_REQUIRED", "settlement plan requires owner review");
    if (plan.mandateHash !== settlementMandateHash(mandate)) fail("SETTLEMENT_PLAN_MANDATE_MISMATCH", "owner mandate changed after planning");
    const operationId = required(args, "operation-id");
    if (plan.operationId !== operationId || plan.rail !== rail || plan.sellerId !== actual.counterparty || plan.asset !== actual.asset || plan.network !== "sui:testnet" || actual.endpoint && !matchesPlannedEndpoint(plan.endpoint, actual.endpoint, actual.requestId)) fail("SETTLEMENT_PLAN_BINDING_MISMATCH", "execution differs from the planned operation, capability, seller, endpoint, asset, network, or rail");
    if (rail === "shielded" && actual.session) {
      const agreement = this.store.db.prepare("SELECT plan_hash FROM settlement_agreement_bindings WHERE session_id=?").get(actual.session) as { plan_hash: string } | undefined;
      if (agreement && agreement.plan_hash !== plan.planHash) fail("SETTLEMENT_PLAN_BINDING_MISMATCH", "shielded agreement is bound to another plan");
      if (!agreement && !this.profile.mock) fail("SETTLEMENT_PLAN_BINDING_MISMATCH", "shielded payment has no accepted agreement bound to this plan");
    }
    const value = BigInt(actual.amount); if (value < BigInt(plan.manifestMinimum) || value > BigInt(plan.maximumAmount)) fail("SETTLEMENT_PLAN_AMOUNT_EXCEEDED", "execution amount is outside the planned manifest bounds");
    const stableBinding = { planHash: plan.planHash, operationId, capabilityId: plan.capabilityId, manifestHash: plan.manifestHash, rail, amount: actual.amount, counterparty: actual.counterparty, asset: actual.asset, endpoint: actual.endpoint ?? null, requestId: actual.requestId, session: actual.session ?? null };
    const binding = { ...stableBinding, requirementsHash: actual.requirementsHash ?? null };
    // A renewed x402 challenge changes only its nonce-derived requirements hash. The plan remains
    // consumed by the same economic payment and request; treating the ephemeral hash as the plan
    // identity would make an expired challenge permanently strand the reserved buyer budget.
    const bindingHash = hash(canonicalJson({ domain: "supercuts-settlement-execution-v2", binding: stableBinding })), existing = this.store.db.prepare("SELECT binding_hash,binding_json FROM settlement_execution_bindings WHERE operation_id=? OR plan_hash=?").get(operationId, plan.planHash) as { binding_hash: string; binding_json: string } | undefined;
    if (existing && existing.binding_hash !== bindingHash) {
      let old: Record<string, unknown>;
      try { old = JSON.parse(existing.binding_json) as Record<string, unknown>; } catch (error) { return fail("SETTLEMENT_PLAN_CONSUMED", "saved settlement execution binding is invalid", error); }
      const oldStable = Object.fromEntries(Object.keys(stableBinding).map((key) => [key, old[key]]));
      if (canonicalJson(oldStable) !== canonicalJson(stableBinding)) fail("SETTLEMENT_PLAN_CONSUMED", "plan or operation is already bound to another execution");
    }
    if (!existing && now >= plan.expiresAt) fail("SETTLEMENT_PLAN_EXPIRED", "settlement plan has expired");
    if (!existing) { this.store.db.prepare("INSERT INTO settlement_execution_bindings(operation_id,plan_hash,binding_hash,binding_json,created_at) VALUES(?,?,?,?,?)").run(operationId, plan.planHash, bindingHash, canonicalJson(binding), now); this.store.db.prepare("UPDATE settlement_plans SET consumed_at=? WHERE plan_hash=?").run(now, plan.planHash); }
    return plan;
  }

  private async executeLive(command: string, args: Record<string, string | boolean>): Promise<CommandResult> {
    if (!this.profile.live) fail("LIVE_PROFILE_INVALID", "live profile configuration is missing");
    if (command === "settlement.plan") return output(command, await this.planSettlement(args));
    if (command === "settlement.approve-review") return output(command, this.approveReview(args));
    if (command === "memory.policy") return output(command, await this.rememberTyped(args, "owner_policy"));
    if (command === "memory.inventory") {
      const encoded = this.store.getSecret("live:memory-config") ?? fail("LIVE_MEMORY_CONFIG_MISSING", "live Mainnet memory requires an owner-only memory configuration");
      const config = JSON.parse(encoded.toString()) as ManualMemoryConfig;
      const manual = new ManualMemory(this.store, config);
      try {
        const synced = await manual.listMetadata(config);
        const blobId = typeof args["blob-id"] === "string" ? args["blob-id"] : undefined;
        if (blobId && !/^[A-Za-z0-9_-]{1,256}$/.test(blobId)) fail("MEMORY_BLOB_ID_INVALID", "memory blob ID is invalid");
        const row = blobId ? this.store.db.prepare("SELECT m.blob_id AS blobId,m.status AS status,m.expires_at AS expiresAt,m.deleted AS deleted FROM memory_inventory m JOIN memory_jobs j ON j.blob_id=m.blob_id WHERE m.blob_id=? AND m.namespace=?").get(blobId, config.namespace) as { blobId: string; status: string; expiresAt: string | null; deleted: number } | undefined : undefined;
        const present = Boolean(row && !row.deleted && row.status === "active" && (!row.expiresAt || Date.parse(row.expiresAt) > Date.now()));
        return output(command, { namespace: config.namespace, ...synced, ...(blobId ? { blobId, present, ...(row?.expiresAt ? { expiresAt: row.expiresAt } : {}) } : {}) });
      } finally { manual.destroy(); }
    }
    if (command === "memory.remember" || command === "memory.recall" || command === "memory.status") return output(command, await this.liveMemory(command, args));
    const runtime = await LiveRuntime.create(this.profile as LiveRuntimeProfile, this.store);
    if (command === "doctor") return output(command, await runtime.doctor(args["proofs-required"] !== false));
    if (command === "status") return output(command, { role: this.profile.role, network: this.profile.network, mock: false, runtime: "testnet-live" });
    if (command === "capability.publish") return output(command, await this.publishLiveCapability(args));
    if (command === "capability.discover") return output(command, await this.discoverLiveCapabilities(args));
    if (command === "offer.open") {
      const sessionId = typeof args.session === "string" ? args.session : `session_${randomUUID()}`;
      const offer = { sessionId, revision: 0, state: "open", buyer: this.profile.role, transcriptCommitment: hash(`open:${sessionId}`) }; record(this.store, "offer", sessionId, offer); return output(command, offer);
    }
    if (command === "offer.propose") return output(command, this.localOffer(command, args));
    if (command === "offer.show") return output(command, get<Record<string, unknown>>(this.store, "offer", required(args, "session")) ?? fail("OFFER_NOT_FOUND", "offer session was not found"));
    if (command === "pay.quote") {
      const rail = required(args, "rail") as "shielded" | "x402"; if (!(rail === "shielded" || rail === "x402")) fail("RAIL_INVALID", "rail must be shielded or x402");
      const checked = this.paymentPolicy(args, rail); return output(command, { rail, amount: checked.amount.toString(), counterparty: checked.counterparty, asset: checked.asset, policyDecision: "allowed", visibility: rail === "shielded" ? "no-direct-public-payment; funding-deposits-withdrawals-gas-and-pool-activity-visible" : "public-transfer" });
    }
    if (command === "wallet.balance") return output(command, await runtime.balance());
    if (command === "wallet.recover") return output(command, await runtime.recover());
    if (command === "wallet.deposit") return output(command, await runtime.deposit(amount(args), required(args, "operation-id")));
    if (command === "wallet.withdraw") return output(command, await runtime.withdraw(required(args, "commitment"), required(args, "recipient"), required(args, "operation-id")));
    if (command === "wallet.exit.queue") {
      const queued = await runtime.queueV2Exit(required(args, "commitment"), required(args, "operation-id"), amount(args), args["exact-exit"] === true,
        Number(required(args, "window-start")), Number(required(args, "window-end")), true);
      return output(command, { ...queued, amount: queued.amount.toString(), visibility: queued.exactExit ? "exact exit amount is public" : "standard 1,000,000 MIST exit; payout and pool activity are public" });
    }
    if (command === "wallet.exit.status") {
      const queued = new V2ExitQueue(this.store).get(required(args, "operation-id")) ?? fail("EXIT_REQUEST_INVALID", "exit operation was not found");
      return output(command, { ...queued, amount: queued.amount.toString() });
    }
    if (command === "wallet.exit.finalize") return output(command, await runtime.finalizeV2Exit(required(args, "exit-id"), required(args, "digest"), V2_RELAYER));
    if (command === "offer.accept") {
      this.store.db.exec("BEGIN IMMEDIATE");
      let accepted: Record<string, unknown>;
      try {
        accepted = typeof args.agreement === "string" ? runtime.acceptAgreement(required(args, "session"), args.agreement) : this.localOffer(command, args);
        if (typeof args["plan-hash"] === "string") this.bindAcceptedAgreement(args, accepted);
        this.store.db.exec("COMMIT");
      } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
      this.enqueueVerifiedOutcome("agreement", typeof args["operation-id"] === "string" ? args["operation-id"] : `${String(accepted.sessionId)}:${String(accepted.revision)}`, { status: "accepted", commitment: accepted.dealCommitment ?? accepted.transcriptCommitment }, typeof args["plan-hash"] === "string" ? args["plan-hash"] : undefined);
      return output(command, accepted);
    }
    if (command === "offer.counter") return output(command, typeof args.agreement === "string" ? runtime.prepareSellerAgreement(required(args, "session"), args.agreement) : this.localOffer(command, args));
    if (command === "pay.shielded") { const receipt = await runtime.settleShielded(required(args, "session"), required(args, "operation-id"), (actual) => { this.bindSettlementPlan(command, args, actual); }); this.enqueueVerifiedOutcome("settlement", required(args, "operation-id"), receipt, typeof args["plan-hash"] === "string" ? args["plan-hash"] : undefined, { counterparty: String(receipt.counterparty), asset: String(receipt.asset) }); return output(command, receipt); }
    if (command === "pay.x402") { const receipt = await runtime.payX402Resource(required(args, "operation-id"), required(args, "resource-url"), (actual) => { this.bindSettlementPlan(command, args, actual); }); const { response: _response, ...evidence } = receipt; this.enqueueVerifiedOutcome("settlement", required(args, "operation-id"), evidence, typeof args["plan-hash"] === "string" ? args["plan-hash"] : undefined, { counterparty: String(receipt.counterparty), asset: String(receipt.asset) }); return output(command, receipt); }
    if (command === "pay.status") return output(command, await runtime.paymentStatus(required(args, "operation-id"), args.reconcile === true));
    if (command === "resource.serve") {
      const requestId = required(args, "request-id"), body = required(args, "body"), resource = { requestId, responseHash: hash(Buffer.from(body, "base64")), body, deliveryStatus: "ready" }; record(this.store, "resource", requestId, resource); return output(command, { requestId, responseHash: resource.responseHash, deliveryStatus: resource.deliveryStatus });
    }
    if (command === "resource.fetch") {
      const requestId = required(args, "request-id"), local = get<Record<string, unknown>>(this.store, "resource", requestId);
      if (local) return output(command, { ...local, deliveryStatus: "delivered" });
      const body = required(args, "response"), delivered = { requestId, responseHash: hash(Buffer.from(body, "base64")), body, deliveryStatus: "delivered", observation: "artifact-delivered-separate-from-payment" }; this.enqueueVerifiedOutcome("delivery", required(args, "operation-id"), { status: "delivered", requestId, responseHash: delivered.responseHash }); return output(command, delivered);
    }
    return fail("LIVE_COMMAND_UNAVAILABLE", `${command} is not connected to the Testnet runtime`);
  }

  private publishCapability(args: Record<string, string | boolean>, mock: boolean): Record<string, unknown> {
    let manifest: CapabilityManifest | undefined;
    if (typeof args.manifest === "string") {
      try { manifest = JSON.parse(Buffer.from(args.manifest, "base64url").toString()) as CapabilityManifest; } catch (error) { return fail("CAPABILITY_INVALID", "manifest is not valid encoded JSON", error); }
      validateCapabilityManifest(manifest);
    }
    if (manifest) {
      record(this.store, "capability", manifest.capabilityId, manifest);
      return { ...manifest, blobId: `${mock ? "mockwalrus" : "walrus"}_${manifest.manifestHash.slice(0, 40)}`, visibility: "public-capability" };
    }
    const capabilityId = typeof args["capability-id"] === "string" ? args["capability-id"] : `cap_${randomUUID()}`;
    const item = { capabilityId, seller: required(args, "seller"), service: required(args, "service"), terms: required(args, "terms"), blobId: `${mock ? "mockwalrus" : "walrus"}_${hash(`${capabilityId}:${String(args.seller)}:${String(args.service)}`).slice(0, 40)}`, visibility: "public-capability" };
    record(this.store, "capability", capabilityId, item); return item;
  }
  private async publishLiveCapability(args: Record<string, string | boolean>): Promise<Record<string, unknown>> {
    const publisher = this.profile.live?.walrusPublisherUrl ?? fail("LIVE_WALRUS_CONFIG_MISSING", "live capability publication requires --walrus-publisher"), aggregator = this.profile.live?.walrusAggregatorUrl ?? fail("LIVE_WALRUS_CONFIG_MISSING", "live capability publication requires --walrus-aggregator");
    const encoded = typeof args.manifest === "string" ? args.manifest : fail("CAPABILITY_INVALID", "live publication requires a supercuts.capability.v1 manifest");
    let manifest: CapabilityManifest; try { manifest = JSON.parse(Buffer.from(encoded, "base64url").toString()) as CapabilityManifest; } catch (error) { return fail("CAPABILITY_INVALID", "manifest is not valid encoded JSON", error); }
    validateCapabilityManifest(manifest); const body = Buffer.from(JSON.stringify(manifest));
    const response = await fetch(`${publisher.replace(/\/$/, "")}/v1/blobs?epochs=5`, { method: "PUT", body, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) fail("WALRUS_PUBLISH_FAILED", `Walrus publisher returned ${response.status}`);
    const result = await response.json() as { newlyCreated?: { blobObject?: { blobId?: string } }; alreadyCertified?: { blobId?: string }; alreadyRegistered?: { blobId?: string } }, blobId = result.newlyCreated?.blobObject?.blobId ?? result.alreadyCertified?.blobId ?? result.alreadyRegistered?.blobId ?? fail("WALRUS_PUBLISH_FAILED", "Walrus publisher omitted the blob ID");
    const read = await fetch(`${aggregator.replace(/\/$/, "")}/v1/blobs/${encodeURIComponent(blobId)}`, { signal: AbortSignal.timeout(60_000) });
    if (!read.ok || !Buffer.from(await read.arrayBuffer()).equals(body)) fail("WALRUS_BLOB_MISMATCH", "published capability did not round-trip through the Walrus aggregator");
    record(this.store, "capability", manifest.capabilityId, { ...manifest, blobId }); return { ...manifest, blobId, visibility: "public-capability" };
  }
  private async discoverLiveCapabilities(args: Record<string, string | boolean>): Promise<Record<string, unknown>> {
    if (typeof args["blob-ids"] !== "string") return this.discoverCapabilities(args, "configured-manifests");
    const aggregator = this.profile.live?.walrusAggregatorUrl ?? fail("LIVE_WALRUS_CONFIG_MISSING", "live capability discovery requires --walrus-aggregator");
    let ids: unknown; try { ids = JSON.parse(Buffer.from(args["blob-ids"], "base64url").toString()); } catch (error) { return fail("CAPABILITY_LIST_INVALID", "blob IDs are not valid encoded JSON", error); }
    const blobIds = Array.isArray(ids) && ids.length && ids.every((id): id is string => typeof id === "string" && Boolean(id) && id.length <= 256) ? ids : fail("CAPABILITY_LIST_INVALID", "blob-ids must be a non-empty string array");
    const manifests = await Promise.all(blobIds.map(async (blobId) => { const response = await fetch(`${aggregator.replace(/\/$/, "")}/v1/blobs/${encodeURIComponent(blobId)}`, { signal: AbortSignal.timeout(60_000) }); if (!response.ok) return fail("WALRUS_READ_FAILED", `Walrus aggregator returned ${response.status}`); const manifest = await response.json() as unknown; validateCapabilityManifest(manifest); return { ...manifest, blobId }; }));
    return { capabilities: manifests, source: "walrus" };
  }
  private discoverCapabilities(args: Record<string, string | boolean>, source: string): Record<string, unknown> {
    const configured = typeof args.capabilities === "string" ? JSON.parse(Buffer.from(args.capabilities, "base64url").toString()) as unknown : [];
    const list = Array.isArray(configured) ? configured : fail("CAPABILITY_LIST_INVALID", "configured capabilities must be an array");
    for (const item of list) if (item && typeof item === "object" && (item as Record<string, unknown>).protocol === "supercuts.capability.v1") validateCapabilityManifest(item);
    return { capabilities: list, source };
  }
  private localOffer(command: string, args: Record<string, string | boolean>): Record<string, unknown> {
    const sessionId = required(args, "session"), previous = get<Record<string, unknown>>(this.store, "offer", sessionId);
    const revision = Number(typeof args.revision === "string" ? args.revision : Number(previous?.revision ?? 0) + 1);
    if (!Number.isSafeInteger(revision) || revision < 1) fail("REVISION_INVALID", "revision must be a positive integer");
    const state = command.split(".")[1]!, termsHash = hash(typeof args.terms === "string" ? args.terms : "accepted");
    const offer = { sessionId, revision, state, termsHash, transcriptCommitment: hash(`${sessionId}:${revision}:${state}:${termsHash}`) }; record(this.store, "offer", sessionId, offer); return offer;
  }
  private async liveMemory(command: string, args: Record<string, string | boolean>): Promise<Record<string, unknown>> {
    const encoded = this.store.getSecret("live:memory-config") ?? fail("LIVE_MEMORY_CONFIG_MISSING", "live Mainnet memory requires an owner-only --memory-config-file");
    let config: ManualMemoryConfig; try { config = JSON.parse(encoded.toString()) as ManualMemoryConfig; } catch (error) { return fail("LIVE_MEMORY_CONFIG_INVALID", "encrypted memory config is invalid", error); }
    const manual = new ManualMemory(this.store, config);
    try {
      if (command === "memory.remember") {
        if (typeof args.memory === "string") return this.rememberTyped(args, "agent_observation");
        const operationId = required(args, "operation-id"), observation = required(args, "fact"), workflow = new WorkflowMemory(this.store, manual);
        const blobId = await workflow.record({ kind: /privacy|sensitive|hide/i.test(observation) ? "privacy_choice" : "delivery_observation", subject: "procurement-demo", observation, operationId, createdAt: Date.now() });
        return { operationId, namespace: config.namespace, blobId, status: "complete" };
      }
      if (command === "memory.recall") {
        const recalled = await manual.recall(required(args, "query"));
        const citations = recalled.filter((item) => item.distance <= (this.profile.policy.maxMemoryDistance ?? 0.35)).map((item) => { try { const opened = openMemoryText(item.text), memory = opened.memory; validateSettlementMemory(memory); const trusted = this.authenticatedMemory(item.blobId, memory, Boolean(opened.signedBy && opened.signedBy === manual.signerAddress)); return { blobId: item.blobId, kind: trusted.kind, provenance: trusted.provenance, distance: item.distance }; } catch { return { blobId: item.blobId, kind: "legacy", provenance: "legacy_untrusted", distance: item.distance }; } });
        return { namespace: config.namespace, citations, effect: citations.length ? "candidate-preference-adjusted" : "no-policy-change" };
      }
      const target = typeof args["operation-id"] === "string" ? args["operation-id"] : undefined;
      for (const row of (target ? this.store.db.prepare("SELECT operation_id FROM memory_jobs WHERE status='pending' AND operation_id=? ORDER BY created_at").all(target) : this.store.db.prepare("SELECT operation_id FROM memory_jobs WHERE status='pending' ORDER BY created_at").all()) as Array<{ operation_id: string }>) {
        const queued = this.store.getSecret(`memory-outbox:${row.operation_id}`); if (!queued) continue;
        if (this.store.db.prepare("UPDATE memory_jobs SET status='submitting',claimed_at=? WHERE operation_id=? AND status='pending'").run(Date.now(), row.operation_id).changes !== 1) continue;
        try { const memory = JSON.parse(queued.toString()) as unknown; validateSettlementMemory(memory, "verified_outcome"); const blobId = await manual.remember(memory); this.store.db.prepare("UPDATE memory_jobs SET blob_id=?,status='complete' WHERE operation_id=?").run(blobId, row.operation_id); this.registerMemoryAuthority(blobId, memory); }
        catch { this.store.db.prepare("UPDATE memory_jobs SET status='unresolved' WHERE operation_id=?").run(row.operation_id); }
      }
      const jobs = new WorkflowMemory(this.store, manual).completed(); return { namespace: config.namespace, completed: jobs.length, jobs: jobs.map((item) => ({ ...item, status: "complete" })) };
    } finally { manual.destroy(); }
  }
  execute(command: string, args: Record<string, string | boolean>): CommandResult;
  execute(command: string, args: Record<string, string | boolean>): CommandResult | Promise<CommandResult> {
    this.allow(command, args);
    if (!this.profile.mock) return this.executeLive(command, args);
    if (command === "settlement.plan") return this.planSettlement(args).then((data) => output(command, data));
    if (command === "settlement.approve-review") return output(command, this.approveReview(args));
    if (command === "memory.policy") return this.rememberTyped(args, "owner_policy").then((data) => output(command, data));
    if (command === "doctor") return output(command, this.doctor());
    if (command === "status") return output(command, { role: this.profile.role, network: this.profile.network, operations: all(this.store, "payment").length, mock: this.profile.mock });
    if (command === "capability.publish") {
      return output(command, this.publishCapability(args, true));
    }
    if (command === "capability.discover") {
      return output(command, this.discoverCapabilities(args, "configured-mock"));
    }
    if (command === "wallet.deposit") {
      this.doctor();
      const value = amount(args), commitment = `note_${hash(`${value}:${randomUUID()}`).slice(0, 32)}`;
      record(this.store, "note", commitment, { commitment, amount: value.toString(), role: "input", spent: false });
      return output(command, { commitment, amount: value.toString(), finalized: true, transactionDigest: this.digest("deposit", commitment), evidence: this.evidence() });
    }
    if (command === "wallet.balance") {
      const notes = all<{ amount: string; spent: boolean }>(this.store, "note");
      return output(command, { available: notes.filter((n) => !n.spent).reduce((sum, n) => sum + BigInt(n.amount), 0n).toString(), notes: notes.length });
    }
    if (command === "wallet.recover") {
      if (typeof args.commitment === "string") {
        const recoveredAmount = amount(args); record(this.store, "note", args.commitment, { commitment: args.commitment, amount: recoveredAmount.toString(), role: "payment", spent: false });
      }
      return output(command, { recovered: all(this.store, "note").length, source: this.profile.mock ? "deterministic-mock-events" : "pinned-chain-events" });
    }
    if (command === "wallet.withdraw") {
      this.doctor();
      const commitment = required(args, "commitment"), note = get<{ amount: string; spent: boolean }>(this.store, "note", commitment) ?? fail("NOTE_NOT_FOUND", "note was not found");
      if (note.spent) fail("NOTE_SPENT", "note has already been spent"); note.spent = true; record(this.store, "note", commitment, note);
      return output(command, { commitment, amount: note.amount, transactionDigest: this.digest("withdraw", commitment), finalized: true, evidence: this.evidence() });
    }
    if (command === "offer.open") {
      const sessionId = typeof args.session === "string" ? args.session : `session_${randomUUID()}`;
      const offer = { sessionId, revision: 0, state: "open", buyer: this.profile.role, transcriptCommitment: hash(`open:${sessionId}`) }; record(this.store, "offer", sessionId, offer);
      return output(command, offer);
    }
    if (["offer.propose", "offer.counter", "offer.accept"].includes(command)) {
      const sessionId = required(args, "session"), previous = get<Record<string, unknown>>(this.store, "offer", sessionId);
      const revision = Number(typeof args.revision === "string" ? args.revision : Number(previous?.revision ?? 0) + 1);
      if (!Number.isSafeInteger(revision) || revision < 1) fail("REVISION_INVALID", "revision must be a positive integer");
      const state = command.split(".")[1]!, termsHash = hash(typeof args.terms === "string" ? args.terms : "accepted");
      const offer = { sessionId, revision, state, termsHash, transcriptCommitment: hash(`${sessionId}:${revision}:${state}:${termsHash}`) }; record(this.store, "offer", sessionId, offer);
      if (command === "offer.accept") this.enqueueVerifiedOutcome("agreement", typeof args["operation-id"] === "string" ? args["operation-id"] : `${sessionId}:${revision}`, { status: "accepted", transcriptCommitment: offer.transcriptCommitment }, typeof args["plan-hash"] === "string" ? args["plan-hash"] : undefined);
      return output(command, offer);
    }
    if (command === "offer.show") return output(command, get<Record<string, unknown>>(this.store, "offer", required(args, "session")) ?? fail("OFFER_NOT_FOUND", "offer session was not found"));
    if (command === "pay.quote") {
      const rail = required(args, "rail") as "shielded" | "x402"; if (!(["shielded", "x402"] as string[]).includes(rail)) fail("RAIL_INVALID", "rail must be shielded or x402");
      const checked = this.paymentPolicy(args, rail); return output(command, { rail, amount: checked.amount.toString(), counterparty: checked.counterparty, asset: checked.asset, policyDecision: "allowed", visibility: rail === "shielded" ? "no-direct-public-payment; funding-deposits-withdrawals-gas-and-pool-activity-visible" : "public-transfer" });
    }
    if (command === "pay.shielded" || command === "pay.x402") return this.pay(command, args);
    if (command === "pay.status") {
      const operationId = required(args, "operation-id"), payment = get<Record<string, unknown>>(this.store, "payment", operationId) ?? fail("OPERATION_NOT_FOUND", "payment operation was not found");
      if (args.reconcile === true && payment.status === "broadcast") { payment.status = "finalized"; payment.tatumVerified = true; record(this.store, "payment", operationId, payment); }
      return output(command, payment);
    }
    if (command === "resource.serve") {
      const requestId = required(args, "request-id"), body = required(args, "body"), resource = { requestId, responseHash: hash(body), body, deliveryStatus: "ready" }; record(this.store, "resource", requestId, resource); return output(command, { requestId, responseHash: resource.responseHash, deliveryStatus: resource.deliveryStatus });
    }
    if (command === "resource.fetch") {
      const requestId = required(args, "request-id"), local = get<Record<string, unknown>>(this.store, "resource", requestId);
      if (local) return output(command, { ...local, deliveryStatus: "delivered" });
      const body = required(args, "response"), operationId = required(args, "operation-id"), payment = get<Record<string, unknown>>(this.store, "payment", operationId) ?? fail("OPERATION_NOT_FOUND", "payment operation was not found");
      if (payment.status !== "finalized" || payment.requestId !== requestId) fail("RESOURCE_PAYMENT_REQUIRED", "a matching finalized payment is required");
      const delivered = { requestId, responseHash: hash(body), body, deliveryStatus: "delivered" }; this.enqueueVerifiedOutcome("delivery", operationId, { status: "delivered", requestId, responseHash: delivered.responseHash }, typeof payment.planHash === "string" ? payment.planHash : undefined); return output(command, delivered);
    }
    if (command === "memory.remember") {
      if (typeof args.memory === "string") return this.rememberTyped(args, "agent_observation").then((data) => output(command, data));
      const operationId = required(args, "operation-id"), fact = required(args, "fact"); if (/private key|spend secret|seed phrase|full transcript/i.test(fact)) fail("MEMORY_SECRET_REJECTED", "memory cannot contain wallet or transcript secrets");
      const item = { operationId, namespace: `supercuts:${this.profile.role}`, blobId: `mockwalrus_${hash(`${operationId}:${fact}`).slice(0, 40)}`, fact, status: "complete" }; record(this.store, "memory", operationId, item); return output(command, { operationId, namespace: item.namespace, blobId: item.blobId, status: item.status, provenance: "legacy_untrusted" });
    }
    if (command === "memory.recall") {
      const items = [...all<Record<string, unknown>>(this.store, "memory"), ...all<Record<string, unknown>>(this.store, "verified-memory")], query = required(args, "query").toLowerCase();
      const found = items.filter((item) => String(item.fact ?? "").toLowerCase().includes(query) || item.memory); const citations = found.map((item) => { const memory = item.memory as SettlementMemoryV1 | undefined; return { blobId: String(item.blobId), kind: memory?.kind ?? "legacy", provenance: memory?.provenance ?? "legacy_untrusted", distance: 0 }; }); return output(command, { namespace: `supercuts:${this.profile.role}`, citations, effect: citations.length ? "candidate-preference-adjusted" : "no-policy-change" });
    }
    if (command === "memory.status") { const items = all<Record<string, unknown>>(this.store, "memory"); return output(command, { namespace: `supercuts:${this.profile.role}`, completed: items.length, jobs: items.map(({ operationId, blobId, status }) => ({ operationId, blobId, status })) }); }
    if (command === "disclose") {
      const dealId = required(args, "deal-id"), auditor = required(args, "auditor"), paymentDigest = required(args, "payment-digest");
      const pkg = { version: 1, dealId, auditor, paymentDigest, transcriptRoot: required(args, "transcript-root"), verifiedAuthors: ["buyer", "seller"], mockEvidence: this.profile.mock, packageHash: "" }; pkg.packageHash = hash(json({ ...pkg, packageHash: undefined }));
      record(this.store, "disclosure", dealId, pkg); return output(command, { package: Buffer.from(json(pkg)).toString("base64"), packageHash: pkg.packageHash, auditor, dealId });
    }
    if (command === "audit.verify") {
      let pkg: Record<string, unknown>; try { pkg = JSON.parse(Buffer.from(required(args, "package"), "base64").toString()) as Record<string, unknown>; } catch (error) { return fail("AUDIT_PACKAGE_INVALID", "package is not valid base64 JSON", error); }
      if (pkg.auditor !== required(args, "auditor") || pkg.dealId !== required(args, "deal-id")) fail("AUDIT_SCOPE_MISMATCH", "package is for another auditor or deal");
      return output(command, { dealId: pkg.dealId, agreementVerified: true, paymentVerified: true, transactionDigest: pkg.paymentDigest, evidence: "mock-not-funded" });
    }
    return fail("COMMAND_UNKNOWN", `unknown command ${command}`);
  }

  private pay(command: string, args: Record<string, string | boolean>): CommandResult {
    this.doctor();
    const rail = command === "pay.shielded" ? "shielded" : "x402", checked = this.paymentPolicy(args, rail);
    const operationId = required(args, "operation-id"), requestId = typeof args["request-id"] === "string" ? args["request-id"] : operationId;
    this.bindSettlementPlan(command as "pay.x402" | "pay.shielded", args, { amount: checked.amount.toString(), counterparty: checked.counterparty, asset: checked.asset, ...(typeof args["resource-url"] === "string" ? { endpoint: args["resource-url"] } : {}), requestId, ...(typeof args.session === "string" ? { session: args.session } : {}) });
    const payload = hash(`${rail}:${checked.amount}:${checked.counterparty}:${checked.asset}:${requestId}`), existing = get<Record<string, unknown>>(this.store, "payment", operationId);
    if (existing) { if (existing.payloadHash !== payload) fail("OPERATION_ID_CONFLICT", "operation ID already identifies another payment"); return output(command, existing); }
    const transactionDigest = this.digest(rail, operationId), payment = { operationId, status: args["broadcast-only"] === true ? "broadcast" : "finalized", rail, amount: checked.amount.toString(), counterparty: checked.counterparty, asset: checked.asset, requestId, payloadHash: payload, transactionDigest, policyDecision: "allowed", tatumVerified: args["broadcast-only"] !== true, visibility: rail === "shielded" ? "no-direct-public-payment; funding-deposits-withdrawals-gas-and-pool-activity-visible" : "public-transfer", evidence: this.evidence(), ...(typeof args["plan-hash"] === "string" ? { planHash: args["plan-hash"] } : {}) };
    record(this.store, "payment", operationId, payment); this.enqueueVerifiedOutcome("settlement", operationId, payment, typeof args["plan-hash"] === "string" ? args["plan-hash"] : undefined, { counterparty: checked.counterparty, asset: checked.asset }); return output(command, payment);
  }
  private digest(kind: string, id: string): string { return `mocktx_${hash(`${kind}:${id}`).slice(0, 44)}`; }
  private evidence(): string { return "deterministic-mock-not-funded"; }
}

export function output(command: string, data: Record<string, unknown>): CommandResult { return { schemaVersion: "supercuts.v1", ok: true, command, data }; }
export function errorOutput(error: unknown): Record<string, unknown> {
  const known = error instanceof SupercutsError ? error : new SupercutsError("INTERNAL_ERROR", error instanceof Error ? error.message : "unknown error");
  const retryable = ["BROADCAST_UNRESOLVED", "DELIVERY_IN_PROGRESS", "DELIVERY_PENDING", "DEAL_SELLER_UNAVAILABLE", "ONBOARDING_SERVICE_UNAVAILABLE", "SELLER_DIRECTORY_UNAVAILABLE", "WALRUS_WRITE_FAILED", "WALRUS_READ_FAILED", "X402_FACILITATOR_UNAVAILABLE", "X402_RESIGN_UNSAFE"].includes(known.code);
  const sameOperation = retryable || ["OPERATION_ID_CONFLICT", "DEAL_OPERATION_CONFLICT"].includes(known.code);
  return { schemaVersion: "supercuts.v1", ok: false, error: { code: known.code, message: known.message, recovery: recovery(known.code), retryable, retryWithSameOperationId: sameOperation } };
}
function recovery(code: string): string {
  if (code === "LOCAL_AUTH_REQUIRED") return "repeat with --authorize after reviewing the operation";
  if (code === "PROFILE_NOT_FOUND") return "run supercuts init --role <role> --mock";
  if (code === "X402_RESIGN_UNSAFE") return "retry with the same operation ID; never start a second payment while the prior signed transaction can still settle";
  if (code.startsWith("POLICY_")) return "change the request or update the owner-controlled profile policy";
  if (code === "ARTIFACT_HASH_MISMATCH") return "restore the pinned artifact or reinitialize with an audited manifest";
  if (code === "SESSION_MISMATCH") return "read status.session.runId and retry with that session, or omit runId on the v2 deal path";
  if (code === "DEAL_MANDATE_INACTIVE") return "renew the owner mandate locally, then resume the same deal operation ID";
  if (code === "BROADCAST_UNRESOLVED") return "reconcile or resume with the same operation ID; never create a replacement payment";
  if (code === "DELIVERY_PENDING") return "resume the same root operation ID; completed selection, payment, and agreement stages will not run again";
  if (code === "DEAL_SELLER_UNAVAILABLE") return "check the seller /health endpoint, then resume the same root operation ID";
  if (code === "X402_FACILITATOR_UNAVAILABLE") return "the signed transaction remains journaled; resume the same operation ID after facilitator health recovers";
  if (code === "OPERATION_ID_CONFLICT" || code === "DEAL_OPERATION_CONFLICT") return "reuse the original exact input for this operation ID or start a deliberately new deal";
  if (code === "X402_TRANSACTION_EXPIRY_INVALID") return "run onboarding doctor against the configured Sui RPC and retry the same operation ID after compatibility is restored";
  return "inspect the stable error code and retry with corrected input";
}
