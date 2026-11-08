import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { fail } from "./errors.js";
import { Phase3App, initialize } from "./phase3.js";
import { loadMandate, type AgentMandate } from "./mandate.js";
import { LiveDealPorts } from "./live-deal-ports.js";
import { verifySignedCapability, type SignedCapabilityRegistration } from "./capability.js";
import { WalrusDealBlobs } from "./deal-wire.js";
import { canonicalJson } from "./settlement.js";
import { validateDirectoryOrigin } from "./seller-directory.js";
import { TESTNET_DEFAULTS, withTestnetDefaults } from "./testnet-defaults.js";

interface BuyerSetup {
  deploymentConfig: string; tatumKeyFile: string; writeGrpc: string; tatumGrpc: string;
  walrusPublisher: string; walrusAggregator: string; memoryConfigFile?: string;
  sellerOrigins?: string[]; directoryUrl?: string; allowedCounterparties?: string[]; allowedCapabilityIds?: string[];
  allowedCapabilityClasses?: string[]; perDealCeiling: string; totalBudget: string;
  expiresAt: number; allowPublicX402?: boolean; suiKeyFile?: string; rapidsnark?: string;
}

function ownerFile(path: string): void {
  if ((statSync(path).mode & 0o077) !== 0) fail("SETUP_PERMISSIONS", `${path} must be owner-only`);
}
function amount(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) fail("SETUP_INVALID", `${name} must be a positive base-unit string`);
  return value as string;
}
function origins(values: unknown): string[] {
  if (!Array.isArray(values) || !values.length || values.length > 32) fail("SETUP_INVALID", "sellerOrigins requires 1..32 origins");
  return (values as unknown[]).map((value) => {
    const url = new URL(String(value));
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) fail("SETUP_INVALID", "seller origin must be HTTPS or loopback HTTP without path or credentials");
    return url.origin;
  });
}
function validateConfig(config: BuyerSetup): BuyerSetup {
  withTestnetDefaults(config);
  if (!config.sellerOrigins?.length && !config.directoryUrl) config.directoryUrl = TESTNET_DEFAULTS.directoryUrl;
  amount(config.perDealCeiling, "perDealCeiling"); amount(config.totalBudget, "totalBudget");
  if (BigInt(config.totalBudget) < BigInt(config.perDealCeiling)) fail("SETUP_INVALID", "totalBudget must cover one permitted deal");
  if (!Number.isSafeInteger(config.expiresAt) || config.expiresAt <= Date.now()) fail("SETUP_INVALID", "expiresAt must be a future Unix millisecond timestamp");
  if (!Array.isArray(config.allowedCounterparties ?? []) || (config.allowedCounterparties ?? []).some((item) => typeof item !== "string" || !/^0x[0-9a-f]{64}$/i.test(item))) fail("SETUP_INVALID", "allowedCounterparties requires seller Sui addresses");
  if (config.sellerOrigins?.length) origins(config.sellerOrigins);
  if (!config.sellerOrigins?.length && !config.directoryUrl) fail("SETUP_INVALID", "configure a directoryUrl or sellerOrigins");
  if (config.directoryUrl) origins([config.directoryUrl]);
  for (const key of ["deploymentConfig", "tatumKeyFile", "writeGrpc", "tatumGrpc", "walrusPublisher", "walrusAggregator"] as const) if (typeof config[key] !== "string" || !config[key]) fail("SETUP_INVALID", `${key} is required`);
  for (const path of [config.tatumKeyFile, ...(config.memoryConfigFile ? [config.memoryConfigFile] : []), ...(config.suiKeyFile ? [config.suiKeyFile] : [])]) ownerFile(resolve(path));
  const deployment = JSON.parse(readFileSync(resolve(config.deploymentConfig), "utf8")) as { verifierVersion?: number; network?: string };
  if (deployment.network !== "testnet" || deployment.verifierVersion !== 2) fail("SETUP_INVALID", "buyer setup requires the pinned v2 Testnet deployment");
  if (config.allowPublicX402 !== undefined && typeof config.allowPublicX402 !== "boolean") fail("SETUP_INVALID", "allowPublicX402 must be boolean");
  for (const list of [config.allowedCapabilityIds, config.allowedCapabilityClasses]) if (list !== undefined && (!Array.isArray(list) || list.some((item) => typeof item !== "string" || !item))) fail("SETUP_INVALID", "capability allowlists must contain nonempty strings");
  return config;
}
function readConfig(path: string): BuyerSetup { ownerFile(path); return validateConfig(JSON.parse(readFileSync(path, "utf8")) as BuyerSetup); }
function writePolicy(home: string, config: BuyerSetup): void {
  const path = join(home, "mandate.json"), mandate = loadMandate(home);
  const base: AgentMandate = { ...mandate }; delete base.allowedCapabilityIds; delete base.allowedCapabilityClasses;
  const next: AgentMandate = { ...base, version: "supercuts.mandate.v2", allowedCommands: [...new Set([...mandate.allowedCommands, "deal.execute", "deal.get", "deal.resume", "deal.evidence", "deal.delivery", "deal.catalog", "deal.policy", "settlement.plan", "memory.inventory", "remote.research"])], allowedCounterparties: config.allowedCounterparties ?? [], perDealCeiling: config.perDealCeiling, totalRunBudget: config.totalBudget, expiresAt: config.expiresAt, requiredPrivacy: "any", requireSettlementPlan: true, allowedRails: config.allowPublicX402 === true ? ["shielded", "x402"] : ["shielded"], allowPublicX402: config.allowPublicX402 === true, ...(config.allowedCapabilityIds ? { allowedCapabilityIds: config.allowedCapabilityIds } : {}), ...(config.allowedCapabilityClasses ? { allowedCapabilityClasses: config.allowedCapabilityClasses } : {}) };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 }); chmodSync(path, 0o600);
  writeFileSync(join(home, "deal-sellers.json"), `${JSON.stringify(config.directoryUrl ? { directoryUrl: origins([config.directoryUrl])[0], origins: config.sellerOrigins?.length ? origins(config.sellerOrigins) : [] } : origins(config.sellerOrigins ?? []), null, 2)}\n`, { mode: 0o600 });
  const profilePath = join(home, "profile.json"), profile = JSON.parse(readFileSync(profilePath, "utf8")) as { policy: { allowedCounterparties: string[]; maxAmount: string; expiresAt: number } };
  profile.policy.allowedCounterparties = [...next.allowedCounterparties]; profile.policy.maxAmount = config.perDealCeiling; profile.policy.expiresAt = config.expiresAt;
  writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 }); chmodSync(profilePath, 0o600);
}
export function setupBuyer(home: string, configPath: string): Record<string, unknown> { return setupBuyerConfig(home, readConfig(resolve(configPath))); }
export async function promptBuyerSetup(home: string): Promise<Record<string, unknown>> {
  if (!process.stdin.isTTY) fail("SETUP_INPUT_REQUIRED", "interactive setup requires a terminal; use --config with an owner-only JSON file");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const ask = async (label: string, fallback?: string) => (await rl.question(fallback ? `${label} [${fallback}]: ` : `${label}: `)).trim() || fallback || "";
    process.stderr.write("Press Enter to accept a bracketed default. Credentials are read from owner-only files, never typed here.\n");
    const days = Number(await ask("Policy duration in days", "14"));
    if (!Number.isSafeInteger(days) || days < 1 || days > 365) fail("SETUP_INVALID", "policy duration must be 1..365 days");
    const config: BuyerSetup = {
      deploymentConfig: await ask("Pinned Testnet deployment config path", "bundled"), tatumKeyFile: await ask("Owner-only Tatum API key file path"),
      writeGrpc: await ask("Sui write gRPC URL", TESTNET_DEFAULTS.writeGrpc), tatumGrpc: await ask("Tatum read gRPC URL", TESTNET_DEFAULTS.tatumGrpc),
      walrusPublisher: await ask("Walrus publisher URL", TESTNET_DEFAULTS.walrusPublisher), walrusAggregator: await ask("Walrus aggregator URL", TESTNET_DEFAULTS.walrusAggregator),
      memoryConfigFile: await ask("Owner-only Walrus Memory config path (blank to skip Memory)"),
      directoryUrl: await ask("Shared directory origin (type none for direct sellers only)", TESTNET_DEFAULTS.directoryUrl),
      sellerOrigins: (await ask("Additional seller HTTPS origins, comma separated (or blank)")).split(",").map((item) => item.trim()).filter(Boolean),
      allowedCounterparties: (await ask("Initially approved seller Sui addresses, comma separated (or blank)")).split(",").map((item) => item.trim()).filter(Boolean),
      perDealCeiling: await ask("Maximum per deal in MIST", "2000000"), totalBudget: await ask("Lifetime cumulative budget in MIST", "10000000"),
      expiresAt: Date.now() + days * 24 * 60 * 60 * 1000, allowPublicX402: (await ask("Allow public x402 when requested? yes/no")).toLowerCase() === "yes",
    };
    if (config.deploymentConfig === "bundled") config.deploymentConfig = "";
    if (!config.directoryUrl || config.directoryUrl === "none") delete config.directoryUrl;
    return setupBuyerConfig(home, validateConfig(config));
  } finally { rl.close(); }
}
function setupBuyerConfig(home: string, config: BuyerSetup): Record<string, unknown> {
  if (existsSync(join(home, "profile.json"))) fail("PROFILE_EXISTS", "buyer home already exists; use setup renew for a standing policy update");
  mkdirSync(home, { recursive: true, mode: 0o700 }); chmodSync(home, 0o700);
  const keyPath = config.suiKeyFile ? resolve(config.suiKeyFile) : join(home, "buyer.sui.key");
  if (!config.suiKeyFile) writeFileSync(keyPath, Ed25519Keypair.generate().getSecretKey(), { mode: 0o600, flag: "wx" });
  ownerFile(keyPath);
  initialize(home, { role: "buyer", "deployment-config": resolve(config.deploymentConfig), "sui-key-file": keyPath, "tatum-key-file": resolve(config.tatumKeyFile), "write-grpc": config.writeGrpc, "tatum-grpc": config.tatumGrpc, "walrus-publisher": config.walrusPublisher, "walrus-aggregator": config.walrusAggregator, ...(config.memoryConfigFile ? { "memory-config-file": resolve(config.memoryConfigFile) } : {}), "allow-counterparty": (config.allowedCounterparties ?? []).join(","), "max-amount": config.perDealCeiling, ...(config.rapidsnark ? { rapidsnark: resolve(config.rapidsnark) } : {}) });
  writePolicy(home, config);
  const session = createBuyerSession(home);
  const decoded = decodeSuiPrivateKey(readFileSync(keyPath, "utf8").trim());
  if (decoded.scheme !== "ED25519") fail("SETUP_INVALID", "buyer key must use ED25519");
  const address = Ed25519Keypair.fromSecretKey(decoded.secretKey).toSuiAddress();
  return { home, address, ...session, policy: "configured", nextSteps: [
    `Fund only this buyer with Testnet SUI: supercuts funding execute --home ${home} --public-payment <MIST> --shielded-payment 0 --operation-id fund-1 --request-faucet --confirm (or use https://faucet.sui.io for ${address})`,
    ...(config.allowedCounterparties?.length ? [] : [`Review the directory, then approve a seller: supercuts policy approve-seller --home ${home} --capability-id <id>`]),
    ...(config.memoryConfigFile ? [`Keep the Walrus Memory embedding adapter running (supercuts-embedding-adapter). An MCP agent flushes outcome memories itself; SDK-only hosts also run: supercuts-memory-worker ${home}`] : []),
    "For shielded (private) payments, install the hash-pinned proving keys once per machine (~370 MB): supercuts proofs install",
    `Check readiness: supercuts onboarding doctor --home ${home}`,
    `Connect Codex: ${session.codexCommand} (or merge ${session.mcpConfig}); other agents can call BuyerClient.executeDeal from @supercuts-walrus/sdk.`,
  ] };
}
/**
 * pnpm resolves this module to its versioned store path (`.pnpm/<pkg>@<version>_<peers>/...`),
 * which disappears on the next upgrade. Prefer the project's `node_modules/@supercuts-walrus/backend`
 * link when it points at the same file, so the Codex config keeps working after `pnpm up`.
 */
