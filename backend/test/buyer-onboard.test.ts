import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeCodexConfig,
  parseSelection,
  runBuyerOnboarding,
  shieldedClasses,
  type OnboardPlan,
  type OnboardSteps,
} from "../src/buyer-onboard.js";

test("seller and class choices accept all, none, or 1-based numbers", () => {
  assert.equal(parseSelection("all", 3), "all");
  assert.equal(parseSelection("", 3), "all", "blank keeps the default");
  assert.equal(parseSelection("none", 3), "none");
  assert.deepEqual(parseSelection("3, 1,3", 3), [0, 2]);
  assert.throws(() => parseSelection("4", 3), {
    code: "ONBOARD_SELECTION_INVALID",
  });
  assert.throws(() => parseSelection("two", 3), {
    code: "ONBOARD_SELECTION_INVALID",
  });
});

test("only classes offered with the shielded rail can carry a privacy rule", () => {
  const listing = (capability: string, supportedRails: string[]) =>
    ({
      registration: { manifest: { capability, supportedRails } },
      direct: false,
    }) as never;
  assert.deepEqual(
    shieldedClasses([
      listing("sui.market-brief", ["x402"]),
      listing("sui.confidential-analysis", ["x402", "shielded"]),
      listing("sui.confidential-analysis", ["shielded"]),
    ]),
    ["sui.confidential-analysis"],
  );
});

test("the Codex config keeps other servers and replaces only the supercuts-buyer stanza", () => {
  const existing =
    'model = "gpt"\n\n[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.supercuts-buyer]\ncommand = "old"\n[mcp_servers.supercuts-buyer.env]\nSUPERCUTS_HOME = "/old"\n\n[projects."/repo"]\ntrust_level = "trusted"\n';
  const stanza =
    '[mcp_servers.supercuts-buyer]\ntool_timeout_sec = 900\ncommand = "new"\n[mcp_servers.supercuts-buyer.env]\nSUPERCUTS_HOME = "/new"\n';
  const merged = mergeCodexConfig(existing, stanza);
  assert.match(merged, /\[mcp_servers\.other\]\ncommand = "x"/);
  assert.match(merged, /\[projects\."\/repo"\]\ntrust_level = "trusted"/);
  assert.doesNotMatch(merged, /\/old|"old"/);
  assert.equal(merged.match(/\[mcp_servers\.supercuts-buyer\]/g)?.length, 1);
  assert.match(merged, /tool_timeout_sec = 900/);
  assert.equal(mergeCodexConfig("", stanza).trim(), stanza.trim());
});

const plan: OnboardPlan = {
  setup: {
    deploymentConfig: "",
    tatumKeyFile: "t",
    writeGrpc: "w",
    tatumGrpc: "r",
    walrusPublisher: "p",
    walrusAggregator: "a",
    perDealCeiling: "3000000",
    totalBudget: "12000000",
    expiresAt: 1,
  },
  sellers: ["deepbook-competitor-analysis", "market-brief-public-v2"],
  privacyClasses: ["sui.confidential-analysis"],
  funding: {
    publicPayment: "2000000",
    shieldedPayment: "3000000",
    requestFaucet: true,
  },
  codexConfig: "/tmp/codex.toml",
};

function recorder(existing = false) {
  const calls: string[] = [];
  const steps: OnboardSteps = {
    exists: () => existing,
    setup: () => {
      calls.push("setup");
      return { address: "0xbuyer" };
    },
    approve: async (_home, id) => {
      calls.push(`approve:${id}`);
      return { approved: true };
    },
    privacy: async (_home, selector) => {
      calls.push(`privacy:${selector.capabilityClass}`);
      return { blobId: "rule" };
    },
    fund: async (_home, values) => {
      calls.push(
        `fund:${values.publicPayment}/${values.shieldedPayment}/${values.requestFaucet}/${values.confirmed}`,
      );
      return { funded: true };
    },
    codex: (_home, path) => {
      calls.push(`codex:${path}`);
      return { written: path };
    },
  };
  return { calls, steps };
}

test("onboarding sets up, approves, saves privacy rules, funds once, then writes Codex config", async () => {
  const { calls, steps } = recorder();
  const result = await runBuyerOnboarding("/home", plan, steps);
  assert.deepEqual(calls, [
    "setup",
    "approve:deepbook-competitor-analysis",
    "approve:market-brief-public-v2",
    "privacy:sui.confidential-analysis",
    "fund:2000000/3000000/true/true",
    "codex:/tmp/codex.toml",
  ]);
  assert.equal(result.resumed, false);
});

test("rerunning onboarding resumes an existing buyer instead of failing", async () => {
  const { calls, steps } = recorder(true);
  const result = await runBuyerOnboarding(
    "/home",
    {
      sellers: plan.sellers,
      privacyClasses: [],
      funding: {
        publicPayment: "0",
        shieldedPayment: "0",
        requestFaucet: false,
      },
    },
    steps,
  );
  assert.deepEqual(calls, [
    "approve:deepbook-competitor-analysis",
    "approve:market-brief-public-v2",
  ]);
  assert.equal(result.resumed, true);
});

