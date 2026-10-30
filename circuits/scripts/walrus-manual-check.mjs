import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MemWal } from "@mysten-incubation/memwal";
import { MemWalManual } from "@mysten-incubation/memwal/manual";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "..");
const env = Object.fromEntries(readFileSync(resolve(repository, ".env"), "utf8")
  .split(/\r?\n/)
  .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
  .map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
const required = [
  "MEMWAL_KEY", "MEMWAL_ACCOUNT_ID", "SUI_PRIVATE_KEY", "OPENAI_API_KEY",
];
const missing = required.filter((name) => !env[name]);
if (missing.length) throw new Error(`missing required Walrus manual-mode values: ${missing.join(", ")}`);

const serverUrl = env.MEMWAL_SERVER_URL.replace(/\/$/, "");
const deploymentResponse = await fetch(`${serverUrl}/config`);
if (!deploymentResponse.ok) throw new Error(`could not load relayer deployment metadata: HTTP ${deploymentResponse.status}`);
const deployment = await deploymentResponse.json();
const packageId = env.WALRUS_MEMORY_PACKAGE_ID ?? deployment.packageId;
const registryId = env.WALRUS_MEMORY_REGISTRY_ID ?? deployment.registryId;
const network = env.WALRUS_MEMORY_NETWORK ?? deployment.network;

// Confirm the account/delegate binding before calling an embedding endpoint or
// constructing encrypted content. This fails closed on a stale account/key.
const authClient = MemWal.create({
  key: env.MEMWAL_KEY,
  accountId: env.MEMWAL_ACCOUNT_ID,
  serverUrl,
  namespace: "supercuts-phase1",
});
try {
  await authClient.resolveOwner();
} finally {
  authClient.destroy();
}

const client = MemWalManual.create({
  key: env.MEMWAL_KEY,
  accountId: env.MEMWAL_ACCOUNT_ID,
  serverUrl,
  suiPrivateKey: env.SUI_PRIVATE_KEY,
  embeddingApiKey: env.OPENAI_API_KEY,
  embeddingApiBase: env.OPENAI_BASE_URL,
  embeddingModel: env.EMBEDDING_MODEL,
  packageId,
  registryId,
  suiNetwork: network === "testnet" ? "testnet" : "mainnet",
  namespace: "supercuts-phase1",
});

try {
  const health = await client.health();
  if (process.argv.includes("--write")) {
    const marker = `Supercuts Phase 1 Walrus manual-mode verification ${new Date().toISOString()}`;
    const stored = await client.rememberManual(marker);
    const recalled = await client.recallManual("Supercuts Phase 1 Walrus manual-mode verification", {
      limit: 5,
      namespace: "supercuts-phase1",
    });
    const found = recalled.results.some((result) => result.text === marker);
    if (!found) throw new Error("Walrus write completed but its exact marker was not recalled");
    console.log(JSON.stringify({ health: health.status, blobId: stored.blob_id, recalled: true }, null, 2));
  } else {
    console.log(JSON.stringify({ health: health.status, writes: health.writes, mode: "readiness" }, null, 2));
  }
} finally {
  client.destroy();
}
