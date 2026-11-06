import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setupSeller } from "../src/seller-setup.js";

test("one-time seller setup generates an isolated signer and MCP config without requesting funding", () => {
  const root = mkdtempSync(join(tmpdir(), "supercuts-seller-setup-"));
  const home = join(root, "seller"), tatum = join(root, "tatum.key"), configPath = join(root, "setup.json");
  writeFileSync(tatum, "test-key", { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({
    deploymentConfig: resolve(fileURLToPath(import.meta.url), "../../../config/phase1.testnet.json"),
    tatumKeyFile: tatum,
    writeGrpc: "https://fullnode.testnet.sui.io:443",
    tatumGrpc: "https://example.invalid:443",
    walrusPublisher: "https://publisher.example",
    walrusAggregator: "https://aggregator.example",
  }), { mode: 0o600 });
  const result = setupSeller(home, configPath);
  assert.match(String(result.address), /^0x[0-9a-f]{64}$/);
  assert.equal(result.fundingRequired, false);
  assert.equal(statSync(home).mode & 0o077, 0);
  assert.equal(statSync(join(home, "seller.sui.key")).mode & 0o077, 0);
  assert.equal(statSync(join(home, "seller-codex.toml")).mode & 0o077, 0);
  assert.match(readFileSync(join(home, "seller-codex.toml"), "utf8"), /SUPERCUTS_HOME/);
  const profile = JSON.parse(readFileSync(join(home, "profile.json"), "utf8")) as { role: string; mock: boolean };
  assert.deepEqual(profile, { ...profile, role: "seller", mock: false });
  assert.throws(() => setupSeller(home, configPath), { code: "PROFILE_EXISTS" });
});

test("seller setup rejects group-readable owner config", () => {
  const root = mkdtempSync(join(tmpdir(), "supercuts-seller-setup-permissions-"));
  const configPath = join(root, "setup.json");
  writeFileSync(configPath, "{}", { mode: 0o640 });
  assert.throws(() => setupSeller(join(root, "seller"), configPath), { code: "SETUP_PERMISSIONS" });
});

test("seller setup defaults to the npm-bundled pinned Testnet metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "supercuts-seller-bundled-config-")), home = join(root, "seller"), tatum = join(root, "tatum.key"), configPath = join(root, "setup.json");
  writeFileSync(tatum, "test-key", { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({ tatumKeyFile: tatum, writeGrpc: "https://fullnode.testnet.sui.io:443", tatumGrpc: "https://example.invalid:443", walrusPublisher: "https://publisher.example", walrusAggregator: "https://aggregator.example" }), { mode: 0o600 });
  const result = setupSeller(home, configPath);
  assert.equal(result.fundingRequired, false);
  const profile = JSON.parse(readFileSync(join(home, "profile.json"), "utf8")) as { packageId: string; verifierVersion: number };
  assert.equal(profile.verifierVersion, 2);
  assert.equal(profile.packageId, "0x32d104c1ab422d497df4ae3a6861258694949c86428f886ca338e07bd055cf76");
});
