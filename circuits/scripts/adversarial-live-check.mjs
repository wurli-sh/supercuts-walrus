import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "..");
const config = JSON.parse(readFileSync(resolve(root, "build/adversarial/config.json")));
const values = JSON.parse(readFileSync(resolve(root, "build/adversarial/fixtures/public.json")));
const proof = readFileSync(resolve(root, "build/adversarial/proofs/transfer/proof.bin"));
const vector = (bytes) => `[${[...bytes].join(",")}]`;
const fieldBytes = (value) => Buffer.from(BigInt(value).toString(16).padStart(64, "0"), "hex");
const changed = (value) => (BigInt(value) + 1n).toString();

function snapshot() {
  const result = spawnSync("sui", ["client", "object", config.poolId, "--json"], { cwd: repository, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const object = JSON.parse(result.stdout);
  return {
    version: object.version,
    digest: object.digest,
    custody: object.content.custody,
    root: object.content.root,
    nextLeaf: object.content.next_leaf,
    acceptedRoots: object.content.accepted_roots.size,
    spentNotes: object.content.spent_notes.size,
    consumedDeals: object.content.consumed_deals.size,
  };
}

function contractState(snapshotValue) {
  const { version: _version, digest: _digest, ...state } = snapshotValue;
  return state;
}

function transferArgs(overrides = {}, gasBudget = "100000000") {
  const input = { ...values, ...overrides };
  const encodedProof = overrides.proof ?? proof;
  const fields = [
    ["deal", input.dealCommitment], ["dealNull", input.dealNullifier], ["inputNull", input.inputNullifier],
    ["payment", input.paymentNote], ["change", input.changeNote], ["newRoot", input.finalRoot],
  ];
  const vectors = fields.flatMap(([name, value]) => ["--make-move-vec", "<u8>", vector(fieldBytes(value)), "--assign", name]);
  vectors.push("--make-move-vec", "<u8>", vector(encodedProof), "--assign", "proof");
  return [
    "client", "ptb", ...vectors,
    "--move-call", `${config.packageId}::pool::transfer_private`, `<${config.coinType}>`,
    `@${config.poolId}`, "@0x6", "deal", "dealNull", "inputNull", "payment", "change",
    String(input.expiry), "newRoot", String(input.transferNewIndex), "proof",
    "--gas-budget", gasBudget, "--json",
  ];
}

function parseResult(raw, exitCode = 0) {
  const start = raw.indexOf("{");
  let parsed = {};
  if (start >= 0) {
    try { parsed = JSON.parse(raw.slice(start)); } catch { /* CLI may append a rendered error after JSON-like text. */ }
  }
  return {
    digest: parsed.digest ?? raw.match(/Transaction Digest:\s*([A-Za-z0-9]+)/i)?.[1] ?? null,
    status: parsed.effects?.status?.status ?? (exitCode === 0 ? "success" : "failure"),
    error: parsed.effects?.status?.error ?? (exitCode === 0 ? null : raw.trim().slice(-1000)),
  };
}

function execute(args) {
  const result = spawnSync("sui", args, { cwd: repository, encoding: "utf8" });
  return parseResult(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, result.status ?? 1);
}

function executeAsync(args) {
  return new Promise((resolvePromise) => {
    const child = spawn("sui", args, { cwd: repository });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolvePromise(parseResult(output, code ?? 1)));
  });
}

const baseline = snapshot();
const badProof = Buffer.from(proof);
badProof[0] ^= 1;
const mutations = [
  ["agreement", { dealCommitment: changed(values.dealCommitment) }],
  ["deal-nullifier", { dealNullifier: changed(values.dealNullifier) }],
  ["input-nullifier", { inputNullifier: changed(values.inputNullifier) }],
  ["payment-output", { paymentNote: changed(values.paymentNote) }],
  ["change-output", { changeNote: changed(values.changeNote) }],
  ["expiry", { expiry: (BigInt(values.expiry) + 1n).toString() }],
  ["root", { finalRoot: changed(values.finalRoot) }],
  ["leaf-index", { transferNewIndex: (BigInt(values.transferNewIndex) + 1n).toString() }],
  ["proof-signatures-and-conservation", { proof: badProof }],
];
const rejected = [];
for (const [name, override] of mutations) {
  const before = snapshot();
  const result = execute(transferArgs(override));
  const after = snapshot();
  const unchanged = JSON.stringify(contractState(before)) === JSON.stringify(contractState(after));
  if (result.status !== "failure" || !unchanged) throw new Error(`${name} mutation did not fail closed: ${JSON.stringify({ result, before, after })}`);
  rejected.push({ name, ...result, stateUnchanged: unchanged });
}

const raceBefore = snapshot();
const race = await Promise.all([
  executeAsync(transferArgs({}, "100000000")),
  executeAsync(transferArgs({}, "110000000")),
]);
const raceAfter = snapshot();
const successes = race.filter((result) => result.status === "success");
if (successes.length !== 1) throw new Error(`expected exactly one concurrent spend to succeed: ${JSON.stringify(race)}`);
if (BigInt(raceAfter.nextLeaf) !== BigInt(raceBefore.nextLeaf) + 2n || BigInt(raceAfter.spentNotes) !== BigInt(raceBefore.spentNotes) + 1n || BigInt(raceAfter.consumedDeals) !== BigInt(raceBefore.consumedDeals) + 1n) {
  throw new Error(`race changed pool state more than once: ${JSON.stringify({ raceBefore, raceAfter })}`);
}

const replayBefore = snapshot();
const replay = execute(transferArgs({}, "120000000"));
const replayAfter = snapshot();
if (replay.status !== "failure" || JSON.stringify(contractState(replayBefore)) !== JSON.stringify(contractState(replayAfter))) throw new Error("replayed settlement did not fail closed");

const evidence = { poolId: config.poolId, poolCreateTransaction: config.poolCreateTransaction, baseline, rejected, race: { attempts: race, before: raceBefore, after: raceAfter, successfulDigest: successes[0].digest }, replay: { ...replay, stateUnchanged: JSON.stringify(contractState(replayBefore)) === JSON.stringify(contractState(replayAfter)) } };
const output = resolve(root, "build/adversarial/evidence.json");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
