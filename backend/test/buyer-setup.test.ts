import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { renewBuyer, setupBuyer } from "../src/buyer-setup.js";
import { loadMandate } from "../src/mandate.js";
import { Phase3App } from "../src/phase3.js";

test("one-time buyer setup creates isolated v2 policy and renewal keeps lifetime reservations", () => {
  const root = mkdtempSync(join(tmpdir(), "supercuts-buyer-setup-")), home = join(root, "buyer");
  const tatum = join(root, "tatum.key"), memory = join(root, "memory.json"), configPath = join(root, "setup.json");
  writeFileSync(tatum, "test-key", { mode: 0o600 });
  writeFileSync(memory, JSON.stringify({ key: "delegate-key", accountId: "0xaccount", suiPrivateKey: "memory-signer" }), { mode: 0o600 });
  const seller = Ed25519Keypair.generate().toSuiAddress();
  const config = { deploymentConfig: resolve(fileURLToPath(import.meta.url), "../../../config/phase1.testnet.json"), tatumKeyFile: tatum, writeGrpc: "https://fullnode.testnet.sui.io:443", tatumGrpc: "https://example.invalid:443", walrusPublisher: "https://publisher.example", walrusAggregator: "https://aggregator.example", memoryConfigFile: memory, sellerOrigins: ["https://seller.example"], allowedCounterparties: [seller], perDealCeiling: "100", totalBudget: "500", expiresAt: Date.now() + 86_400_000, allowPublicX402: true };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const setup = setupBuyer(home, configPath);
  const codexToml = readFileSync(join(home, "buyer-codex.toml"), "utf8");
  assert.match(codexToml, /^tool_timeout_sec = 900$/m, "deal.execute outlives Codex's 60 s default");
  assert.match(codexToml, /^startup_timeout_sec = 60$/m);
  assert.match(String(setup.address), /^0x[0-9a-f]{64}$/);
  assert.equal(loadMandate(home).version, "supercuts.mandate.v2");
  assert.equal(loadMandate(home).allowPublicX402, true);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "deal-sellers.json"), "utf8")), ["https://seller.example"]);
  assert.equal(statSync(join(home, "mandate.json")).mode & 0o077, 0);
  assert.equal(statSync(join(home, "buyer.sui.key")).mode & 0o077, 0);
  const app = new Phase3App(home);
  try { app.store.db.exec("CREATE TABLE mandate_operations(operation_id TEXT PRIMARY KEY,intent_hash TEXT NOT NULL,amount TEXT NOT NULL,created_at INTEGER NOT NULL)"); app.store.db.prepare("INSERT INTO mandate_operations VALUES(?,?,?,?)").run("paid-deal", "hash", "200", Date.now()); }
  finally { app.close(); }
  const renewed = { ...config, totalBudget: "700", expiresAt: Date.now() + 2 * 86_400_000 };
  writeFileSync(configPath, JSON.stringify(renewed), { mode: 0o600 });
  assert.equal(renewBuyer(home, configPath).remainingMist, "500");
  assert.equal(loadMandate(home).totalRunBudget, "700");
  const profile = JSON.parse(readFileSync(join(home, "profile.json"), "utf8")) as { policy: { maxAmount: string; expiresAt: number } };
  assert.equal(profile.policy.maxAmount, renewed.perDealCeiling);
  assert.equal(profile.policy.expiresAt, renewed.expiresAt);
  writeFileSync(configPath, JSON.stringify({ ...renewed, allowedCounterparties: undefined }), { mode: 0o600 });
  renewBuyer(home, configPath);
  assert.deepEqual(loadMandate(home).allowedCounterparties, [seller]);
  writeFileSync(configPath, JSON.stringify({ ...renewed, totalBudget: "100" }), { mode: 0o600 });
  assert.throws(() => renewBuyer(home, configPath));
});

test("directory buyer can start with no approved sellers", () => {
  const root = mkdtempSync(join(tmpdir(), "supercuts-directory-buyer-")), home = join(root, "buyer");
  const tatum = join(root, "tatum.key"), memory = join(root, "memory.json"), configPath = join(root, "setup.json");
  writeFileSync(tatum, "test-key", { mode: 0o600 });
  writeFileSync(memory, JSON.stringify({ key: "delegate-key", accountId: "0xaccount", suiPrivateKey: "memory-signer" }), { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({ deploymentConfig: resolve(fileURLToPath(import.meta.url), "../../../config/phase1.testnet.json"), tatumKeyFile: tatum, writeGrpc: "https://fullnode.testnet.sui.io:443", tatumGrpc: "https://example.invalid:443", walrusPublisher: "https://publisher.example", walrusAggregator: "https://aggregator.example", memoryConfigFile: memory, directoryUrl: "https://directory.example", perDealCeiling: "100", totalBudget: "500", expiresAt: Date.now() + 86_400_000 }), { mode: 0o600 });
  setupBuyer(home, configPath);
  assert.deepEqual(loadMandate(home).allowedCounterparties, []);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "deal-sellers.json"), "utf8")), { directoryUrl: "https://directory.example", origins: [] });
});

