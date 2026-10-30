declare module "circomlibjs" {
  export interface Eddsa {
    babyJub: { F: { e(value: unknown): unknown; toObject(value: unknown): bigint } };
    poseidon(inputs: bigint[]): unknown;
    prv2pub(seed: Uint8Array): [unknown, unknown];
    signPoseidon(seed: Uint8Array, message: unknown): { R8: [unknown, unknown]; S: bigint };
    verifyPoseidon(message: unknown, signature: { R8: [unknown, unknown]; S: bigint }, publicKey: [unknown, unknown]): boolean;
  }
  export function buildEddsa(): Promise<Eddsa>;
  export function buildPoseidon(): Promise<{
    (inputs: bigint[]): unknown;
    F: { toObject(value: unknown): bigint };
  }>;
}
