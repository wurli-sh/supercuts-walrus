import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "..");
const config = JSON.parse(readFileSync(process.env.PHASE1_CONFIG
  ? resolve(repository, process.env.PHASE1_CONFIG)
  : resolve(repository, "config/phase1.testnet.json")));
const [stage, ...options] = process.argv.slice(2);
const execute = options.includes("--execute");
const append = options.includes("--append");
if (!["deposit", "transfer", "withdraw"].includes(stage)) {
  throw new Error("usage: submit:live <deposit|transfer|withdraw> [--execute]");
}
const fixtureDir = process.env.LIVE_FIXTURE_DIR
  ? resolve(repository, process.env.LIVE_FIXTURE_DIR)
  : resolve(root, append ? "build/live-fixtures-append" : "build/live-fixtures");
const proofDir = process.env.LIVE_PROOF_DIR
  ? resolve(repository, process.env.LIVE_PROOF_DIR, stage)
  : resolve(root, `build/live-proofs${append ? "-append" : ""}/${stage}`);
const fixturePath = resolve(fixtureDir, `${stage}.json`);
const publicPath = resolve(fixtureDir, "public.json");
const proofPath = resolve(proofDir, "proof.bin");
if (![fixturePath, publicPath, proofPath].every(existsSync)) {
  throw new Error(`missing ${stage} fixture/proof; generate it with prove:transaction first`);
}
const fixture = JSON.parse(readFileSync(fixturePath));
const publicValues = JSON.parse(readFileSync(publicPath));
const vector = (bytes) => `[${[...bytes].join(",")}]`;
const bytes32 = (hex) => vector(Buffer.from(hex, "hex"));
const field = (value) => vector(Buffer.from(BigInt(value).toString(16).padStart(64, "0"), "hex"));
const proof = vector(readFileSync(proofPath));
const target = `${config.packageId}::pool::`;
const typeArg = `<${config.coinType}>`;
const vectors = [];
const vectorRef = (name, value) => {
  vectors.push("--make-move-vec", "<u8>", value, "--assign", name);
  return name;
};
let commands;
if (stage === "deposit") {
  const note = vectorRef("note", field(publicValues.inputNote));
  const root = vectorRef("newRoot", field(publicValues.depositedRoot));
  const encodedProof = vectorRef("proof", proof);
  commands = [
    "--split-coins", "gas", `[${publicValues.depositAmount}]`,
    "--assign", "depositCoin",
    ...vectors, "--move-call", `${target}deposit`, typeArg,
    `@${config.poolId}`, "depositCoin", note, root, publicValues.depositNewIndex, encodedProof,
  ];
} else if (stage === "transfer") {
  const deal = vectorRef("deal", field(publicValues.dealCommitment));
  const dealNull = vectorRef("dealNull", field(publicValues.dealNullifier));
  const inputNull = vectorRef("inputNull", field(publicValues.inputNullifier));
  const payment = vectorRef("payment", field(publicValues.paymentNote));
  const change = vectorRef("change", field(publicValues.changeNote));
  const root = vectorRef("newRoot", field(publicValues.finalRoot));
  const encodedProof = vectorRef("proof", proof);
  commands = [
    ...vectors, "--move-call", `${target}transfer_private`, typeArg,
    `@${config.poolId}`, "@0x6", deal, dealNull, inputNull, payment, change,
    publicValues.expiry, root, publicValues.transferNewIndex, encodedProof,
  ];
} else {
  const root = vectorRef("root", field(publicValues.finalRoot));
  const noteNull = vectorRef("noteNull", field(publicValues.withdrawalNullifier));
  const encodedProof = vectorRef("proof", proof);
  commands = [
    ...vectors, "--move-call", `${target}withdraw`, typeArg,
    `@${config.poolId}`, root, noteNull, `@${publicValues.recipient}`, publicValues.paymentAmount, encodedProof,
  ];
}
const args = ["client", "ptb", ...commands, "--gas-budget", "100000000", "--json"];
if (!execute) args.push("--dry-run");
const raw = execFileSync("sui", args, { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
let result;
try {
  result = JSON.parse(raw);
} catch {
  result = { raw };
}
const status = result?.effects?.status?.status ?? result?.status?.status
  ?? (/execution status: success/i.test(raw) ? "success" : undefined);
if (status !== "success") throw new Error(`${stage} ${execute ? "execution" : "dry run"} failed: ${raw}`);
const digest = result.digest ?? raw.match(/Transaction Digest:\s*([A-Za-z0-9]+)/i)?.[1] ?? null;
writeFileSync(resolve(proofDir, `${stage}-${execute ? "execute" : "dry-run"}.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ stage, mode: execute ? "execute" : "dry-run", status, digest }, null, 2));
