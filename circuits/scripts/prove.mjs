import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { semanticFixtures } from "./semantic.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "..");
const build = resolve(root, "build");
const snarkjs = resolve(root, "node_modules/.bin/snarkjs");
const phase1 = resolve(build, "pot19_final.ptau");
const phase2 = resolve(build, "pot19_phase2.ptau");
const fixtures = await semanticFixtures();

function run(command, args, cwd = root) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

if (!existsSync(phase1)) throw new Error(`missing verified phase-1 Powers of Tau: ${phase1}`);
if (!existsSync(phase2)) {
  run(snarkjs, ["powersoftau", "prepare", "phase2", phase1, phase2]);
}

const manifest = {
  version: "supercuts-phase1-v1",
  testOnly: true,
  warning: "Per-circuit contributions are locally generated and unaudited; never use these keys with production assets.",
  powersOfTauSha256: sha256(phase2),
  circuits: {},
};

for (const name of ["deposit", "transfer", "withdraw"]) {
  const output = resolve(build, "proofs", name);
  mkdirSync(output, { recursive: true });
  const input = resolve(output, "input.json");
  const witness = resolve(output, "witness.wtns");
  const initialZkey = resolve(output, "initial.zkey");
  const finalZkey = resolve(output, `${name}.zkey`);
  const verificationKey = resolve(output, "verification-key.json");
  const proof = resolve(output, "proof.json");
  const publicInputs = resolve(output, "public.json");
  const suiVector = resolve(output, "sui-vector.json");
  if (!existsSync(suiVector)) {
    writeFileSync(input, `${JSON.stringify(fixtures[name])}\n`);
    run(snarkjs, ["groth16", "setup", resolve(build, `${name}.r1cs`), phase2, initialZkey]);
    run(snarkjs, [
      "zkey", "contribute", initialZkey, finalZkey,
      `-n=supercuts-${name}-test-only`,
      `-e=${randomBytes(64).toString("hex")}`,
    ]);
    run(snarkjs, ["zkey", "export", "verificationkey", finalZkey, verificationKey]);
    run("node", [
      resolve(build, `${name}_js/generate_witness.js`),
      resolve(build, `${name}_js/${name}.wasm`), input, witness,
    ]);
    run(snarkjs, ["groth16", "prove", finalZkey, witness, proof, publicInputs]);
    run(snarkjs, ["groth16", "verify", verificationKey, publicInputs, proof]);
    run("cargo", [
      "run", "--quiet", "-p", "supercuts-groth16", "--",
      name, verificationKey, proof, publicInputs, output,
    ], repository);
  } else {
    console.log(`reusing verified ${name} Sui vector`);
  }
  run(snarkjs, ["zkey", "verify", resolve(build, `${name}.r1cs`), phase2, finalZkey]);

  manifest.circuits[name] = {
    r1csSha256: sha256(resolve(build, `${name}.r1cs`)),
    zkeySha256: sha256(finalZkey),
    verificationKeySha256: sha256(resolve(output, "verifying-key.bin")),
    proofSha256: sha256(resolve(output, "proof.bin")),
    publicInputsSha256: sha256(resolve(output, "public-inputs.bin")),
  };
}

writeFileSync(
  resolve(build, "proving-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(`wrote ${resolve(build, "proving-manifest.json")}`);
