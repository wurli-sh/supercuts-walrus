import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "..");
const build = resolve(root, "build");
const snarkjs = resolve(root, "node_modules/.bin/snarkjs");
const localRapidSnark = resolve(build, "tools/rapidsnark-src/build_prover/src/prover");
const allowed = new Set(["deposit", "transfer", "withdraw"]);
const [name, inputArg, outputArg, ...options] = process.argv.slice(2);
const proverOption = options.find((value) => value.startsWith("--prover="))?.split("=")[1] ?? "auto";

if (!allowed.has(name) || !inputArg || !outputArg || !["auto", "snarkjs", "rapidsnark", "both"].includes(proverOption)) {
  throw new Error("usage: prove:transaction <deposit|transfer|withdraw> <input.json> <output-dir> [--prover=auto|snarkjs|rapidsnark|both]");
}

const input = resolve(process.cwd(), inputArg);
const output = resolve(process.cwd(), outputArg);
const zkey = resolve(build, `proofs/${name}/${name}.zkey`);
const verificationKey = resolve(build, `proofs/${name}/verification-key.json`);
const witnessGenerator = resolve(build, `${name}_js/generate_witness.js`);
const wasm = resolve(build, `${name}_js/${name}.wasm`);
const config = JSON.parse(readFileSync(resolve(repository, "config/pool-v1.testnet.json")));
const expected = config.artifacts?.[name];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requireHash(path, wanted, label) {
  const actual = sha256(path);
  if (actual !== wanted) throw new Error(`${label} hash mismatch: expected ${wanted}, got ${actual}`);
  return actual;
}

function timed(command, args, cwd = root) {
  const started = performance.now();
  execFileSync(command, args, { cwd, stdio: "inherit" });
  return Math.round(performance.now() - started);
}

if (!expected || !existsSync(input) || !existsSync(zkey) || !existsSync(verificationKey)) {
  throw new Error("missing input or pinned proving artifacts; run pnpm prove:test-only first");
}
requireHash(zkey, expected.zkeySha256, `${name} zkey`);
mkdirSync(output, { recursive: true });
const witness = resolve(output, "witness.wtns");
const witnessMs = timed("node", [witnessGenerator, wasm, input, witness]);

let rapidSnark = process.env.RAPIDSNARK_PATH
  ? resolve(process.cwd(), process.env.RAPIDSNARK_PATH)
  : localRapidSnark;
let hasRapidSnark = false;
try {
  accessSync(rapidSnark, constants.X_OK);
  hasRapidSnark = true;
} catch {
  // The explicit rapidsnark modes below fail closed; auto safely uses SnarkJS.
}
let provers;
if (proverOption === "both") provers = ["snarkjs", "rapidsnark"];
else if (proverOption === "auto") provers = [hasRapidSnark ? "rapidsnark" : "snarkjs"];
else provers = [proverOption];
if (provers.includes("rapidsnark") && !hasRapidSnark) {
  throw new Error("RapidSnark is unavailable; run pnpm setup:rapidsnark or set RAPIDSNARK_PATH");
}

const report = {
  circuit: name,
  testOnly: config.testOnly === true,
  zkeySha256: expected.zkeySha256,
  witnessMs,
  runs: {},
};
let referencePublic;
for (const prover of provers) {
  const runOutput = provers.length === 1 ? output : resolve(output, prover);
  mkdirSync(runOutput, { recursive: true });
  const proof = resolve(runOutput, "proof.json");
  const publicInputs = resolve(runOutput, "public.json");
  const proveMs = prover === "rapidsnark"
    ? timed(rapidSnark, [zkey, witness, proof, publicInputs])
    : timed(snarkjs, ["groth16", "prove", zkey, witness, proof, publicInputs]);
  const verifyMs = timed(snarkjs, ["groth16", "verify", verificationKey, publicInputs, proof]);
  const convertMs = timed("cargo", [
    "run", "--quiet", "-p", "supercuts-groth16", "--",
    name, verificationKey, proof, publicInputs, runOutput,
  ], repository);
  requireHash(resolve(runOutput, "verifying-key.bin"), expected.verifyingKeySha256,
    `${name} prepared verifying key`);
  const publicValue = JSON.stringify(JSON.parse(readFileSync(publicInputs)));
  if (referencePublic !== undefined && publicValue !== referencePublic) {
    throw new Error("provers produced different public inputs for the same witness");
  }
  referencePublic = publicValue;
  report.runs[prover] = {
    proveMs,
    verifyMs,
    convertMs,
    proofSha256: sha256(resolve(runOutput, "proof.bin")),
    publicInputsSha256: sha256(resolve(runOutput, "public-inputs.bin")),
  };
}

writeFileSync(resolve(output, "timings.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