test("public-only buyer setup does not require Walrus Memory credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "supercuts-public-buyer-")), home = join(root, "buyer");
  const tatum = join(root, "tatum.key"), configPath = join(root, "setup.json");
  writeFileSync(tatum, "test-key", { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({ deploymentConfig: resolve(fileURLToPath(import.meta.url), "../../../config/phase1.testnet.json"), tatumKeyFile: tatum, writeGrpc: "https://fullnode.testnet.sui.io:443", tatumGrpc: "https://example.invalid:443", walrusPublisher: "https://publisher.example", walrusAggregator: "https://aggregator.example", sellerOrigins: ["https://seller.example"], perDealCeiling: "100", totalBudget: "500", expiresAt: Date.now() + 86_400_000, allowPublicX402: true }), { mode: 0o600 });
  const setup = setupBuyer(home, configPath);
  assert.match(String(setup.address), /^0x[0-9a-f]{64}$/);
  const app = new Phase3App(home);
  try { assert.equal(app.store.getSecret("live:memory-config"), undefined); }
  finally { app.close(); }
});

test("Codex MCP config survives package upgrades and ships a codex mcp add command", async () => {
  const { stableMcpScript, codexAddCommand } = await import("../src/buyer-setup.js");
  const { mkdirSync, symlinkSync, writeFileSync: write } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "supercuts-mcp-path-"));
  const store = join(root, "node_modules", ".pnpm", "@supercuts-walrus+backend@9.9.9_x", "node_modules", "@supercuts-walrus", "backend");
  mkdirSync(join(store, "dist"), { recursive: true });
  write(join(store, "dist", "mcp-bootstrap.js"), "");
  mkdirSync(join(root, "node_modules", "@supercuts-walrus"), { recursive: true });
  symlinkSync(store, join(root, "node_modules", "@supercuts-walrus", "backend"));
  const stable = stableMcpScript(join(store, "dist", "mcp-bootstrap.js"), root);
  assert.equal(stable, join(root, "node_modules", "@supercuts-walrus", "backend", "dist", "mcp-bootstrap.js"));
  assert.doesNotMatch(stable, /\.pnpm/);
  assert.equal(stableMcpScript("/elsewhere/dist/mcp-bootstrap.js", root), "/elsewhere/dist/mcp-bootstrap.js");
  const command = codexAddCommand("/usr/bin/node", stable, { SUPERCUTS_HOME: "/h/it's buyer", SUPERCUTS_RUN_ID: "r1" });
  assert.equal(command, `codex mcp add supercuts-buyer --env 'SUPERCUTS_HOME=/h/it'\\''s buyer' --env 'SUPERCUTS_RUN_ID=r1' -- '/usr/bin/node' '${stable}'`);
});

test("a buyer gets its own Walrus Memory namespace without editing the shared memory config", async () => {
  const { Phase3App: App } = await import("../src/phase3.js");
  const root = mkdtempSync(join(tmpdir(), "supercuts-namespace-")), tatum = join(root, "tatum.key"), memory = join(root, "memory.json");
  writeFileSync(tatum, "test-key", { mode: 0o600 });
  writeFileSync(memory, JSON.stringify({ key: "delegate-key", accountId: "0xaccount", suiPrivateKey: "memory-signer", namespace: "shared:old" }), { mode: 0o600 });
  const base = { deploymentConfig: resolve(fileURLToPath(import.meta.url), "../../../config/phase1.testnet.json"), tatumKeyFile: tatum, writeGrpc: "https://fullnode.testnet.sui.io:443", tatumGrpc: "https://example.invalid:443", walrusPublisher: "https://publisher.example", walrusAggregator: "https://aggregator.example", memoryConfigFile: memory, sellerOrigins: ["https://seller.example"], perDealCeiling: "100", totalBudget: "500", expiresAt: Date.now() + 86_400_000 };
  const namespaceOf = (home: string) => { const app = new App(home); try { return (JSON.parse(app.store.getSecret("live:memory-config")!.toString()) as { namespace: string }).namespace; } finally { app.close(); } };
  for (const [name, memoryNamespace, expected] of [["auto", "auto", /^supercuts:buyer-[0-9a-f]{8}$/], ["named", "supercuts:rec-take2", /^supercuts:rec-take2$/], ["kept", undefined, /^shared:old$/]] as const) {
    const path = join(root, `${name}.json`);
    writeFileSync(path, JSON.stringify({ ...base, ...(memoryNamespace ? { memoryNamespace } : {}) }), { mode: 0o600 });
    const setup = setupBuyer(join(root, name), path);
    assert.match(namespaceOf(join(root, name)), expected);
    if (memoryNamespace) assert.equal(setup.memoryNamespace, namespaceOf(join(root, name)));
  }
  assert.equal((JSON.parse(readFileSync(memory, "utf8")) as { namespace: string }).namespace, "shared:old", "the shared memory config file is never edited");
});
