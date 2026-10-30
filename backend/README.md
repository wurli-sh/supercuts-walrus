# Supercuts Phase 2 backend

The backend is the role-separated, headless foundation for Phase 2. It exposes
typed services rather than a command-line interface; Phase 3 will wrap these
services with CLI and MCP adapters.

Each buyer, seller, auditor, resource server, and relayer uses a separate
SQLite state path and a separate owner-only 32-byte state-key file. Secret
rows are encrypted before reaching SQLite. Do not reuse a role's key file.

## Development

```sh
pnpm install
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsx --test test/**/*.test.ts
```

The package deliberately does not load `.env` itself. The Phase 3 process
adapter must validate and inject configuration, keeping credentials out of
backend logs and returned objects.

## Current boundaries

- `TatumLedger` uses native HTTP/2 gRPC with an API key for evidence reads.
- `buildPrivateTransfer` builds the pinned pool's `transfer_private` PTB using
  the Sui TypeScript gRPC stack.
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
