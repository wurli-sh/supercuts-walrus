import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fail } from "./errors.js";

const run = promisify(execFile);
export type CircuitName = "deposit" | "transfer" | "withdraw";
export interface ProverConfig {
  artifactRoot: string; snarkjsPath: string; converterPath: string; rapidsnarkPath?: string; version?: 2;
  expected: Record<CircuitName, { zkeySha256: string; verifyingKeySha256: string }>;
}
export interface ProofResult { proof: Buffer; publicInputs: Buffer; engine: "rapidsnark" | "snarkjs"; proveMs: number; }
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function executable(path: string): boolean { try { accessSync(path, constants.X_OK); return true; } catch { return false; } }

export class Groth16Prover {
  constructor(private readonly config: ProverConfig) {}
  private artifactName(name: CircuitName): string { return `${name}${this.config.version === 2 ? "_v2" : ""}`; }
  doctor(): { rapidSnark: boolean; artifacts: Record<CircuitName, string> } {
    const artifacts = {} as Record<CircuitName, string>;
    for (const name of ["deposit", "transfer", "withdraw"] as const) {
      const artifact = this.artifactName(name);
      const zkey = resolve(this.config.artifactRoot, `proofs/${artifact}/${artifact}.zkey`), vk = resolve(this.config.artifactRoot, `proofs/${artifact}/verifying-key.bin`), expected = this.config.expected[name];
      if (!existsSync(zkey) || !existsSync(vk)) fail("PROVING_ARTIFACT_MISSING", `pinned ${name} artifacts are missing`);
      if (sha256(zkey) !== expected.zkeySha256 || sha256(vk) !== expected.verifyingKeySha256) fail("ARTIFACT_HASH_MISMATCH", `${name} artifact hash differs from deployment configuration`);
      artifacts[name] = expected.zkeySha256;
    }
    if (!executable(this.config.snarkjsPath) || !executable(this.config.converterPath)) fail("PROVER_TOOL_MISSING", "SnarkJS or the Arkworks converter is not executable");
    return { rapidSnark: Boolean(this.config.rapidsnarkPath && executable(this.config.rapidsnarkPath)), artifacts };
  }
  async prove(name: CircuitName, input: Record<string, unknown>): Promise<ProofResult> {
    this.doctor(); const directory = mkdtempSync(join(tmpdir(), `supercuts-${name}-`));
    try {
      const artifact = this.artifactName(name);
      const inputPath = join(directory, "input.json"), witness = join(directory, "witness.wtns"), proofJson = join(directory, "proof.json"), publicJson = join(directory, "public.json"), converted = join(directory, "converted");
      writeFileSync(inputPath, JSON.stringify(input), { mode: 0o600 }); mkdirSync(converted, { mode: 0o700 });
      const generator = resolve(this.config.artifactRoot, `${artifact}_js/generate_witness.js`), wasm = resolve(this.config.artifactRoot, `${artifact}_js/${artifact}.wasm`), zkey = resolve(this.config.artifactRoot, `proofs/${artifact}/${artifact}.zkey`), verificationKey = resolve(this.config.artifactRoot, `proofs/${artifact}/verification-key.json`);
      if (![generator, wasm, verificationKey].every(existsSync)) fail("PROVING_ARTIFACT_MISSING", `${name} witness or verification artifacts are missing`);
      await run(process.execPath, [generator, wasm, inputPath, witness], { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 });
      const useRapid = Boolean(this.config.rapidsnarkPath && executable(this.config.rapidsnarkPath)), started = Date.now();
      if (useRapid) await run(this.config.rapidsnarkPath!, [zkey, witness, proofJson, publicJson], { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 });
      else await run(this.config.snarkjsPath, ["groth16", "prove", zkey, witness, proofJson, publicJson], { timeout: 20 * 60_000, maxBuffer: 4 * 1024 * 1024 });
      const proveMs = Date.now() - started;
      await run(this.config.snarkjsPath, ["groth16", "verify", verificationKey, publicJson, proofJson], { timeout: 2 * 60_000, maxBuffer: 4 * 1024 * 1024 });
      await run(this.config.converterPath, [name, verificationKey, proofJson, publicJson, converted], { timeout: 2 * 60_000, maxBuffer: 4 * 1024 * 1024 });
      const preparedVk = join(converted, "verifying-key.bin"); if (sha256(preparedVk) !== this.config.expected[name].verifyingKeySha256) fail("ARTIFACT_HASH_MISMATCH", "converter produced an unexpected verifying key");
      const proof = readFileSync(join(converted, "proof.bin")), publicInputs = readFileSync(join(converted, "public-inputs.bin")); if (!proof.length || publicInputs.length !== 64) fail("PROOF_INVALID", "converted proof or public inputs have an invalid size");
      return { proof, publicInputs, engine: useRapid ? "rapidsnark" : "snarkjs", proveMs };
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}
