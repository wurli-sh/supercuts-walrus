import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "..");
const base = JSON.parse(readFileSync(resolve(repository, "config/pool-v1.testnet.json")));
const artifacts = JSON.parse(readFileSync(resolve(repository, "config/pool-v2.artifacts.testnet.json")));
const packageId = process.argv.find((argument) => argument.startsWith("--package="))?.slice(10);
const recoverDigest = process.argv.find((argument) => argument.startsWith("--recover="))?.slice(10);
if (!/^0x[0-9a-f]{64}$/i.test(packageId ?? "")) throw Error("pass the separately published v2 package as --package=0x...");
const execute = process.argv.includes("--execute");
const output = resolve(repository, "config/pool-v2.testnet.json");
if ((execute || recoverDigest) && existsSync(output)) throw Error("pinned v2 configuration already exists; refusing to create another pool");
const draftPath = resolve(repository, ".state/v2-deployment-draft.json");
const draft = existsSync(draftPath) ? JSON.parse(readFileSync(draftPath)) : { packageId, deploymentDomain: randomBytes(32).toString("hex") };
if (draft.packageId !== packageId) throw Error("deployment draft belongs to another package");
if (!existsSync(draftPath)) writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600, flag: "wx" });
const bytes = (value) => `[${[...value].join(",")}]`;
const vectors = [];
for (const [name, value] of [
  ["domain", Buffer.from(draft.deploymentDomain, "hex")],
  ["initialRoot", Buffer.from(base.initialRoot, "hex")],
  ...["deposit", "transfer", "withdraw"].map((name) => [`${name}Vk`, readFileSync(resolve(root, `build/v2/proofs/${name}_v2/verifying-key.bin`))]),
]) vectors.push("--make-move-vec", "<u8>", bytes(value), "--assign", name);
const args = ["client", "ptb", "--json", ...vectors,
  "--move-call", `${packageId}::pool_v2::create`, `<${base.coinType}>`,
  "domain", "initialRoot", "2", "depositVk", "transferVk", "withdrawVk",
  "--gas-budget", "300000000"];
if (!execute) args.push("--dry-run");
const raw = recoverDigest ? "" : execFileSync("sui", args, { cwd: repository, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const jsonStart = raw.indexOf("{");
if (!recoverDigest && jsonStart < 0 && !execute && /Dry run completed, execution status: success/.test(raw)) {
  console.log(JSON.stringify({ mode: "dry-run", status: "success", packageId, domain: draft.deploymentDomain }));
  process.exit(0);
}
const digest = recoverDigest ?? (jsonStart < 0 ? raw.match(/Transaction Digest:\s*([1-9A-HJ-NP-Za-km-z]{32,64})/)?.[1] : JSON.parse(raw.slice(jsonStart)).digest);
if (execute && !digest) throw Error("Sui execution output omitted a digest; find it in the sender's recent transactions and rerun with --recover=<digest>");
const observed = execute || recoverDigest ? execFileSync("sui", ["client", "tx-block", digest, "--json"], { cwd: repository, encoding: "utf8" }) : raw;
const result = JSON.parse(observed.slice(observed.indexOf("{")));
if (result.effects?.status?.status !== "success") throw Error(`pool creation ${execute ? "failed" : "dry run failed"}: ${result.effects?.status?.error ?? "unknown chain error"}`);
if (!execute && !recoverDigest) {
  console.log(JSON.stringify({ mode: "dry-run", status: "success", packageId, domain: draft.deploymentDomain }));
} else {
  const created = result.objectChanges?.find((change) => change.type === "created" && change.objectType?.includes("::pool_v2::Pool<"));
  if (!created || !result.digest || !result.checkpoint) throw Error("pool creation lacks a shared Pool object or finalized checkpoint");
  const config = { network: "testnet", sender: base.sender, coinType: base.coinType, coinTypeHash: base.coinTypeHash,
    packageId, poolId: created.objectId, poolCreateTransaction: result.digest, deploymentCheckpoint: String(result.checkpoint),
    deploymentDomain: draft.deploymentDomain, initialRoot: base.initialRoot, verifierVersion: 2, testOnly: true,
    artifactManifest: "circuits/build/v2/proving-manifest.json", artifacts: artifacts.artifacts };
  writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ mode: "executed", status: "success", packageId, poolId: created.objectId, digest: result.digest, checkpoint: result.checkpoint, config: output }));
}