export function stableMcpScript(realScript = join(dirname(fileURLToPath(import.meta.url)), "mcp-bootstrap.js"), cwd = process.cwd()): string {
  const linked = join(cwd, "node_modules", "@supercuts-walrus", "backend", "dist", "mcp-bootstrap.js");
  try { if (realpathSync(linked) === realpathSync(realScript)) return linked; } catch { /* not installed in cwd */ }
  return realScript;
}
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
/** One command that registers the buyer MCP server in Codex, instead of hand-merging TOML. */
export function codexAddCommand(node: string, script: string, env: Record<string, string>): string {
  const flags = Object.entries(env).map(([key, value]) => `--env ${shellQuote(`${key}=${value}`)}`).join(" ");
  return `codex mcp add supercuts-buyer ${flags} -- ${shellQuote(node)} ${shellQuote(script)}`;
}
export function createBuyerSession(home: string): Record<string, unknown> {
  if (!existsSync(join(home, "profile.json"))) fail("SETUP_REQUIRED", "initialize the buyer before creating a Codex session");
  const runId = randomUUID(), eventPath = join(home, `events-${runId}.jsonl`), mcpScript = stableMcpScript();
  const env: Record<string, string> = { SUPERCUTS_HOME: home, SUPERCUTS_RUN_ID: runId, SUPERCUTS_EVENT_PATH: eventPath };
  // A non-default proofs location chosen at setup must follow the MCP server, which Codex starts elsewhere.
  if (process.env.SUPERCUTS_PROOFS_DIR) env.SUPERCUTS_PROOFS_DIR = resolve(process.env.SUPERCUTS_PROOFS_DIR);
  const mcp = `[mcp_servers.supercuts-buyer]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([mcpScript])}\n[mcp_servers.supercuts-buyer.env]\n${Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`).join("")}`;
  const mcpConfig = join(home, "buyer-codex.toml");
  writeFileSync(mcpConfig, mcp, { mode: 0o600 }); chmodSync(mcpConfig, 0o600);
  return { runId, eventPath, mcpConfig, codexCommand: codexAddCommand(process.execPath, mcpScript, env) };
}
export function renewBuyer(home: string, configPath: string): Record<string, unknown> {
  const config = readConfig(resolve(configPath));
  const prior = loadMandate(home);
  if (prior.role !== "buyer" || prior.version !== "supercuts.mandate.v2") fail("SETUP_INVALID", "renewal requires an initialized v2 buyer home");
  config.allowedCounterparties ??= [...prior.allowedCounterparties];
  if (config.allowedCapabilityIds === undefined && prior.allowedCapabilityIds) config.allowedCapabilityIds = [...prior.allowedCapabilityIds];
  if (config.allowedCapabilityClasses === undefined && prior.allowedCapabilityClasses) config.allowedCapabilityClasses = [...prior.allowedCapabilityClasses];
  const spent = (readReserved(home));
  if (BigInt(config.totalBudget) < spent) fail("SETUP_INVALID", "renewed lifetime budget is below already reserved spend");
  writePolicy(home, config);
  return { home, policy: "renewed", reservedMist: spent.toString(), remainingMist: (BigInt(config.totalBudget) - spent).toString() };
}
export async function approveBuyerSeller(home: string, capabilityId: string): Promise<Record<string, unknown>> {
  if (!capabilityId) fail("ARGUMENT_REQUIRED", "--capability-id is required");
  const mandate = loadMandate(home);
  if (mandate.role !== "buyer" || mandate.version !== "supercuts.mandate.v2") fail("SETUP_INVALID", "seller approval requires a v2 buyer home");
  const sourcePath = join(home, "deal-sellers.json"); ownerFile(sourcePath);
  const source = JSON.parse(readFileSync(sourcePath, "utf8")) as { directoryUrl?: string; origins?: string[] };
  if (!source.directoryUrl && !source.origins?.length) fail("SELLER_DIRECTORY_UNAVAILABLE", "buyer has no configured shared directory or seller origins");
  const matches: SignedCapabilityRegistration[] = [], direct = new Set<SignedCapabilityRegistration>();
  // Owner-configured seller origins are searched first; their signed capabilities must point back at that origin.
  for (const origin of source.origins ?? []) {
    const response = await fetch(new URL("/v2/catalog", origin), { redirect: "error", signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    if (!response?.ok) continue;
    const catalog = await response.json() as { capabilities?: SignedCapabilityRegistration[] };
    for (const item of Array.isArray(catalog.capabilities) ? catalog.capabilities.slice(0, 100) : []) {
      if (item.manifest?.capabilityId !== capabilityId || new URL(item.manifest.endpoint).origin !== new URL(origin).origin) continue;
      matches.push(item); direct.add(item);
    }
  }
  for (let offset = 0; source.directoryUrl && offset <= 100_000;) {
    const response = await fetch(new URL(`/v2/directory/catalog?offset=${offset}`, source.directoryUrl), { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) fail("SELLER_DIRECTORY_UNAVAILABLE", `directory returned HTTP ${response.status}`);
    const catalog = await response.json() as { capabilities?: SignedCapabilityRegistration[]; nextOffset?: number };
    if (!Array.isArray(catalog.capabilities) || catalog.capabilities.length > 100) fail("SELLER_DIRECTORY_INVALID", "directory catalog is invalid");
    matches.push(...(catalog.capabilities ?? []).filter((item) => item.manifest?.capabilityId === capabilityId));
    if (catalog.nextOffset === undefined) break;
    if (catalog.nextOffset !== offset + 100 || catalog.capabilities?.length !== 100) fail("SELLER_DIRECTORY_INVALID", "directory pagination is invalid");
    offset = catalog.nextOffset;
  }
  if (matches.length !== 1) fail("SELLER_DIRECTORY_INVALID", "capability must resolve to exactly one live registration in the directory or configured seller origins");
  const registration = matches[0]!; await verifySignedCapability(registration);
  // Directory listings must use public HTTPS origins; a direct origin was chosen by the owner at setup.
  const endpoint = direct.has(registration) ? new URL(registration.manifest.endpoint) : await validateDirectoryOrigin(registration.manifest.endpoint);
  const sellerResponse = await fetch(new URL("/v2/catalog", endpoint.origin), { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!sellerResponse.ok) fail("SELLER_CATALOG_INVALID", "seller endpoint is unavailable");
  const served = await sellerResponse.json() as { capabilities?: unknown[] };
  if (!Array.isArray(served.capabilities) || !served.capabilities.some((item) => canonicalJson(item) === canonicalJson(registration))) fail("SELLER_CATALOG_INVALID", "seller no longer serves this signed capability");
  const app = new Phase3App(home);
  try {
    const readback = await new WalrusDealBlobs(app).read(registration.manifestBlobId);
    if (canonicalJson(JSON.parse(Buffer.from(readback).toString())) !== canonicalJson(registration.manifest)) fail("CAPABILITY_BLOB_MISMATCH", "directory manifest differs from Walrus");
  } finally { app.close(); }
  const path = join(home, "mandate.json"), profilePath = join(home, "profile.json");
  const updated = { ...mandate, allowedCounterparties: [...new Set([...mandate.allowedCounterparties, registration.manifest.sellerId])] };
  if (updated.allowedCapabilityIds) updated.allowedCapabilityIds = [...new Set([...updated.allowedCapabilityIds, capabilityId])];
  const profile = JSON.parse(readFileSync(profilePath, "utf8")) as { policy: { allowedCounterparties: string[] } };
  profile.policy.allowedCounterparties = updated.allowedCounterparties;
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  return { capabilityId, sellerId: registration.manifest.sellerId, approved: true, manifestHash: registration.manifest.manifestHash, description: registration.manifest.description, priceBand: registration.manifest.priceBand, asset: registration.manifest.asset, supportedRails: registration.manifest.supportedRails, expiresAt: registration.manifest.expiresAt };
}
export async function addBuyerPrivacyRule(home: string, capabilityId: string): Promise<Record<string, unknown>> {
  const app = new Phase3App(home);
  try {
    if (app.profile.role !== "buyer" || app.profile.mock) fail("LIVE_PROFILE_REQUIRED", "privacy rules require a live buyer home");
    const mandate = loadMandate(home);
    const matches = (await new LiveDealPorts(app, mandate).catalog()).filter(({ registration }) => registration.manifest.capabilityId === capabilityId);
    if (matches.length !== 1) fail("POLICY_CAPABILITY_INVALID", "privacy rule requires one signed seller capability");
    const manifest = matches[0]!.registration.manifest;
    const memory = { version: "supercuts.settlement-memory.v1", kind: "privacy_rule", scope: { capabilityId: manifest.capabilityId, counterparty: manifest.sellerId, network: "sui:testnet", asset: manifest.asset }, createdAt: Date.now(), signal: { requiresShielded: true } };
    const args = { "operation-id": `owner-privacy-${manifest.manifestHash}`, memory: Buffer.from(JSON.stringify(memory)).toString("base64url") };
    const approval = app.approve(app.preview("memory.policy", args).challengeId);
    const result = (await app.execute("memory.policy", { ...args, "approval-token": approval.token })).data;
    return { capabilityId, sellerId: manifest.sellerId, blobId: result.blobId, kind: result.kind, provenance: result.provenance };
  } finally { app.close(); }
}
function readReserved(home: string): bigint {
  const app = new Phase3App(home);
  try {
    if (!app.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mandate_operations'").get()) return 0n;
    return (app.store.db.prepare("SELECT amount FROM mandate_operations").all() as Array<{ amount: string }>).reduce((sum, row) => sum + BigInt(row.amount), 0n);
  } finally { app.close(); }
}
