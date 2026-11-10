# Partner feedback

Engineering notes from building Supercuts for the Total Recall: Tatum x Walrus
Memory Hackathon. Each item names the SDK call, the behavior we observed, the
workaround in this repository, and the change that would have removed the
workaround. Line references are to this repository.

Versions: `@mysten-incubation/memwal` 0.1.11, `@mysten/walrus` 1.2.37,
`@mysten/sui` 2.38.0, Node 22, Walrus Memory Mainnet relayer
`https://relayer.memory.walrus.xyz`, Tatum Sui Testnet gRPC
`sui-testnet-grpc.gateway.tatum.io:443`.

## Walrus Memory

### How we use it

We use `MemWalManual` (`@mysten-incubation/memwal/manual`) so that plaintext is
embedded and encrypted locally; the relayer only receives ciphertext
(`backend/src/memwal.ts`). Writes call `rememberManual(text)`, recall calls
`recallManual(query, { limit })`, and a metadata-only inventory sync pages
`MemWal.listMemories({ cursor, namespace })` and handles `must_resync`.
Trusted memories (owner policy, verified outcome) are wrapped in an Ed25519
envelope signed with the owner's key. Recall verifies that signature before a
memory may change a payment, so authority survives a move to another machine.

What worked well: the manual client's trust boundary is the right default for
agent memory, namespaces made per-buyer isolation trivial, and `listMemories()`
with cursors is a clean basis for a local inventory.

### 1. Ambiguous writes have no idempotency or lookup (highest impact)

`rememberManual()` returns `{ blob_id }` only on success. When it times out,
the process is killed mid-call, or the connection drops after send, the client
cannot tell whether the memory was stored:

- Retrying can create a duplicate memory. Duplicates matter to us because
  outcome memories feed a per-seller reliability score and a spend total.
- Not retrying can lose a verified payment outcome.
- `recallManual()` is similarity search, so it cannot prove absence. Our
  reconciliation (`deal.reconcile`) searches for the exact saved text, and a
  missing hit is inconclusive. Newly written memories are also not
  immediately recallable, so absence right after a write means nothing.

Workarounds: a write journal with `pending`/`unresolved` states;
reconciliation by exact text match; a requeue only after a 30-minute claim age
(commit `4bcf3b4`); and clearing the pending job only when the failure provably
happened before the request left the machine (commit `8df8e3d`). A buyer MCP
process stopped by `codex exec` right after a deal left writes in flight, so we
also flush and wait up to 20 seconds on shutdown (commit `f98bc63`).

**Request:** accept a client-supplied idempotency key on `rememberManual`
(same key returns the original `blob_id`), or expose a lookup by a
client-chosen write ID. Either one makes retries safe and removes the
reconciliation layer. Documenting the expected write-to-recall indexing delay
would also help.

### 2. Network failures surface as a bare `TypeError: fetch failed`

When the embedding endpoint or relayer is unreachable, both
`rememberManual()` and `recallManual()` reject with Node's bare
`TypeError("fetch failed")`. The error does not say which of the two
endpoints failed, and it does not distinguish "request never sent" from
"response lost". Those cases need opposite retry handling (see item 1).

Workaround: map that error to `MEMORY_ENDPOINT_UNREACHABLE` with both
endpoint URLs (`unreachable()` in `backend/src/memwal.ts`, commit `ba1b0be`).

**Request:** typed SDK errors carrying the failing stage (`embed`, `encrypt`,
`upload`, `register`) and a `sent: boolean`/`retryable` flag.

### 3. The 1536-dimension requirement and distance scale are undocumented for local models

The Mainnet relayer rejects any embedding that is not 1536-dimensional. Free
local models are smaller (`embeddinggemma` is 768). We wrote a loopback
OpenAI-compatible proxy that zero-pads vectors up to 1536 and rejects larger
or inconsistent ones (`backend/src/embedding-adapter.ts`, exported as
`supercuts-embedding-adapter`). Zero-padding preserves cosine similarity as
long as writes and recalls use the same model.

