/**
 * SnarkJS Groth16 JSON -> Arkworks canonical compressed BN254 bytes (the format Sui's groth16 module expects).
 *
 * TypeScript port of `crates/supercuts-groth16`, so npm installs do not need a Rust toolchain. The prover runs
 * `snarkjs groth16 verify` before conversion and then checks the converted verifying key against the pinned
 * deployment hash, so a conversion bug cannot produce an accepted-but-wrong proof.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail } from "./errors.js";

const FQ =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const FR =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const NEGATIVE = 0x80,
  INFINITY = 0x40;

function field(value: unknown, modulus: bigint, label: string): bigint {
  if (typeof value !== "string" || !/^\d{1,80}$/.test(value))
    return fail("PROOF_INVALID", `${label} must be a decimal string`);
  const parsed = BigInt(value);
  if (parsed >= modulus) fail("PROOF_INVALID", `${label} is outside its field`);
  return parsed;
}

function le32(value: bigint): Buffer {
  const out = Buffer.alloc(32);
  for (let index = 0, rest = value; index < 32; index += 1, rest >>= 8n)
    out[index] = Number(rest & 0xffn);
  return out;
}

const negative = (value: bigint) => value > (FQ - value) % FQ;

function array(value: unknown, length: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length < length)
    fail("PROOF_INVALID", `${label} must have ${length} coordinates`);
  return value as unknown[];
}

/** Projective SnarkJS points carry z = 1 for affine points; anything else is not a canonical affine point. */
function affine(z: unknown, one: unknown, label: string): void {
  if (z === undefined) return;
  const value = Array.isArray(z) ? z : [z];
  if (value[0] !== "1" || value.slice(1).some((item) => item !== one))
    fail("PROOF_INVALID", `${label} must be an affine point`);
}

export function encodeG1(value: unknown, label = "G1"): Buffer {
  const point = array(value, 2, label);
  affine(point[2], undefined, label);
  const x = field(point[0], FQ, `${label}.x`),
    y = field(point[1], FQ, `${label}.y`);
  if (x === 0n && y === 0n)
    fail("PROOF_INVALID", `${label} is the point at infinity`);
  const out = le32(x);
  if (out[31]! & (NEGATIVE | INFINITY))
    fail("PROOF_INVALID", `${label}.x overlaps the flag bits`);
  if (negative(y)) out[31]! |= NEGATIVE;
  return out;
}

export function encodeG2(value: unknown, label = "G2"): Buffer {
  const point = array(value, 2, label);
  affine(point[2], "0", label);
  const [x0, x1] = array(point[0], 2, `${label}.x`).map((item, index) =>
    field(item, FQ, `${label}.x.c${index}`),
  ) as [bigint, bigint];
  const [y0, y1] = array(point[1], 2, `${label}.y`).map((item, index) =>
    field(item, FQ, `${label}.y.c${index}`),
  ) as [bigint, bigint];
  if (x0 === 0n && x1 === 0n && y0 === 0n && y1 === 0n)
    fail("PROOF_INVALID", `${label} is the point at infinity`);
  const out = Buffer.concat([le32(x0), le32(x1)]);
  if (out[63]! & (NEGATIVE | INFINITY))
    fail("PROOF_INVALID", `${label}.x overlaps the flag bits`);
  // Arkworks orders Fq2 lexicographically from the highest coefficient: c1 decides unless it is zero.
  if (y1 !== 0n ? negative(y1) : negative(y0)) out[63]! |= NEGATIVE;
  return out;
}

export function encodePublicInputs(value: unknown): Buffer {
  if (!Array.isArray(value) || !value.length)
    return fail("PROOF_INVALID", "public inputs must be a non-empty array");
  return Buffer.concat(
    value.map((item, index) => le32(field(item, FR, `public[${index}]`))),
  );
}

export function encodeProof(proof: Record<string, unknown>): Buffer {
  return Buffer.concat([
    encodeG1(proof.pi_a, "pi_a"),
    encodeG2(proof.pi_b, "pi_b"),
    encodeG1(proof.pi_c, "pi_c"),
  ]);
}

export function encodeVerifyingKey(key: Record<string, unknown>): Buffer {
  const ic = key.IC;
  if (!Array.isArray(ic) || ic.length < 2)
    return fail("PROOF_INVALID", "verification key IC is missing");
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(ic.length));
  return Buffer.concat([
    encodeG1(key.vk_alpha_1, "vk_alpha_1"),
    encodeG2(key.vk_beta_2, "vk_beta_2"),
    encodeG2(key.vk_gamma_2, "vk_gamma_2"),
    encodeG2(key.vk_delta_2, "vk_delta_2"),
    length,
    ...ic.map((point, index) => encodeG1(point, `IC[${index}]`)),
  ]);
}

/** Same outputs as the Rust converter: verifying-key.bin, proof.bin, public-inputs.bin in `outputDir`. */
export function convertGroth16(
  verificationKeyPath: string,
  proofPath: string,
  publicPath: string,
  outputDir: string,
): void {
  const read = (path: string) =>
    JSON.parse(readFileSync(path, "utf8")) as unknown;
  const key = read(verificationKeyPath) as Record<string, unknown>,
    proof = read(proofPath) as Record<string, unknown>,
    inputs = read(publicPath);
  const publicInputs = encodePublicInputs(inputs);
  if ((key.IC as unknown[]).length !== publicInputs.length / 32 + 1)
    fail("PROOF_INVALID", "verification key and public input counts differ");
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(outputDir, "verifying-key.bin"), encodeVerifyingKey(key));
  writeFileSync(join(outputDir, "proof.bin"), encodeProof(proof));
  writeFileSync(join(outputDir, "public-inputs.bin"), publicInputs);
}
