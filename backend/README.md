# Supercuts backend, CLI, and MCP

The backend implements Supercuts' private negotiation and settlement layer for
agents. Signed encrypted offers bind an agreement to a public x402 or shielded
payment. Walrus Memory carries typed owner rules and verified outcomes across
runs, so remembered context can guide a later deal. The role-separated CLI,
MCP, and SDK adapters share this runtime; settlement and policy decisions stay
here rather than being reimplemented in tool handlers.

Each buyer, seller, auditor, resource server, and relayer uses a separate
SQLite state path and a separate owner-only 32-byte state-key file. Secret
rows are encrypted before reaching SQLite. Do not reuse a role's key file.

## Development

For npm tarball verification and publishing handoff, see [the release guide](../docs/npm-release.md).

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

For a reusable live buyer, run `supercuts setup buyer --home <buyer-home>` and
follow [the self-service setup guide](../docs/self-service-setup.md). It creates
a standing v2 policy, signed seller sources, and a Codex MCP configuration.
For independent seller registration and buyer approval through the shared
Testnet directory, follow [the onboarding guide](../docs/testnet-onboarding.md).

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

`@supercuts-walrus/sdk` is built from `packages/sdk`. It resolves the matching
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
  --tatum-grpc https://sui-testnet-grpc.gateway.tatum.io:443 \
  --rapidsnark circuits/build/tools/rapidsnark-src/build_prover/src/prover
```

Live mutations require an `--operation-id`. Withdrawals additionally require a
32-byte `--recipient`. A failed or ambiguous broadcast retains the exact signed
bytes under that operation ID; retrying another payload with the same ID fails.

## Procurement demo

For the Codex buyer with three remote sellers, Claude-researched and owner-reviewed artifacts, Supabase-backed seller state, and the separate Render facilitator, follow [the remote demo guide](../docs/remote-codex-demo.md). The remote path is live-only and gives Codex a buyer role MCP server; the three seller panes use the safe `supercuts-seller-watch` event stream.

`supercuts-demo` is the operator entry point:

```sh
# Five isolated development roles and their MCP configuration.
supercuts-demo setup --state-dir .state/demo --mock
supercuts-demo doctor --state-dir .state/demo
supercuts-demo check --state-dir .state/demo --events evidence/run.jsonl

# Never submits a transaction; every event is relabeled recorded-funded-run.
supercuts-demo replay --state-dir .state/demo --events evidence/run.jsonl
supercuts-demo replay --events evidence/run.jsonl --serve --port 4173
```

Its commands are `setup`, `doctor`, `seed-policy`, `check`, and `replay`.
Omit `--mock` and provide the pinned deployment, Tatum, Sui gRPC, and optional
owner-only Mainnet memory configuration arguments to create live profiles. The
setup output prints only the buyer address/assets that need funding and the
public seller `payTo` address. `--workflow workflow.json` narrows the generated
buyer mandate to exact capability IDs/classes and rails.

There is no scripted live runner. Deals run only through `deal.execute` in
Codex: the confidential deal first, with the recalled owner privacy rule
rerouting a requested x402 payment to shielded, then a public x402 deal. The
remote demo guide gives the recording scripts and the acceptance gate
(`scripts/recording-check.mjs`). The JSONL stream describes x402 amount/payee
as public. Shielded settlement avoids a direct public payment revealing the
deal amount or counterparty; funding, deposits, withdrawals, gas, and pool
activity remain visible.

Hosted seller price and agreement decisions are deterministic after backend
validation; Claude web research runs before provisioning so model availability
cannot interrupt a paid request. `supercuts-demo check --require-claude`
applies only to event streams from the earlier scripted runner, which recorded
Claude agent-decision events.

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
  ledger around the standard x402 exact rail. The seller owns the protected
  resource; the facilitator only validates and relays the buyer-signed
  transaction.
- `SealClientDisclosureTransport` encrypts auditor-scoped disclosure packages;
  `scripts/seal-live-e2e.ts` supplies the deployed account policy approval PTB,
  verifies finalized chain evidence, and gates the designated auditor decrypt.

The selected x402 facilitator URL remains public deployment configuration. Its
`FACILITATOR_SHARED_KEY` is seller-only configuration: it is sent only by the
resource service as `x-supercuts-facilitator-key`, and must never appear in a
buyer profile, manifest, event log, or dashboard. The Testnet
Seal policy is pinned in `config/seal-policy.testnet.json`. No test-only pool is represented as production-safe. Run the
repository-level `scripts/phase2-check.sh` for the live gate, and see
[the v2 pool guide](../docs/pool-v2.md) for funded Testnet evidence.

## Protocol memory worker

The long-running buyer MCP process drains pending outcome writes every 30
seconds. For a live role home used without MCP, run
`supercuts-memory-worker <role-home>` as a separate process. It drains pending
verified outcome writes and synchronizes the role's Walrus Memory metadata
using `listMemories()`. `memory.inventory` performs one metadata sync on demand.
An uncertain write remains `unresolved` for operator reconciliation; the
worker does not submit it again automatically. `deal.reconcile` compares
client-decrypted recall results with the exact saved outcome; a missing search
hit leaves the job unresolved.

## Composite deal adapters

The buyer SDK exposes `executeDeal`, `getDeal`, `resumeDeal`,
`getDealEvidence`, and `getDealDelivery`. The built-in live adapter loads
owner-only `deal-sellers.json` from the buyer role home. It is a JSON array of
seller origins, for example `["https://seller.example"]`, mode `0600`. It
discovers signed capabilities at `/v2/catalog`, fetches the signed manifest
from Walrus, selects the mandate-approved rail, and uses the buyer role's own
signer, pool notes, Walrus and Walrus Memory configuration. A missing file
returns `DEAL_SELLERS_NOT_CONFIGURED`. An owner-only `deal-ports.mjs` exporting
`createDealPorts(app, mandate)` remains available as an advanced override.

Create a seller home with `supercuts onboard seller --home <seller-home>` or
its noninteractive `--config <owner-only-setup.json>` form. It generates a
fresh seller signer by default, writes a seller MCP stanza, and explicitly
reports that the seller should not receive faucet funds. The seller service is
`supercuts-seller-live <seller-home> <config.json>`.
Use `supercuts seller scaffold` to generate the offer spec, replaceable handler,
future expiry, environment-based facilitator config, and exact next commands.
The npm tarball includes pinned metadata for x402-only sellers; shielded sellers
still install the proof artifacts required for recovery and exits.

Research sellers can create a source-backed draft before packaging:

```sh
CLAUDE_API_KEY=... supercuts seller research --kind market-brief \
  --topic "Current Sui ecosystem market structure and risks" \
  --output <owner-only-draft.json>
