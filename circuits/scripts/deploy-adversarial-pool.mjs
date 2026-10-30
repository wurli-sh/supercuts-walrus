import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "..");
const base = JSON.parse(readFileSync(resolve(repository, "config/phase1.testnet.json")));
const execute = process.argv.includes("--execute");
const domain = randomBytes(32);
const bytes = (value) => `[${[...value].join(",")}]`;
const vectors = [];
for (const [name, file] of [
  ["domain", null],
  ["initialRoot", null],
  ["depositVk", "deposit"],
  ["transferVk", "transfer"],
  ["withdrawVk", "withdraw"],
]) {
  const value = name === "domain" ? domain
    : name === "initialRoot" ? Buffer.from(base.initialRoot, "hex")
      : readFileSync(resolve(root, `build/proofs/${file}/verifying-key.bin`));
  vectors.push("--make-move-vec", "<u8>", bytes(value), "--assign", name);
}
const args = [
  "client", "ptb", ...vectors,
  "--move-call", `${base.packageId}::pool::create`, `<${base.coinType}>`,
  "domain", "initialRoot", String(base.verifierVersion), "depositVk", "transferVk", "withdrawVk",
  "--gas-budget", "100000000", "--json",
];
if (!execute) args.push("--dry-run");
const raw = execFileSync("sui", args, { cwd: repository, encoding: "utf8" });
const jsonStart = raw.indexOf("{");
const result = jsonStart >= 0 ? JSON.parse(raw.slice(jsonStart)) : {};
const status = result.effects?.status?.status ?? (/execution status: success/i.test(raw) ? "success" : undefined);
if (status !== "success") throw new Error(result.effects ? JSON.stringify(result.effects.status) : raw);
const created = result.objectChanges?.find((change) => change.type === "created" && change.objectType?.includes("::pool::Pool<"));
if (execute && !created) throw new Error("pool creation succeeded but no shared Pool object was found");
if (execute) {
  const outputDir = resolve(repository, process.env.ADVERSARIAL_DIR ?? "circuits/build/adversarial");
  mkdirSync(outputDir, { recursive: true });
  const config = { ...base, poolId: created.objectId, poolCreateTransaction: result.digest, deploymentDomain: domain.toString("hex"), adversarialTestOnly: true };
  writeFileSync(resolve(outputDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  console.log(JSON.stringify({ status: "success", digest: result.digest, poolId: created.objectId, config: resolve(outputDir, "config.json") }, null, 2));
} else {
  console.log(JSON.stringify({ status: "success", mode: "dry-run" }, null, 2));
}
