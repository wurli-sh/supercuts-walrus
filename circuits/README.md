# Supercuts circuits

These circuits are the shielded settlement part of Supercuts' private agent
negotiation and settlement layer. The authenticated agreement is handled by the
backend; Walrus Memory informs later decisions, while the proof constrains the
pool transition. The pool and artifacts are experimental Testnet software.

The circuits use a frozen SHA-256 statement compressor. They intentionally
expose exactly two public inputs and constrain every statement byte. The
current pinned pool uses the v2 circuits (statement version 2); the v1 circuits
remain for redeeming existing v1 notes. Run:

```sh
pnpm install --frozen-lockfile
pnpm compile:v2
pnpm test:v2
pnpm prove:v2:test-only
```

`pnpm compile` and `pnpm prove:test-only` build the v1 artifacts without
touching v2. See [the v2 pool guide](../docs/pool-v2.md) for the deployment.

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

The build manifest remains `"testOnly": true`. The proving keys come from a
local, unreviewed setup; no ceremony-reviewed proving key exists. The pinned
experimental Testnet pool and its funded runs (see
[`docs/pool-v2.md`](../docs/pool-v2.md)) use these unaudited artifacts. Do not
use them to custody value.

`prove:test-only` prepares the local Powers of Tau file, creates a fresh local
contribution for each circuit, proves the semantic fixtures, verifies them with
SnarkJS, converts them to Sui's Arkworks canonical compressed format, and writes
hashes to `build/proving-manifest.json`. The generated keys are explicitly
unaudited and are suitable only for the funded Testnet demonstration.

## Free local embeddings for Walrus Mainnet

The Mainnet relayer requires a 1536-dimensional vector. The adapter supports
local OpenAI-compatible models with up to 1536 output dimensions: it zero-pads
shorter vectors and rejects larger ones. Padding preserves similarity scores
when writes and recalls use the same model and dimensions. The following
example uses `embeddinggemma`, which produces 768 values. Set the upstream
model and endpoint to use another local model. The endpoint receives memory
plaintext, so use a trusted local service.

```sh
export EMBEDDING_UPSTREAM_BASE_URL=http://127.0.0.1:11434/v1
export EMBEDDING_UPSTREAM_MODEL=embeddinggemma
pnpm embedding:adapter
```

Then set these in the repository `.env` before running `pnpm walrus:manual-check`:

```sh
EMBEDDING_ENDPOINT=http://127.0.0.1:8787/v1
EMBEDDING_API_KEY=local-placeholder
EMBEDDING_MODEL=embeddinggemma-1536
```

The placeholder key is local-only and is required solely by the SDK's client
configuration. Do not point the manual check at embeddinggemma directly: use
the adapter for both `rememberManual` and `recallManual`.