test("approve-seller takes several capability IDs and keeps the single-ID result shape", async () => {
  const { approveSellers } = await import("../src/buyer-onboard.js");
  const seen: string[] = [];
  const approve = async (_home: string, id: string) => { seen.push(id); return { capabilityId: id, approved: true }; };
  assert.deepEqual(await approveSellers("/home", { all: false, capabilityIds: ["a"], confirmed: false }, approve), { capabilityId: "a", approved: true });
  assert.deepEqual(await approveSellers("/home", { all: false, capabilityIds: ["a", "b"], confirmed: false }, approve), { approved: [{ capabilityId: "a", approved: true }, { capabilityId: "b", approved: true }] });
  assert.deepEqual(seen, ["a", "a", "b"]);
  await assert.rejects(() => approveSellers("/home", { all: false, capabilityIds: [], confirmed: false }, approve), { code: "ARGUMENT_REQUIRED" });
});

test("noninteractive onboarding that funds or approves needs --yes", async () => {
  const { onboardBuyerFromConfig } = await import("../src/buyer-onboard.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "supercuts-onboard-")), path = join(dir, "onboard.json");
  writeFileSync(path, JSON.stringify({ onboarding: { sellers: ["a"] } }), { mode: 0o600 });
  let plain = false;
  await assert.rejects(() => onboardBuyerFromConfig(join(dir, "buyer"), path, false, () => { plain = true; return {}; }), { code: "ONBOARD_CONFIRMATION_REQUIRED" });
  writeFileSync(path, JSON.stringify({ perDealCeiling: "1" }), { mode: 0o600 });
  await onboardBuyerFromConfig(join(dir, "buyer"), path, false, () => { plain = true; return {}; });
  assert.equal(plain, true, "a file without onboarding stays plain setup");
});

test("onboarding checks the embedding endpoint before changing anything when a privacy rule is planned", async () => {
  const { assertEmbeddingsReady } = await import("../src/buyer-onboard.js");
  const ok = (async () => new Response(JSON.stringify({ data: [{ embedding: new Array(1536).fill(0) }] }))) as unknown as typeof fetch;
  const short = (async () => new Response(JSON.stringify({ data: [{ embedding: new Array(768).fill(0) }] }))) as unknown as typeof fetch;
  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  const config = { embeddingApiBase: "http://127.0.0.1:8787/v1", embeddingModel: "embeddinggemma-1536", embeddingApiKey: "k" };
  await assertEmbeddingsReady(config, ok);
  await assert.rejects(() => assertEmbeddingsReady(config, short), { code: "MEMORY_EMBEDDING_INVALID" });
  await assert.rejects(() => assertEmbeddingsReady(config, down), { code: "MEMORY_ENDPOINT_UNREACHABLE" });
});

test("setup questions re-ask bad answers, default to 3000000/12000000, and require yes or no", async () => {
  const { askBuyerSetup, askYesNo } = await import("../src/buyer-setup.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = mkdtempSync(join(tmpdir(), "supercuts-ask-")), key = join(dir, "tatum.key");
  writeFileSync(key, "k", { mode: 0o600 });
  const deployment = resolve(fileURLToPath(import.meta.url), "../../../config/phase1.testnet.json");
  const asked: string[] = [];
  const script = ["0", "14", deployment, join(dir, "missing.key"), key, "", "", "", "", "", "", "", "", "100", "", "maybe", "y"];
  const ask = async (label: string, fallback?: string) => { asked.push(`${label}|${fallback ?? ""}`); const answer = script.shift() ?? ""; return answer || fallback || ""; };
  const config = await askBuyerSetup(ask, { askCounterparties: false });
  assert.equal(config.perDealCeiling, "3000000");
  assert.equal(config.totalBudget, "12000000", "the bad 100 budget was re-asked and the default accepted");
  assert.equal(config.allowPublicX402, true, "maybe was re-asked; y means yes");
  assert.ok(asked.some((line) => line.startsWith("Allow public x402") && line.endsWith("|no")), "the yes/no default is shown");
  assert.equal(asked.filter((line) => line.startsWith("Policy duration")).length, 2, "0 days was re-asked");
  assert.equal(asked.filter((line) => line.startsWith("Owner-only Tatum")).length, 2, "a missing key file was re-asked");
  assert.equal(await askYesNo(async (_label, fallback) => fallback ?? "", "Proceed?", "no"), false, "blank takes the shown default");
});

test("onboarding's single confirmation covers the pool deposit", async () => {
  let deposit: unknown;
  const steps = { exists: () => true, setup: () => ({}), approve: async () => ({}), privacy: async () => ({}), codex: () => ({}),
    fund: async (_home: string, values: { depositConfirmed?: boolean }) => { deposit = values.depositConfirmed; return {}; } } as unknown as OnboardSteps;
  await runBuyerOnboarding("/home", { sellers: [], privacyClasses: [], funding: { publicPayment: "0", shieldedPayment: "3000000", requestFaucet: false } }, steps);
  assert.equal(deposit, true);
});
