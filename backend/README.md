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

Live role processes, Walrus transcript upload credentials, the selected x402
facilitator, and Phase 2 report generation remain integration configuration;
no test-only pool is represented as production-safe.
