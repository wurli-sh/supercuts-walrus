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

MCP mutations are authorized by the owner-only `mandate.json` created at
initialization. Tool schemas reject unknown arguments (including the deprecated
`authorize` flag), require an operation ID for every mutation, and enforce the
mandate's command list, counterparties, assets, per-deal ceiling, total run
budget, privacy requirement, and expiry before creating an internal exact-intent
approval. Approval tokens are never returned to the agent.

Buyer mandates may additionally set `requireSettlementPlan` and narrow allowed
capability IDs, capability classes, and rails. `settlement.plan` deterministically
ranks validated manifests, applies only trusted typed memories, clamps the opening
and maximum amounts, and persists a five-minute canonical plan. Pass its
`planHash` to `pay.x402` or `pay.shielded`; the runtime binds the exact operation,
manifest, seller, endpoint/session, asset, network, rail, request, and amount
before signing or proving. `supercuts settlement approve-review` is an owner-only
CLI path and is intentionally absent from MCP and the agent SDK.

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

## Procurement demo

For the Codex buyer with three remote Claude-backed sellers, Supabase-backed seller state, and the separate Render facilitator, follow [the remote demo guide](../docs/remote-codex-demo.md). The remote path is live-only and gives Codex a buyer role MCP server; the three seller panes use the safe `supercuts-seller-watch` event stream.

`supercuts-demo` is the operator entry point:

```sh
# Four isolated development roles and their MCP configuration.
supercuts-demo setup --state-dir .state/demo --mock
supercuts-demo doctor --state-dir .state/demo
supercuts-demo check --state-dir .state/demo --events evidence/run.jsonl

# Never submits a transaction; every event is relabeled recorded-funded-run.
supercuts-demo replay --state-dir .state/demo --events evidence/run.jsonl
supercuts-demo replay --events evidence/run.jsonl --serve --port 4173
```

Omit `--mock` and provide the pinned deployment, Tatum, Sui gRPC, and optional
owner-only Mainnet memory configuration arguments to create live profiles. The
setup output prints only the buyer address/assets that need funding and the
public seller `payTo` address. `live --workflow workflow.json` refuses mock
profiles. Setup also requires `--workflow workflow.json` so the generated buyer
mandate can be narrowed to its exact capability IDs/classes and rails. The live
run creates a baseline plan, negotiates the public exact amount, executes the
seller-owned x402 resource, writes ten typed Mainnet memories plus an owner
privacy policy, restarts the buyer process, recalls citations without plaintext,
creates the shielded plan, deposits a buyer note, signs and accepts a
confidential agreement with the confidential seller, and settles it. The live
workflow must set `publicOperationId` to the operation ID registered by the
seller resource for `publicResourceUrl`. It must also set
`buyerDepositAmount` above the confidential capability's minimum price so the
private transfer can create a positive change note. Use a fresh operation ID
and resource registration for each recording. The JSONL stream describes x402 amount/payee as
public. Shielded settlement avoids a direct public payment revealing the deal
amount or counterparty; funding, deposits, withdrawals, gas, and pool activity
remain visible.

For a Claude-agent recording, export `CLAUDE_API_KEY` or provide
`live --claude-key-file <owner-only-file>`; a repository `.env` file is not
loaded automatically. Validate the credential against Anthropic before starting
a funded take.
The live path calls Claude for bounded buyer and seller decisions and records
only the model, action, and token counts. The backend still enforces capability,
amount, rail, and agreement bindings. Validate that recording with
`supercuts-demo check --require-claude`; an earlier funded run without these
agent-decision events does not satisfy that gate.

The optional `--memory-config-file` is imported from a mode-0600 JSON file and
stored only as encrypted role state. It has the `ManualMemoryConfig` fields
documented by `src/memwal.ts`; its Sui and embedding credentials never enter
profiles, prompts, MCP calls, events, or browser state. Live profiles reject
non-loopback embedding endpoints; use the repository's 1536-dimension adapter
for both writes and recalls.

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
  ledger around the standard x402 exact rail. The seller-owned resource URL is
  supplied to the live workflow; the facilitator only validates and relays the
  buyer-signed transaction.
- `SealClientDisclosureTransport` encrypts auditor-scoped disclosure packages;
  `scripts/seal-live-e2e.ts` supplies the deployed account policy approval PTB,
  verifies finalized chain evidence, and gates the designated auditor decrypt.

The selected x402 facilitator URL remains public deployment configuration. Its
`FACILITATOR_SHARED_KEY` is seller-only configuration: it is sent only by the
resource service as `x-supercuts-facilitator-key`, and must never appear in a
buyer profile, manifest, event log, or dashboard. The Testnet
Seal policy is pinned in `config/seal-policy.testnet.json`. No test-only pool is represented as production-safe. Run the
repository-level `scripts/phase2-check.sh` and see `phase-2-report.md` for the
live test evidence and explicit production boundary.
