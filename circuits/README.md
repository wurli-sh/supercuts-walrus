# Supercuts Phase 1 circuits

The current files implement and test the frozen SHA-256 statement compressor.
They intentionally expose exactly two public inputs and constrain every statement
byte. Run:

```sh
pnpm install --frozen-lockfile
pnpm compile
pnpm prove:test-only
```

For the recurring transaction path, install the pinned native prover once and
benchmark it against SnarkJS using the same witness and proving key:

```sh
pnpm setup:rapidsnark
pnpm prove:transaction transfer build/proofs/transfer/input.json build/benchmarks/transfer --prover=both
```

For normal proving, omit `--prover=both`. The default `auto` mode uses the
native prover when installed and otherwise uses SnarkJS. Every result is still
verified by SnarkJS and by the Arkworks/Sui converter. The command also refuses
to use a zkey or prepared verification key whose SHA-256 hash differs from
`config/phase1.testnet.json`; there is no unchecked fast path. Set
`RAPIDSNARK_PATH` to use a separately installed prover.

For the funded Testnet demonstration only, `pnpm fixtures:live` creates fresh
local recovery material and inputs bound to the configured Testnet pool. It
refuses to overwrite an existing run and writes only under ignored `build/`.
Submit each generated proof with `pnpm submit:live <stage>` first; this performs
a dry run. Add `--execute` only after the dry run passes.

If a prior test deposit must remain in the tree, `pnpm fixtures:live:append`
creates a fresh, recoverable note at the next leaf; use `--append` with both
`prove:transaction` output paths and `submit:live` for that run.

The circuits constrain the complete local transition: note openings and
ownership, canonical BN254 field encodings, Merkle membership and appends,
value conservation, agreement binding, and both parties' EdDSA
authorizations. They expose only the two SHA-256 digest limbs accepted by Sui's
Groth16 verifier.

The build manifest remains `"testOnly": true`. No ceremony-reviewed proving
key, prepared verifier key, pool object, or funded settlement run is included
in this repository yet. Do not use these generated artifacts to custody value.

`prove:test-only` prepares the local Powers of Tau file, creates a fresh local
contribution for each circuit, proves the semantic fixtures, verifies them with
SnarkJS, converts them to Sui's Arkworks canonical compressed format, and writes
hashes to `build/proving-manifest.json`. The generated keys are explicitly
unaudited and are suitable only for the funded Testnet demonstration.

