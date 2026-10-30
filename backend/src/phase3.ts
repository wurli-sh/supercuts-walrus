import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadStateKey } from "./config.js";
import { fail, SupercutsError } from "./errors.js";
import { RoleStore } from "./store.js";
import { LiveRuntime, type LiveRuntimeProfile } from "./live-runtime.js";

export type Role = "buyer" | "seller" | "auditor";
export interface Profile {
  version: 1 | 2; role: Role; network: "testnet"; mock: boolean;
  packageId: string; poolId: string; coinType: string; verifierVersion: number;
  artifactManifest: string; artifactManifestSha256: string;
  policy: { maxAmount: string; allowedAssets: string[]; allowedCounterparties: string[]; requiredPrivacy: "any" | "shielded"; expiresAt: number };
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
const COIN = "0x2::sui::SUI";
const WRITE = new Set(["wallet.deposit", "wallet.recover", "wallet.withdraw", "offer.open", "offer.propose", "offer.counter", "offer.accept", "pay.shielded", "pay.x402", "resource.serve", "memory.remember", "disclose", "capability.publish"]);
const ROLE_COMMANDS: Record<Role, ReadonlySet<string>> = {
  buyer: new Set(["status", "doctor", "capability.discover", "wallet.deposit", "wallet.balance", "wallet.recover", "wallet.withdraw", "offer.open", "offer.propose", "offer.accept", "offer.show", "pay.quote", "pay.shielded", "pay.x402", "pay.status", "resource.fetch", "memory.remember", "memory.recall", "memory.status", "disclose"]),
  seller: new Set(["status", "doctor", "capability.publish", "wallet.balance", "wallet.recover", "wallet.withdraw", "offer.counter", "offer.show", "pay.status", "resource.serve", "resource.fetch", "memory.remember", "memory.recall", "memory.status"]),
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
    if (!token.startsWith("--")) fail("ARGUMENT_INVALID", `unexpected argument ${token}`);
    const key = token.slice(2);
    const next = values[i + 1];
    if (next && !next.startsWith("--")) { result[key] = next; i++; } else result[key] = true;
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
  if (deployment && (deployment.network !== "testnet" || deployment.testOnly !== true || deployment.packageId !== PACKAGE || deployment.poolId !== POOL || deployment.coinType !== COIN || deployment.verifierVersion !== 1)) fail("DEPLOYMENT_ID_MISMATCH", "live initialization only accepts the pinned Phase 1 Testnet deployment");
  const manifestValue = String(deployment?.artifactManifest ?? "");
  const manifest = isMock ? (typeof args["artifact-manifest"] === "string" ? resolve(args["artifact-manifest"]) : "mock:pinned-phase1") : (() => { if (!manifestValue) return fail("CONFIG_INVALID", "deployment artifactManifest is missing"); if (isAbsolute(manifestValue)) return manifestValue; const candidates = [resolve(manifestValue), resolve(dirname(deploymentPath!), "..", manifestValue)]; return candidates.find(existsSync) ?? fail("PROVING_ARTIFACT_MISSING", "deployment artifact manifest could not be resolved"); })();
  const manifestHash = manifest.startsWith("mock:") ? hash(manifest) : hash(readFileSync(manifest));
  const endpoint = (name: string): string => { const value = required(args, name); return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`; };
  const credential = (name: string): Buffer => { const path = resolve(required(args, name)); if ((statSync(path).mode & 0o077) !== 0) fail("CREDENTIAL_PERMISSIONS", `${name} must be owner-only`); const value = readFileSync(path); if (!value.length || value.length > 4096) fail("CREDENTIAL_INVALID", `${name} is empty or too large`); return Buffer.from(value.toString().trim()); };
  const liveCredentials = deployment ? { sui: credential("sui-key-file"), tatum: credential("tatum-key-file") } : undefined;
  const artifactRoot = manifest.startsWith("mock:") ? "" : resolve(manifest, ".."); const repositoryRoot = artifactRoot ? resolve(artifactRoot, "../..") : "";
  const live = deployment ? {
    coinTypeHash: String(deployment.coinTypeHash), deploymentDomain: String(deployment.deploymentDomain), initialRoot: String(deployment.initialRoot), deploymentCheckpoint: String(deployment.deploymentCheckpoint),
    writeGrpcEndpoint: endpoint("write-grpc"), tatumGrpcEndpoint: endpoint("tatum-grpc"), artifactRoot,
    snarkjsPath: typeof args["snarkjs"] === "string" ? resolve(args["snarkjs"]) : resolve(artifactRoot, "../node_modules/.bin/snarkjs"), converterPath: typeof args.converter === "string" ? resolve(args.converter) : resolve(repositoryRoot, "target/debug/supercuts-groth16"),
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
    }, ...(live ? { live } : {}),
  };
  writeFileSync(join(home, "profile.json"), `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  const stateKey = randomBytes(32); writeFileSync(join(home, "state.key"), stateKey, { mode: 0o600 });
  if (live) {
    const store = new RoleStore(join(home, "state.sqlite"), stateKey);
    try {
      store.putSecretOnce("live:sui-private-key", liveCredentials!.sui); store.putSecretOnce("live:tatum-api-key", liveCredentials!.tatum); store.putSecretOnce("identity:babyjub-seed", randomBytes(32));
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
    if (operationId) {
      const durable = this.store.db.prepare("SELECT intent_hash FROM authorized_operations WHERE operation_id=?").get(operationId) as { intent_hash: string } | undefined;
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
      if (operationId) this.store.db.prepare("INSERT INTO authorized_operations(operation_id,intent_hash,created_at) VALUES(?,?,?)").run(operationId, normalized.intentHash, Date.now());
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

  private async executeLive(command: string, args: Record<string, string | boolean>): Promise<CommandResult> {
    if (!this.profile.live) fail("LIVE_PROFILE_INVALID", "live profile configuration is missing");
    const runtime = await LiveRuntime.create(this.profile as LiveRuntimeProfile, this.store);
    if (command === "doctor") return output(command, await runtime.doctor());
    if (command === "status") return output(command, { role: this.profile.role, network: this.profile.network, mock: false, runtime: "testnet-live" });
    if (command === "wallet.balance") return output(command, await runtime.balance());
    if (command === "wallet.recover") return output(command, await runtime.recover());
    if (command === "wallet.deposit") return output(command, await runtime.deposit(amount(args), required(args, "operation-id")));
    if (command === "wallet.withdraw") return output(command, await runtime.withdraw(required(args, "commitment"), required(args, "recipient"), required(args, "operation-id")));
    if (command === "offer.accept") return output(command, runtime.acceptAgreement(required(args, "session"), required(args, "agreement")));
    if (command === "offer.counter") return output(command, runtime.prepareSellerAgreement(required(args, "session"), required(args, "agreement")));
    if (command === "pay.shielded") return output(command, await runtime.settleShielded(required(args, "session"), required(args, "operation-id")));
    if (command === "pay.x402") return output(command, await runtime.payX402Resource(required(args, "operation-id"), required(args, "resource-url")));
    return fail("LIVE_COMMAND_UNAVAILABLE", `${command} is not connected to the Testnet runtime`);
  }
  execute(command: string, args: Record<string, string | boolean>): CommandResult;
  execute(command: string, args: Record<string, string | boolean>): CommandResult | Promise<CommandResult> {
    this.allow(command, args);
    if (!this.profile.mock) return this.executeLive(command, args);
    if (command === "doctor") return output(command, this.doctor());
    if (command === "status") return output(command, { role: this.profile.role, network: this.profile.network, operations: all(this.store, "payment").length, mock: this.profile.mock });
    if (command === "capability.publish") {
      const capabilityId = typeof args["capability-id"] === "string" ? args["capability-id"] : `cap_${randomUUID()}`;
      const item = { capabilityId, seller: required(args, "seller"), service: required(args, "service"), terms: required(args, "terms"), blobId: `${this.profile.mock ? "mockwalrus" : "walrus"}_${hash(`${capabilityId}:${String(args.seller)}:${String(args.service)}`).slice(0, 40)}`, visibility: "public-capability" };
      record(this.store, "capability", capabilityId, item); return output(command, item);
    }
    if (command === "capability.discover") {
      const configured = typeof args.capabilities === "string" ? JSON.parse(Buffer.from(args.capabilities, "base64url").toString()) as unknown : [];
      if (!Array.isArray(configured)) fail("CAPABILITY_LIST_INVALID", "configured capabilities must be an array");
      return output(command, { capabilities: configured, source: this.profile.mock ? "configured-mock" : "configured-walrus-blob-ids" });
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
      return output(command, offer);
    }
    if (command === "offer.show") return output(command, get<Record<string, unknown>>(this.store, "offer", required(args, "session")) ?? fail("OFFER_NOT_FOUND", "offer session was not found"));
    if (command === "pay.quote") {
      const rail = required(args, "rail") as "shielded" | "x402"; if (!(["shielded", "x402"] as string[]).includes(rail)) fail("RAIL_INVALID", "rail must be shielded or x402");
      const checked = this.paymentPolicy(args, rail); return output(command, { rail, amount: checked.amount.toString(), counterparty: checked.counterparty, asset: checked.asset, policyDecision: "allowed", visibility: rail === "shielded" ? "amount-and-parties-hidden-in-pool" : "public-transfer" });
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
      return output(command, { requestId, responseHash: hash(body), body, deliveryStatus: "delivered" });
    }
    if (command === "memory.remember") {
      const operationId = required(args, "operation-id"), fact = required(args, "fact"); if (/private key|spend secret|seed phrase|full transcript/i.test(fact)) fail("MEMORY_SECRET_REJECTED", "memory cannot contain wallet or transcript secrets");
      const item = { operationId, namespace: `supercuts:${this.profile.role}`, blobId: `mockwalrus_${hash(`${operationId}:${fact}`).slice(0, 40)}`, fact, status: "complete" }; record(this.store, "memory", operationId, item); return output(command, item);
    }
    if (command === "memory.recall") {
      const items = all<Record<string, unknown>>(this.store, "memory"), query = required(args, "query").toLowerCase();
      const found = items.find((item) => String(item.fact).toLowerCase().includes(query)); return output(command, { namespace: `supercuts:${this.profile.role}`, recalled: found?.fact ?? null, effect: found ? "candidate-preference-adjusted" : "no-policy-change" });
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
    const payload = hash(`${rail}:${checked.amount}:${checked.counterparty}:${checked.asset}:${requestId}`), existing = get<Record<string, unknown>>(this.store, "payment", operationId);
    if (existing) { if (existing.payloadHash !== payload) fail("OPERATION_ID_CONFLICT", "operation ID already identifies another payment"); return output(command, existing); }
    const transactionDigest = this.digest(rail, operationId), payment = { operationId, status: args["broadcast-only"] === true ? "broadcast" : "finalized", rail, amount: checked.amount.toString(), counterparty: checked.counterparty, asset: checked.asset, requestId, payloadHash: payload, transactionDigest, policyDecision: "allowed", tatumVerified: args["broadcast-only"] !== true, visibility: rail === "shielded" ? "amount-and-parties-hidden-in-pool" : "public-transfer", evidence: this.evidence() };
    record(this.store, "payment", operationId, payment); return output(command, payment);
  }
  private digest(kind: string, id: string): string { return `mocktx_${hash(`${kind}:${id}`).slice(0, 44)}`; }
  private evidence(): string { return "deterministic-mock-not-funded"; }
}

export function output(command: string, data: Record<string, unknown>): CommandResult { return { schemaVersion: "supercuts.v1", ok: true, command, data }; }
export function errorOutput(error: unknown): Record<string, unknown> {
  const known = error instanceof SupercutsError ? error : new SupercutsError("INTERNAL_ERROR", error instanceof Error ? error.message : "unknown error");
  return { schemaVersion: "supercuts.v1", ok: false, error: { code: known.code, message: known.message, recovery: recovery(known.code) } };
}
function recovery(code: string): string {
  if (code === "LOCAL_AUTH_REQUIRED") return "repeat with --authorize after reviewing the operation";
  if (code === "PROFILE_NOT_FOUND") return "run supercuts init --role <role> --mock";
  if (code.startsWith("POLICY_")) return "change the request or update the owner-controlled profile policy";
  if (code === "ARTIFACT_HASH_MISMATCH") return "restore the pinned artifact or reinitialize with an audited manifest";
  return "inspect the stable error code and retry with corrected input";
}
