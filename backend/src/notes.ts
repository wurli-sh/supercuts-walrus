import { buildPoseidon } from "circomlibjs";
import { fail } from "./errors.js";

const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const U64_MAX = (1n << 64n) - 1n;

export interface NoteOpening {
  deployment: bigint;
  amount: bigint;
  ownerAx: bigint;
  ownerAy: bigint;
  spendSecret: bigint;
  salt: bigint;
}

let poseidonPromise: ReturnType<typeof buildPoseidon> | undefined;
function field(name: string, value: bigint): void {
  if (typeof value !== "bigint" || value <= 0n || value >= FIELD_MODULUS) fail("NOTE_OPENING_INVALID", `${name} must be a nonzero canonical BN254 field element`);
}

export function encodeNoteOpening(opening: NoteOpening): Buffer {
  return Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(opening).map(([key, value]) => [key, value.toString()]))));
}

/** Recomputes the exact Poseidon commitment enforced by protocol-v1 circuits. */
export async function noteCommitment(opening: NoteOpening): Promise<string> {
  field("deployment", opening.deployment); field("ownerAx", opening.ownerAx); field("ownerAy", opening.ownerAy);
  field("spendSecret", opening.spendSecret); field("salt", opening.salt);
  if (typeof opening.amount !== "bigint" || opening.amount <= 0n || opening.amount > U64_MAX) fail("NOTE_OPENING_INVALID", "amount must be a positive u64");
  const poseidon = await (poseidonPromise ??= buildPoseidon());
  const spendTag = poseidon.F.toObject(poseidon([2006n, opening.spendSecret]));
  const commitment = poseidon.F.toObject(poseidon([2010n, opening.deployment, opening.amount, opening.ownerAx, opening.ownerAy, spendTag, opening.salt]));
  return commitment.toString(16).padStart(64, "0");
}