The distance scale then needed manual calibration. With padded
`embeddinggemma`, an exact owner rule came back at distance ≈ 0.58 to 0.59
against our planner query. A 0.35 cutoff silently excluded it, so the demo
uses 0.61 to 0.65. Nothing in the response indicated that a near-miss had been
filtered.

**Request:** state the dimension requirement and the distance metric in the
quick start; publish typical distance ranges for supported models; and
optionally provide a `minDimensions`/padding option or a documented list of
local models known to work.

### 4. Semantic recall over structured records misses scoped rules

Our memories are canonical JSON records scoped by capability ID, capability
class, seller, network, and asset. A free-text recall such as "my privacy
preferences" missed an owner rule that the planner's scoped query found
moments later (commit `310713f`). We now run both queries and deduplicate by
closest distance, then verify scope exactly on the client.

**Request:** metadata filters on recall (tags or key/value attributes set at
write time), so agents can ask for "privacy rules for capability class X"
without relying on embedding similarity over JSON.

### 5. Configuration is spread across names and sources

The dashboard provides an account ID and a delegate key whose public half is
called `MEMWAL_AGENT_ID` in one place and "Public key" in another. The manual
client also needs `packageId`, `registryId`, `serverUrl`, Walrus aggregator and
publisher URLs, `suiPrivateKey`, and embedding settings. Example code and
scripts use different environment names for the delegate key (`MEMWAL_KEY`,
`MEMWAL_DELEGATE_KEY`, `WALRUS_MEMORY_DELEGATE_KEY`; we accept all three,
commit `144c947`).

Workaround: ship Mainnet defaults so an owner supplies only `key`,
`accountId`, and `suiPrivateKey` (`MEMORY_MAINNET_DEFAULTS` and
`withMemoryDefaults()` in `backend/src/memwal.ts`).

**Request:** a `MemWalManual.mainnet({ key, accountId, suiPrivateKey,
embedding })` preset, one canonical environment variable name per secret, and
dashboard labels that match the SDK field names.

### 6. `must_resync` semantics

`listMemories()` can return `must_resync`. We drop the local inventory for the
namespace and restart from no cursor, and we fail if a second resync is
requested in the same sync. The docs do not say when the relayer sets this
flag or whether a resync can repeat indefinitely. A short description would
let clients handle it with confidence.

## Tatum

We did not use Tatum AI Builder.

### How we use it

Tatum is the independent verifier for every payment. Supercuts submits
transactions through a Sui fullnode, then reads each digest back through
Tatum's Sui gRPC gateway before releasing an artifact or writing an outcome
memory (`backend/src/tatum.ts`). It calls `sui.rpc.v2.LedgerService`:
`GetServiceInfo`, `GetTransaction` with a read mask of `digest`,
`checkpoint`, `effects`, `events`, and `balance_changes`, and `GetObject`.
Gateway reads were consistent with the fullnode across all of our recorded
payments and the relayed pool exit, which both sources reported final at
checkpoint `401764344`.

### 1. Plain gRPC only, with no Node.js example

The gateway speaks HTTP/2 gRPC, not gRPC-web, so the gRPC-web transports
commonly used from TypeScript do not work. We wrote a roughly 60-line
`node:http2` client. It sends `POST /sui.rpc.v2.LedgerService/<Method>` with
`content-type: application/grpc`, `te: trailers`, and `x-api-key: <key>`,
writes 5-byte length-prefixed frames (uncompressed), and reads `grpc-status`
from headers or trailers. Messages are encoded with the protobuf types already
exported by `@mysten/sui/grpc` (`GrpcTypes`). We also enforce HTTPS, a
20-second timeout, and a 32 MiB response limit.

**Request:** a Node.js snippet in the Sui gRPC docs showing the
endpoint, the `x-api-key` metadata name, and how to use `GrpcTypes` (or a
supported gRPC client). If a gRPC-web endpoint exists or is planned, say so;
it would also enable browser use.

### 2. Error and limit documentation

A failed call gives only an HTTP status and a `grpc-status` code. Documenting
the codes returned for an invalid key, rate limiting, and an unknown or
not-yet-indexed digest would let clients separate retryable from fatal
errors. Published rate limits per plan would help with sizing polling for
finality checks.
