# Supercuts backend, CLI, and MCP

The backend is the role-separated foundation shared by the Phase 3 CLI and MCP
adapters. Settlement and policy decisions remain in this package rather than
being reimplemented in tool handlers.

Each buyer, seller, auditor, resource server, and relayer uses a separate
SQLite state path and a separate owner-only 32-byte state-key file. Secret
rows are encrypted before reaching SQLite. Do not reuse a role's key file.

## Development

```sh
pnpm install
pnpm check
pnpm test
pnpm build
```

The package deliberately does not load `.env` itself. Process adapters validate
and inject configuration, keeping credentials out of logs and returned objects.

The `supercuts` binary emits one versioned JSON response. The `supercuts-mcp`
binary implements MCP JSON-RPC over newline-delimited stdio and exposes only the
tools allowed by the initialized role. Use separate `SUPERCUTS_HOME` directories
for buyer, seller, and auditor processes. Development homes initialized with
`--mock` always label receipts `deterministic-mock-not-funded`.

`@supercuts/sdk` is built from `packages/sdk`. It resolves the matching
`supercuts-seam` binary from this package and exchanges one protocol-v1 request
per subprocess. SDK mutations use exact-intent approval tokens instead of the
legacy CLI `--authorize` boolean.

Create a live Testnet profile from the repository root. Credential files must
be owner-only and contain the Sui private key and Tatum API key respectively:

```sh
chmod 600 .secrets/sui.key .secrets/tatum.key
pnpm --dir backend exec supercuts init --role buyer --home .state/live-buyer \
  --deployment-config config/phase1.testnet.json \
  --sui-key-file .secrets/sui.key --tatum-key-file .secrets/tatum.key \
  --write-grpc https://fullnode.testnet.sui.io:443 \
  --tatum-grpc https://sui-testnet.gateway.tatum.io:443 \
  --rapidsnark circuits/build/tools/rapidsnark-src/build_prover/src/prover
```

Live mutations require an `--operation-id`. Withdrawals additionally require a
32-byte `--recipient`. A failed or ambiguous broadcast retains the exact signed
bytes under that operation ID; retrying another payload with the same ID fails.

## Current boundaries

- `TatumLedger` uses native HTTP/2 gRPC with an API key for evidence reads.
- `buildPrivateTransfer` builds the pinned pool's `transfer_private` PTB using
  the Sui TypeScript gRPC stack.
- `LiveRuntime` also builds deposit and withdrawal PTBs, reconstructs the
  20-level Poseidon tree from pinned pool events, creates dynamic circuit
  witnesses, verifies artifact hashes, and uses RapidSnark with SnarkJS fallback.
- `RelayAdmission` verifies a single-use, Sui-signed relay challenge before
  a pinned proof/public-statement submission can be broadcast.
- `ManualMemory` uses `MemWalManual`, so memory plaintext is embedded and
  encrypted on the client before the Walrus Memory relayer receives it.
- `DurableTranscriptTransport` persists exact ciphertext before Walrus upload
  and authenticates the complete transcript after restart.
- `PrivateWallet` reconciles only finalized, pinned pool evidence and recovers
  payment/change notes from matching openings.
- `ExactResourceServer` adds a signed request binding and atomic payment-use
  ledger around the standard x402 exact rail. `scripts/x402-live-e2e.ts` starts
  with a live 402 challenge, settles the signed Sui transaction through the
  protected resource, reconciles chain evidence, and checks both replay paths.
- `SealClientDisclosureTransport` encrypts auditor-scoped disclosure packages;
  `scripts/seal-live-e2e.ts` supplies the deployed account policy approval PTB,
  verifies finalized chain evidence, and gates the designated auditor decrypt.

The selected x402 facilitator remains deployment configuration. The Testnet
Seal policy is pinned in `config/seal-policy.testnet.json`. No test-only pool is represented as production-safe. Run the
repository-level `scripts/phase2-check.sh` and see `phase-2-report.md` for the
live test evidence and explicit production boundary.
