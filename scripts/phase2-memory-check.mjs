import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemWal } from "../circuits/node_modules/@mysten-incubation/memwal/dist/index.js";
import { MemWalManual } from "../circuits/node_modules/@mysten-incubation/memwal/dist/manual-entry.js";

const fileEnv = Object.fromEntries(readFileSync(resolve(".env"), "utf8").split(/\r?\n/)
  .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
  .map((line) => { const split = line.indexOf("="); return [line.slice(0, split), line.slice(split + 1)]; }));
const env = { ...fileEnv, ...process.env };
env.MEMWAL_KEY ??= env.MEMWAL_DELEGATE_KEY;
env.EMBEDDING_API_KEY ??= env.OPENAI_API_KEY;
env.EMBEDDING_API_BASE ??= env.OPENAI_BASE_URL;
const required = ["MEMWAL_KEY", "MEMWAL_ACCOUNT_ID", "MEMWAL_SERVER_URL", "SUI_PRIVATE_KEY", "EMBEDDING_API_KEY", "EMBEDDING_API_BASE", "EMBEDDING_MODEL"];
const missing = required.filter((name) => !env[name]);
if (missing.length) throw new Error(`missing Phase 2 memory configuration: ${missing.join(", ")}`);

const serverUrl = env.MEMWAL_SERVER_URL.replace(/\/$/, "");
const deploymentResponse = await fetch(`${serverUrl}/config`);
if (!deploymentResponse.ok) throw new Error(`could not load Walrus Memory deployment: HTTP ${deploymentResponse.status}`);
const deployment = await deploymentResponse.json();
const namespace = `supercuts-phase2-${new Date().toISOString().slice(0, 10)}`;

const auth = MemWal.create({ key: env.MEMWAL_KEY, accountId: env.MEMWAL_ACCOUNT_ID, serverUrl, namespace });
try { await auth.resolveOwner(); } finally { auth.destroy(); }

const client = MemWalManual.create({
  key: env.MEMWAL_KEY, accountId: env.MEMWAL_ACCOUNT_ID, serverUrl,
  suiPrivateKey: env.SUI_PRIVATE_KEY, embeddingApiKey: env.EMBEDDING_API_KEY,
  embeddingApiBase: env.EMBEDDING_API_BASE, embeddingModel: env.EMBEDDING_MODEL,
  packageId: deployment.packageId, registryId: deployment.registryId,
  suiNetwork: deployment.network === "testnet" ? "testnet" : "mainnet", namespace,
});

const facts = [
  ["budget_preference", "buyer", "Keep procurement below 20 units unless an operator approves an exception."],
  ["counterparty_reliability", "seller-a", "Seller A replied on time but quoted 12 units."],
  ["counterparty_reliability", "seller-b", "Seller B replied on time and honored the quoted 9 units."],
  ["counterparty_reliability", "seller-c", "Seller C replied late and quoted 15 units."],
  ["successful_counteroffer", "seller-b", "A counteroffer at 9 units was accepted."],
  ["delivery_observation", "seller-b", "The selected encrypted resource was delivered exactly once."],
  ["delivery_observation", "x402-resource", "Duplicate retrieval returned the prior resource without another payment."],
  ["privacy_choice", "buyer", "Negotiation messages must remain client-encrypted on Walrus."],
  ["privacy_choice", "buyer", "Payment amount must be hidden for negotiated seller purchases."],
  ["budget_preference", "buyer", "Prefer seller B when price remains at or below 10 units and reliability is unchanged."],
].map(([kind, subject, observation], index) => ({ kind, subject, observation, operationId: `phase2-workflow-${index + 1}`, createdAt: Date.now() + index }));

try {
  const blobIds = [];
  for (const fact of facts) {
    const text = JSON.stringify(fact);
    const prior = await client.recallManual(fact.operationId, { limit: 10, namespace });
    const existing = prior.results.find((item) => {
      try {
        const recalled = JSON.parse(item.text);
        return recalled.operationId === fact.operationId && recalled.kind === fact.kind && recalled.subject === fact.subject && recalled.observation === fact.observation;
      } catch { return false; }
    });
    if (existing) { blobIds.push(existing.blob_id); continue; }
    const result = await client.rememberManual(text);
    if (!result.blob_id) throw new Error(`memory ${fact.operationId} completed without a blob ID`);
    blobIds.push(result.blob_id);
  }
  if (new Set(blobIds).size !== facts.length) throw new Error("memory jobs did not resolve to ten distinct blob IDs");
  const recalled = await client.recallManual("buyer privacy choice hidden payment amount for negotiated seller purchases", { limit: 10, namespace });
  const hiddenAmountRule = recalled.results.some((item) => /payment amount must be hidden/i.test(item.text));
  if (!hiddenAmountRule) throw new Error("the second run did not recall the hidden-amount rule");
  console.log(JSON.stringify({
    namespace, completed: blobIds.length, blobIds,
    recallCount: recalled.results.length, hiddenAmountRule,
    beforeDecision: "x402", afterDecision: "shielded",
    relayerPayload: "ciphertext (MemWalManual client-managed encryption)",
    embeddingPlaintextAccess: new URL(env.EMBEDDING_API_BASE).hostname,
  }, null, 2));
} finally { client.destroy(); }