```

The command uses Anthropic web search, rejects citations absent from the search
evidence, and writes a mode-0600 draft marked `draft-needs-owner-review`.
Optional `--allowed-domains` constrains sources. It never publishes or changes
live seller state; an owner must review and approve the immutable bytes first.
Register each capability first with
`supercuts-seller-register <seller-home> <spec.json> <registration.json>`.
The spec contains `capabilityId`, `capability`, `description`, `inputSchema`,
`outputSchema`, `supportedRails`, `priceBand`, `asset`, `endpoint`, and
`expiresAt`; Supercuts inserts the seller signer address, validates the schema,
publishes the manifest to Walrus, and signs its manifest hash and transport
key. The registration file is created mode `0600`. The endpoint is the
seller-owned resource prefix, such as
`https://seller.example/v2/resource/report`. The current wire contract uses
the signed price band's `minimum` as its exact price.

The seller's owner-only config has this shape:

```json
{
  "origin": "https://seller.example",
  "listenHost": "127.0.0.1",
  "listenPort": 8788,
  "facilitatorUrl": "https://facilitator.example",
  "facilitatorKey": "OWNER_ONLY_FACILITATOR_SECRET",
  "allowedBuyers": ["0xBUYER_ADDRESS"],
  "capabilities": [
    { "registrationFile": "/owner/path/registration.json", "handler": "/owner/path/handler.mjs" }
  ]
}
```

The handler module exports `default async function handle(request)` and
returns `{ artifact: Uint8Array, contentType: string, metadata: object }`.
Its `request.input` is decrypted inside the seller role, and `metadata` must
match the signed output schema. Keep config and handler mode `0600`. Put a TLS
reverse proxy in front of the local listener when `origin` is public HTTPS.
The facilitator key stays in the seller config. The x402 resource delivers a
paid acknowledgment; the buyer then requests the encrypted artifact. For a
shielded deal, the seller verifies the pinned pool transfer event and recovers
its note before the handler runs. Both rails require matching finalized Sui and
Tatum evidence. The service publishes encrypted offer, agreement reply, and
delivery blobs to Walrus and checks readback.

Issue a buyer `supercuts.mandate.v2` allowing `deal.execute` and the underlying
planning, agreement, payment, and memory commands. Shielded is the default;
public x402 additionally requires `allowPublicX402: true`, `allowedRails`
containing `x402`, and no shielded-only privacy rule. The buyer must have
Testnet SUI for gas and payment, a v2 pool deposit for shielded settlement,
proof artifacts, and an owner-only Mainnet Walrus Memory configuration.
`executeDeal` returns `outcome_pending` after finalized payment and verified
delivery, with the artifact available through `getDealDelivery`. Walrus Memory
indexing proceeds in the worker; `getDeal` later returns `complete` when the
outcome blob appears in inventory. `reconcileDealOutcome` handles an ambiguous
manual Memory write without repaying or resubmitting it. Mock profiles are
refused.

The generic live wire has been tested with local Walrus and signed HTTP
negotiation on both rails, plus simulated Sui and Tatum seller verification.
On 2026-11-03, separate funded Sui Testnet composite operations reached
`complete`: shielded digest
`HxyeTY9ThQoAtz4a1FLcgJhj1vtsSGSB3zyz6A9fyoeq` and public x402 digest
`CAWTGRYSr5aTzMmToxZbZQmeX4DN2KiZz7ANoZxNsGeM`. Both buyer journals
show finalized payment, verified Walrus delivery readback, and indexed Walrus
Memory outcome. The shielded seller recovered its payment note. These are
live Testnet observations, separate from the recorded `supercuts-demo` event
stream. The v2 pool remains experimental and Testnet-only.
