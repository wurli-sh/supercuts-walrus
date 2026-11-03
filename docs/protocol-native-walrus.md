# Protocol-native Walrus for Supercuts

Status: implemented with local integration and funded Testnet coverage, 2026-11-03.
This document does not change the pinned Testnet pool, its proof statement,
or existing notes.

## Implementation status

The current branch implements the v2 mandate's explicit x402 opt-in at the
planner and mandate gate; a shielded tie preference for v2; local authority
checks for recalled owner policies and verified memories; signed capability
verification shared by the buyer and seller catalog; a durable deal journal
and strict input validator; metadata-only `listMemories()` synchronization;
and a separate memory worker command. The worker leaves uncertain writes
unresolved instead of resubmitting them.

The composite deal engine and journal now support discovery, planning,
negotiation evidence, payment, delivery, and outcome inventory transitions.
The buyer SDK and seam expose `executeDeal`, `getDeal`, `resumeDeal`,
`getDealEvidence`, and `getDealDelivery`; MCP exposes redacted execute, status,
and resume tools. A generic seller handler runtime validates signed
registrations, task input, payment evidence, output metadata, and encrypted
delivery readback. These components use injected transport and verification
ports. The default live buyer adapter reads owner-only `deal-sellers.json` in
the buyer home; `deal-ports.mjs` remains an optional owner override. Composite
execution refuses mock profiles.

The current `getDealEvidence` returns the journaled result of prior blob
readback and memory inventory checks. It does not re-fetch Walrus blobs on
every read, and its inventory status can become stale after expiry or deletion.
An explicit evidence refresh API remains future work.

The built-in buyer adapter, generic seller HTTP transport, registration CLI,
and seller payment verifier for both rails are implemented. Local integration
tests cover encrypted signed negotiation, Walrus readback, restart reuse, and
simulated Sui/Tatum verification. The local JSONL seller stdio adapter is also
available. Two funded Sui Testnet composite operations completed on
2026-11-03 using isolated v2 demo buyer and confidential seller role homes:

| Rail | Transaction digest | Journal result | Seller result | Outcome memory |
| --- | --- | --- | --- | --- |
| Shielded | `HxyeTY9ThQoAtz4a1FLcgJhj1vtsSGSB3zyz6A9fyoeq` | `complete`, finalized payment, verified Walrus delivery | Handler completed and seller recovered payment note | `Y--c5OuyXdKk72Mb1tJWxxLvDKoNwgGLTmu-7qAICaI`, indexed |
| Public x402 | `CAWTGRYSr5aTzMmToxZbZQmeX4DN2KiZz7ANoZxNsGeM` | `complete`, finalized payment, verified Walrus delivery | Seller-owned x402 resource and handler completed | `BulZxdcg3dnOJhAPQoOYYyP2HtHoQNmQoO0x0S-snks`, indexed |

The shielded run used the pinned experimental v2 pool and a real proof; the
public run used a seller-owned x402 resource and a local Testnet facilitator.
Sui and Tatum finality, Walrus ciphertext readback, and Walrus Memory inventory
were checked by the protocol. The first shielded process kept draining older
memory jobs while a second process completed the same deal; its late state
transition reported a conflict. The journal remained complete, and concurrent
same-state transitions are now idempotent. These operations are live Testnet
evidence, not a `supercuts-demo` event stream, and the pool is not production
custody.

## Goal and boundary

Supercuts is an agent-to-agent settlement protocol. An agent supplies a task,
chooses among signed capabilities, and asks Supercuts to execute a deal. The
Supercuts runtime owns policy, negotiation evidence, payment, delivery evidence,
recovery, and durable memory. Agents do not need Walrus credentials, a Sui key,
proof tools, or a memory tool call to complete a settlement.

Default to the shielded rail. Permit x402 only when an owner policy explicitly
allows a public payment and the seller advertises it. An x402 receipt must say
that amount and payee are public. A shielded receipt may say that the direct
deal amount and seller are absent from the pool transfer, but must not say that
funding, deposit, withdrawal, gas, or pool use is hidden. The deployed v2 pool
remains experimental Testnet software.

## What exists today

- `backend/src/protocol-engine.ts` binds a shielded transfer to a signed
  agreement commitment and transcript root. This is the payment core.
- `backend/src/negotiation.ts` persists encrypted messages before Walrus upload
  and checks retrieved ciphertext. Capabilities can also be published to
  Walrus via `backend/src/phase3.ts`.
- `backend/src/memwal.ts` encrypts and embeds memory client side. Planning in
  `backend/src/phase3.ts` recalls memory; accepted agreements, settlement, and
  delivery enqueue verified outcome memories. Those jobs currently drain via
  `memory.status`. Agents also see `memory.remember` and `memory.recall`.
- `backend/packages/sdk/src/index.ts` exposes many low-level buyer actions.
  `backend/src/remote-buyer.ts` contains a task-specific procurement flow.

The missing abstraction is a *deal lifecycle*. Walrus writes and recalls are
separate operations rather than mandatory, recoverable protocol transitions.
Memory affects planning, but a successful settlement does not itself guarantee
that its encrypted evidence and outcome memory are durable on Walrus.

## Proposed protocol surface

Use one framework-neutral operation for the common path:

```ts
const deal = await buyer.executeDeal({
  operationId: "buyer-generated-id",
  capabilityClass: "sui.market-brief",
  input: { topic: "..." },
  budget: { asset: "0x2::sui::SUI", maximum: "50000000" },
});

// deal: a versioned DealView; poll or resume while state is pending
```

The host creates a buyer profile and owner mandate once. The call performs
discovery, plan, private negotiation, agreement, payment, and delivery through
the protocol. An agent adapter only maps its native tool format to this call.
Expose `getDeal(operationId)`, `resumeDeal(operationId)`, and
`getDealEvidence(dealId)`
alongside it. Advanced clients may still call the lower-level SDK methods.

The seller interface is similarly small: `registerCapability(manifest,
handler)` and `serve()`. The handler receives validated task input and returns
an artifact; the seller runtime handles negotiation, signed agreement, payment
verification, and encrypted delivery. A local subprocess/stdio adapter is the
first target, followed by HTTP and MCP adapters that share the same schema.
The agent framework must not influence authorization semantics.

`execute` is not an unattended spending grant. The host mandate sets allowed
sellers, assets, capability classes, total and per-deal budgets, expiry, and
privacy. The trusted host supplies the existing exact-intent approval provider
or an owner-issued bounded mandate; model-controlled arguments cannot approve
their own payment. Credentials remain in owner-only role homes, with buyer,
seller, and auditor state separated.

## Protocol records and Walrus ownership

Define versioned, canonical records with domain-separated hashes. Publish only
public capability manifests in plaintext. Encrypt the following on the client
before uploading, and bind their ciphertext hashes and Walrus blob IDs into an
append-only local deal journal:

| Record | Producer | Readers | Purpose |
| --- | --- | --- | --- |
| Capability manifest | Seller | Anyone | Discovery and price/rail bounds |
| Offer transcript | Buyer and seller | Participants | Negotiation and accepted terms |
| Agreement envelope | Buyer and seller | Participants | Amount, asset, seller, task digest, expiry, nonce, rail |
| Delivery envelope | Seller | Authorized buyer | Artifact hash and encrypted artifact reference |
| Outcome record | Runtime | Authorized owner | Finality, delivery result, and evidence hashes |
| Disclosure package | Owner | Designated auditor | One approved deal's scoped facts |

Use a `supercuts.deal.v2` envelope containing a random deal ID, operation ID,
network and deployment domain, capability and manifest hash, transcript root,
agreement hash, encrypted record references, expiry, and version. Keep
participant identifiers in the encrypted participant view. The public
projection must omit amount, task text, direct counterparty relationship, and
secret openings on the shielded rail. Blob IDs, timing, sizes, and access
patterns still leak metadata; padding or batching is a later privacy
improvement, not a current guarantee.

Walrus blob storage and Walrus Memory have distinct jobs. Blob storage holds
encrypted, exact deal evidence that can be independently fetched and hash
checked. Walrus Memory holds encrypted, typed, searchable policy and outcome
summaries. A vector recall is *not* an authority source by itself: owner policy
must have an authenticated provenance and exact scope, while agent observations
remain advisory. Verified outcomes must be derived from finalized chain and
delivery evidence. Keep plaintext and embeddings inside the trusted local
runtime; the embedding adapter and 1536-dimensional requirement remain an
implementation detail of the memory driver.

### Showcase the new Walrus Memory inventory API

Walrus Memory's October 21, 2026 TypeScript SDK release added
[`listMemories()`](https://docs.wal.app/docs/release-notes/walrus-memory).
It pages memory *metadata* without a similarity query, blob download, or
decryption. Supercuts should use this as a protocol recovery and audit feature:
after restart, compare the owner-scoped inventory against the local durable
outbox, mark matching outcome blob IDs as present, find missing records for
reconciliation, and flag records nearing expiry for renewal before they lapse.
An expired record is unavailable and must not be reported as durable.
`getEvidence(dealId)` can show the inventory status of outcome memory and the
separate readback status of exact evidence blobs. The inventory response does
not contain a ciphertext hash. Semantic `recallManual` remains useful for planning, but is not a reliable way to prove
that one specific write landed. The [SDK API reference](https://docs.wal.app/walrus-memory/sdk/api-reference)
documents `listMemories()` and its cursor behavior.

The current `MemWalManual` client does not expose `listMemories()`. Keep it for
local embedding, Seal encryption, and plaintext-safe recall; create a separate
metadata-only `MemWal` client with the *same role's* account and delegate
credentials for inventory reads. The repository already pins SDK `0.1.11`,
which has the method. Do not put either credential in agent tools.
Use an opaque namespace per role and deployment. Page until `has_more` is
false even when a namespace-filtered page is empty; persist `next_cursor`,
process deletion tombstones, and restart the inventory walk if `must_resync`
is true. Inventory is a relayer index. For exact evidence blobs, fetch the
encrypted bytes through the Walrus aggregator and compare them with the
locally journaled ciphertext hash. An inventory result cannot reconstruct
secret deal state or prove payment finality on its own.

The demo should show one deal settling, a runtime restart, an inventory sync
that finds the encrypted outcome by blob ID, and a successful evidence check.
Then show a second agent framework reading the same Supercuts status through
its adapter. That demonstrates a recent sponsor feature serving a protocol
guarantee, while keeping memory out of agent prompts and model-managed tools.

The current proof accepts an agreement containing `transcriptRootLo/Hi` and
`serviceDigestLo/Hi`. The deployed remote analysis path already defines how
those fields are calculated. Keep that calculation unchanged for existing
sessions. A new generic agreement format may define a new, signed transcript
root over verified Walrus ciphertext references, but both parties must enforce
the same versioned derivation before signing. Do not claim that the current
Move verifier checks Walrus availability or that it commits to a new
`planHash` field. An explicit on-chain plan or evidence root requires a
separately versioned proof statement, circuit, and pool deployment. Never
reinterpret old agreements or v1 notes.

## Deal state machine

```text
created -> discovered -> planned -> negotiating -> agreed
       -> evidence_ready -> payment_pending -> paid
       -> delivery_pending -> delivered -> outcome_pending -> complete

planned -> awaiting_approval | review_required
planned or agreed -> funding_required -> resume saved step
any recoverable state -> unresolved
```

Every transition has an idempotency key, canonical input hash, and durable
journal entry. `evidence_ready` requires confirmed Walrus readback of the
encrypted signed agreement before payment. `paid` requires finalized Sui and
Tatum evidence, not merely a broadcast digest. `complete` requires encrypted
delivery evidence and a durable outcome write. A Walrus outage before
`evidence_ready` pauses payment; an outage after payment leaves the deal in
`outcome_pending` and `resume` retries the same write. Unknown broadcast
outcomes must reconcile the original signed transaction, never create a
different payment under the same operation ID. A receipt exposes the current
state honestly, including `outcome_pending`.

Memory recall happens within `planned`: load owner policy by exact authenticated
scope first; use relevant outcomes as bounded ranking inputs; deny or request
owner review on contradictory policy. Default to shielded when both rails are
possible. Public x402 selection needs positive owner permission and a recorded
reason. No agent-supplied text can relax a privacy rule.

Provenance is established by the runtime, not by the `provenance` string inside
recalled JSON. Treat a recalled `owner_policy` as authoritative only when its
canonical hash matches an owner-approved policy record in the buyer's local
encrypted store and its scope is exact. Treat a `verified_outcome` as trusted
only when its `evidenceHash` matches finalized payment or delivery evidence in
that role's journal. Everything else, including a well-formed record that
claims either trusted provenance, is advisory. If the local authority registry
is lost, do not infer it from semantic recall. The first release must fail
closed and require the owner to restore the role home from a trusted backup;
designing a separate authenticated Walrus-based policy restore is later work.

## Implementation contract

Everything in this section is **proposed**, not an existing backend API. An
implementation must use these names and semantics consistently across the
backend, SDK, stdio seam, HTTP adapter, MCP adapter, tests, and docs. If a
listed dependency cannot provide a required behavior, stop that transition
with a named error. Do not simulate success or route a live call through mock
code.

### Versioning and compatibility

- `supercuts.deal.v2` is an application record version. It is **not** a new Sui
  pool or proof version. A v2 deal may settle against the currently pinned
  experimental v2 Testnet pool.
- Keep `supercuts.capability.v1`, `supercuts.settlement-plan.v1`, and existing
  CLI/SDK commands valid for their present callers. Add the new deal API beside
  them. Existing `supercuts.mandate.v1` homes must keep their current behavior.
- Introduce `supercuts.mandate.v2` for the new deal API. Add
  `allowPublicX402: boolean`, defaulting to `false`. `requiredPrivacy` and
  scoped owner privacy rules can only tighten this permission. Merely setting
  `requiredPrivacy: "any"` or listing `x402` in `allowedRails` does not opt in
  to a public payment. The new orchestrator requires a v2 mandate; do not
  reinterpret a v1 mandate as opt-in.
- Reject unknown record versions and unknown schema fields. Use a new record
  version for any incompatible serialization change. Never migrate or redeem a
  v1 note through the v2 pool implicitly.

### Buyer API

Add these methods to `BuyerClient` in `backend/packages/sdk/src/index.ts` and
matching backend commands in `backend/src/phase3.ts`. The shape below is the
contract; field names are case-sensitive. JSON amounts are canonical decimal
strings because `bigint` cannot cross the subprocess JSON seam.

```ts
type DealState =
  | "created" | "funding_required" | "discovered" | "planned" | "awaiting_approval"
  | "negotiating" | "agreed" | "evidence_ready"
  | "payment_pending" | "paid" | "delivery_pending" | "delivered"
  | "outcome_pending" | "complete" | "review_required"
  | "failed" | "unresolved";

interface ExecuteDealInput {
  operationId: string;          // caller-stable, 1..256 characters
  capabilityId?: string;        // exact advertised capability
  capabilityClass?: string;     // choose from configured catalogs
  input: Record<string, unknown>;
  budget: { asset: string; maximum: string }; // positive base-unit integer
  privacyHint?: "any" | "shielded"; // can only tighten owner policy
  requestedRail?: "shielded" | "x402"; // x402 still needs owner opt-in
}

interface DealView {
  version: "supercuts.deal.v2";
  dealId: string;
  operationId: string;
  state: DealState;
  rail?: "shielded" | "x402";
  visibility?: "shielded-direct-payment" | "public-x402";
  planHash?: string;
  paymentDigest?: string;
  deliveryHash?: string;
  evidence: {
    agreement: "pending" | "verified";
    payment: "pending" | "finalized";
    delivery: "pending" | "verified";
    outcomeMemory: "pending" | "indexed" | "unresolved";
  };
  nextAction?: "resume" | "fund_buyer" | "owner_approval" | "owner_review";
}

interface DealEvidenceView {
  version: "supercuts.deal-evidence.v1";
  dealId: string;
  transcriptBlobIds: string[];
  agreementBlobId?: string;
  deliveryBlobId?: string;
  outcomeMemoryBlobId?: string;
  ciphertextReadback: "pending" | "verified" | "unresolved";
  inventory: "pending" | "indexed" | "missing" | "unresolved";
  paymentFinalized: boolean;
  paymentDigest?: string;
}

interface DealDelivery {
  dealId: string;
  contentType: string;
  artifactSha256: string;
  artifact: Uint8Array; // participant-only; never returned by public status
}

executeDeal(input: ExecuteDealInput): Promise<DealView>;
getDeal(operationId: string): Promise<DealView>;
resumeDeal(operationId: string): Promise<DealView>;
getDealEvidence(dealId: string): Promise<DealEvidenceView>;
getDealDelivery(dealId: string): Promise<DealDelivery>;
```

Require exactly one of `capabilityId` and `capabilityClass`. `executeDeal` may
return a pending state; it must never report `complete` until all completion
guards below hold. A second `executeDeal` with the same operation ID and exact
canonical input returns the existing deal view. Reusing that ID with different
input returns `DEAL_OPERATION_CONFLICT` before any network call. `resumeDeal`
continues the stored deal; it accepts no replacement task, seller, amount, or
rail. Read methods never trigger a payment. Expose only the `DealView` to agent
tools; any richer operator evidence view must redact secrets and separate
participant-only fields. `getDealDelivery` is buyer-only and returns authenticated
plaintext after payment and delivery verification. For the first subprocess
SDK release, cap artifact bytes at 512 KiB so base64 plus the response stays
under the existing 2 MiB seam output limit. Return
`DEAL_ARTIFACT_TOO_LARGE` before seller publication if a handler exceeds that
cap. A later streaming transport may raise it.

Capabilities are discovered from owner-configured catalogs or explicit Walrus
manifest blob IDs in the buyer profile. There is no implied global registry.
Validate the manifest hash, expiry, seller signature and transport key, URL,
asset, schema, and owner allowlists before calling a seller. Bind the network
from the buyer's pinned deployment profile; `CapabilityManifest` has no
network field today. The current `CapabilityManifest` hash check in
`backend/src/capability.ts` does not
itself verify a seller signature; the remote catalog path in
`backend/src/remote-buyer.ts` performs that extra check. Make signature
verification a shared protocol function before the generic API ships. The
current remote catalog signs the byte string
`manifestHash:transportPublicKey` with a Sui personal-message signature.
Retain that wire format for `supercuts.capability.v1`; verify it against
`manifest.sellerId` and compare the signed manifest hash with the blob fetched
from Walrus. If a new manifest format is needed, version it explicitly.
Validate `input` against the manifest's `inputSchema` and seller `metadata`
against `outputSchema` with a pinned JSON Schema validator. Do not substitute
the current check that those schema fields are merely objects.

### Seller API

Add a seller runtime that accepts a validated `CapabilityManifest` plus a
service handler. Define one framework-neutral request and result contract:

```ts
interface ServiceRequest {
  dealId: string;
  capabilityId: string;
  input: Record<string, unknown>;
  requestId: string;
}
interface ServiceResult {
  artifact: Uint8Array;
  contentType: string;
  metadata: Record<string, unknown>; // validate against manifest.outputSchema
}
type ServiceHandler = (request: ServiceRequest) => Promise<ServiceResult>;

interface SignedCapabilityRegistration {
  manifest: CapabilityManifest;
  manifestBlobId: string;
  transportPublicKey: string;
  sellerSignature: string; // Sui personal-message signature
}
interface SellerRuntime {
  registerCapability(
    registration: SignedCapabilityRegistration,
    handler: ServiceHandler,
  ): Promise<void>;
  serve(): Promise<void>;
}
```

`registerCapability` fetches the manifest blob, validates its bytes and hash,
checks the seller signature described above, and persists the registration in
the seller home. The seller publishes the manifest through the existing
`capability.publish` path before registration. `serve` exposes the existing seller-owned negotiation and
protected-resource behavior for registered capabilities. It must not turn the
x402 facilitator into the seller resource. The handler is a trusted local
callback, outside model-controlled arguments.

The handler runs only after the seller runtime validates the accepted
agreement and required payment evidence for the selected rail. Validation
must use finalized pool events or the seller-owned x402 resource's exact paid
request binding; a buyer-supplied transaction digest alone is insufficient.
For shielded payments, preserve seller note recovery material in its seller
home before signing, and recover the note locally after finality. The handler
never receives buyer wallet material, note openings, approval tokens, or
Walrus Memory credentials. Its output is encrypted for the buyer before
Walrus publication. No service handler is called twice for the same
`requestId` unless it is explicitly declared idempotent; otherwise replay the
previously journaled artifact.

### Rail selection and approval

`backend/src/settlement.ts` currently sorts x402 ahead of shielded when other
candidate scores tie. Change the new deal planner so that it first filters by
owner mandate and trusted policy, then selects shielded whenever the chosen
capability supports both rails and `requestedRail` is omitted. Choose x402
only when all of these are true:

1. The v2 mandate has `allowPublicX402: true`.
2. The owner `allowedRails` contains x402.
3. No applicable owner rule or `privacyHint` requires shielded settlement.
4. The caller requested x402, or x402 is the only rail the capability offers.
5. The signed seller capability supports x402 and the exact protected resource
   returns an authentic 402 challenge bound to the request.

If the capability offers shielded and x402, do not pick x402 merely because it
is cheaper, listed first, or has a better memory score. If shielded is
required but unsupported, return `DEAL_PRIVACY_UNAVAILABLE`. If x402 is the
only offered rail without explicit owner opt-in, return
`DEAL_PUBLIC_RAIL_FORBIDDEN`. Record the rule and reason code in the plan and
receipt. Continue to apply exact-intent approval through trusted host code;
the model cannot submit approval tokens. New composite calls must reserve the
mandate budget once per payment operation, not once per orchestration step.

### Persistent identifiers and schema

Store `dealId` as a random, opaque identifier created once on the buyer side.
Store one `operationId` for the composite deal, and derive distinct, stable
child IDs for planning, agreement, payment, delivery, and outcome memory.
Document the derivation in code and tests; a retry must produce the same IDs.
Do not use one child ID for two `mandate_operations` mutations, because that
table binds an operation ID to one exact intent. Use `canonicalJson` in
`backend/src/settlement.ts` plus explicit domain tags for record hashes. Do
not hash a JavaScript object's insertion order or serialize `bigint` directly.
For the current planner, use the *payment* child ID as the
`settlement.plan` operation ID because `bindSettlementPlan` requires the plan
and payment operation IDs to match. `executeMandated` already prefixes plan
reservations with `settlement.plan:`; preserve that distinct journal identity.

### Operator setup and service dependencies

The plug-and-play surface still needs a one-time owner setup. Add an owner-only
buyer configuration containing the pinned deployment file path, Sui write RPC,
Tatum read RPC credential reference, seller catalog sources, Walrus publisher
and aggregator URLs, circuit artifact paths, RapidSnark path, mandate path,
and Walrus Memory configuration path. A seller setup contains its own signer,
role home, signed capability, handler entry point, Walrus URLs, and resource
server configuration. The auditor has a separate home and only its scoped
disclosure settings. Store secret values in owner-only files or encrypted role
state; catalog URLs and manifest blob IDs can be public.

At setup, generate distinct role state directories and identities. For the
live demo, `supercuts-demo setup` remains the source of the buyer address to
fund. Fund only that buyer on Sui Testnet, confirm its native SUI balance, and
prefund it with a standard v2 pool deposit before negotiation. The current v2
pool accepts standard deposits of 10,000,000 or 100,000,000 MIST; the chosen
note must exceed the eventual confidential payment to leave positive change.
The new deal API returns `funding_required` when the available note is too
small for the current opening or accepted amount; it must not call a faucet or
make an unapproved deposit on its own. If funding is needed after agreement,
`resumeDeal` keeps the accepted revision and only retries the saved payment
after checking the agreement has not expired.

Walrus Memory currently uses Mainnet settings in `backend/src/memwal.ts` even
when the payment pool is on Sui Testnet. Keep those network credentials and
accounts distinct. The memory config requires the local embedding endpoint
and 1536-dimensional model described in `AGENTS.md`; never send memory
plaintext to the relayer. `doctor` checks configuration, pinned artifact
hashes, role permissions, signed inventory read compatibility, and reachability
without submitting a payment or memory write. A failed dependency returns a
named readiness error before `executeDeal` is allowed to spend.

Add tables through the `RoleStore` migration path in `backend/src/store.ts`:

```sql
CREATE TABLE deal_operations (
  operation_id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL UNIQUE,
  input_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  rail TEXT,
  plan_hash TEXT,
  payment_operation_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE deal_steps (
  operation_id TEXT NOT NULL,
  step TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  result_hash TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, step),
  FOREIGN KEY (operation_id) REFERENCES deal_operations(operation_id)
);
CREATE TABLE deal_blobs (
  operation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ciphertext_hash TEXT NOT NULL,
  blob_id TEXT,
  status TEXT NOT NULL,
  PRIMARY KEY (operation_id, kind),
  FOREIGN KEY (operation_id) REFERENCES deal_operations(operation_id)
);
CREATE TABLE deal_memory_outbox (
  operation_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  blob_id TEXT,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, event_kind),
  FOREIGN KEY (operation_id) REFERENCES deal_operations(operation_id)
);
```

This is the minimum relational shape, not a request to put secrets in SQL
columns. Store encrypted payloads through `RoleStore.putSecretOnce`, keyed by
deal and record kind. Existing `operations`, `live_signed_transactions`,
`settlement_plans`, `settlement_execution_bindings`, `memory_jobs`, and note
tables remain the source for their respective low-level facts. Transactions
that advance a state and bind its result must be atomic. Maintain directory
mode `0700` and credential-file mode `0600`, with distinct role homes, SQLite
databases, state keys, Sui signers, and memory accounts.

### Exact transition guards

| Enter state | Required evidence | Safe action on restart |
| --- | --- | --- |
| `funding_required` | Shielded plan has no unspent v2 note above the current opening or accepted amount | Return funding instructions; no payment or new negotiation revision |
| `discovered` | Valid signed manifest fetched from configured source | Fetch and verify the same manifest hash |
| `planned` | Mandate-bound plan and rail decision | Reuse the saved plan; fail if it expired before agreement |
| `awaiting_approval` or `review_required` | Exact intent or owner review pending | Return the pending state without spending |
| `agreed` | Both required signatures, exact amount, seller note recovery data, accepted revision | Reload signed bytes; never renegotiate under the same ID |
| `evidence_ready` | Encrypted agreement and transcript uploaded, fetched, and hash checked | Recheck saved blob IDs and ciphertext hashes |
| `payment_pending` | Signed transaction or x402 request bound to the plan and journaled | Reconcile the exact transaction or request |
| `paid` | Successful checkpoint and matching Tatum evidence; pool or x402 bindings verified | Read finality again; do not sign a replacement payment |
| `delivered` | Encrypted artifact fetched, authenticated, and matched to the promised hash | Replay saved delivery, never regenerate it silently |
| `outcome_pending` | Payment and delivery facts finalized; memory payload saved in the outbox | Reconcile or submit the same memory payload |
| `complete` | Outcome memory blob ID recorded and present in inventory | Return the same receipt and evidence references |

`failed` is for a definitive terminal error before payment or for an
irrecoverable, explicitly classified post-payment failure. `unresolved` means
the outcome of a network write or broadcast is unknown. Both retain the
journal and expose a recovery instruction. Do not move backward from `paid` or
erase a finalized payment because delivery or memory failed. If a plan expires
after payment, its expiry does not invalidate that payment; reconciliation
still proceeds.

### Walrus storage and inventory algorithm

For exact deal evidence, journal the ciphertext bytes and SHA-256 before
upload. Upload through a `BlobTransport`, save the returned blob ID, then GET
the blob through the configured aggregator and compare bytes or hash. A timeout
between upload and saving the blob ID is `unresolved` until the transport can
resolve the original upload ID. The existing
`DurableTranscriptTransport.upload` in `backend/src/negotiation.ts` is the
reference pattern. Avoid changing the ciphertext or encryption nonce on a
retry of the same record.

For outcome memory, continue to use `MemWalManual.rememberManual` so embedding
and Seal encryption stay local. Save the canonical plaintext in encrypted
role state before submission; save its hash and the returned `blob_id` after
success. `rememberManual` has no documented composite operation ID or durable
idempotency key in the current installed API. If a call times out before
returning `blob_id`, `listMemories()` cannot identify that payload from
metadata alone. Mark the outbox item `unresolved`; do not blindly repeat a
potentially paid write. Add a reconciliation method or a documented
idempotent write path before claiming automatic recovery for that case.

Inventory polling uses `MemWal.listMemories({ cursor, namespace })` from the
same role's account and delegate. Do not swap in the relayer-managed
`remember()` method: it would move plaintext and embedding to the relayer.
Persist an inventory cursor only after the page and matching local updates
commit. Continue while `has_more` is true, including empty filtered pages.
Apply `deleted` tombstones. If `must_resync` is true, discard the cursor and
walk from the beginning. A missing inventory row is a reconciliation signal,
not proof that a blob never existed. A present row proves metadata is indexed;
it does not verify its plaintext, ciphertext, provenance, or chain finality.
Keep owner policy as an exact owner-approved record in local state and an
encrypted Walrus backup; do not authorize a payment from a semantic hit alone.

Run the outbox in a dedicated backend worker process and from explicit
`resumeDeal`. The one-request `supercuts-seam` subprocess exits after a call,
so a timer inside it is not a durable background worker. Worker startup scans
pending and unresolved jobs and respects rate limits and retry delays. A
normal agent interaction does not need to call `memory.status` to flush work.
Use Walrus blob expiry metadata to alert before expiry; renewal needs its own
owner-authorized storage operation. Never label expired evidence durable.

### Privacy and output rules

Return the following only through authorized participant/operator APIs, never
through public events or seller capability manifests: exact shielded amount,
task input, counterparty link, decrypted transcript, delivered artifact bytes,
and owner policy text. Never print or record a private key, seed phrase, note
opening, approval token, signature, ciphertext, or full model prompt. A hash
and blob ID can still reveal correlation; public deal views should use opaque
IDs and disclose only what is required for status. The auditor sees one
owner-approved Seal disclosure, not general memory access.

The protocol may claim that its shielded *transfer* lacks a direct public
amount and payee. It must disclose visible funding, deposits, withdrawals,
gas, and pool activity. The x402 rail is a normal public Testnet SUI transfer
to the seller-owned protected resource's payee. The facilitator validates and
relays the buyer-signed payment; it is not the seller resource.

## Migration path

1. **Freeze the contract.** Publish a `supercuts.deal.v2` schema, state
   transition rules, error codes, privacy labels, and cross-language test
   vectors. Keep `supercuts.capability.v1`, existing SDK methods, and pinned
   pool deployments readable.
2. **Move Walrus into the runtime.** Add a `DealEvidenceStore` backed by
   `DurableTranscriptTransport` and a `DealMemoryStore` backed by `ManualMemory`.
   Add a durable outbox worker that drains automatically, reconciles uncertain
   uploads, uses `listMemories()` for metadata reconciliation, verifies readback,
   and reports pending states. Move the current
   `memory.status` drain behavior behind this worker; leave diagnostic memory
   commands available for operators.
3. **Add the orchestration API.** Implement `execute/status/resume/getEvidence`
   in the backend and thin methods in `@supercuts/sdk`. Bind the existing
   mandate, settlement plan, agreement, x402 challenge or shielded proof,
   delivery, and outcome to one operation ID. The procurement demo becomes a
   client of this API rather than the owner of the settlement sequence.
4. **Make seller onboarding portable.** Package a seller runtime with a
   capability schema and handler interface. Add stdio, HTTP, and MCP adapters
   generated from the same protocol definitions. Provide `init buyer`, `init
   seller`, and `doctor` flows with owner-only configuration and no hard-coded
   demo identities.
5. **Prove the boundary.** Run a live Testnet integration with two unrelated
   agent frameworks and an independent seller implementation. Verify restart
   after each state, Walrus readback, failed upload recovery, duplicate payment
   prevention, shielded default, explicit x402 opt-in, seller note recovery,
   and scoped auditor disclosure. Mock tests cannot establish funded settlement.

The first useful release can use the current v2 pool and agreement proof with
an application-level Walrus evidence commitment. A future pool version is only
needed if the on-chain verifier must itself validate new fields. Existing v1
notes continue through their existing redemption path.

## Implementation order and code map

Implement one slice at a time. Every slice must compile and pass its relevant
tests before the next slice changes behavior. The paths below are current
repository paths; new modules named here are proposed.

| Slice | Existing code to reuse or edit | New work | Completion check |
| --- | --- | --- | --- |
| 1. Contract | `backend/src/capability.ts`, `backend/src/settlement.ts`, `backend/src/mandate.ts` | Add shared deal types, strict validators, v2 mandate loader, signed capability verification | Cross-process JSON roundtrip and rejection of unknown fields |
| 2. Journal | `backend/src/store.ts`, `backend/src/live-runtime.ts` | Add deal tables, encrypted payload keys, child operation IDs, atomic state transitions | Crash and reopen after every transition without duplicate side effects |
| 3. Walrus evidence | `backend/src/negotiation.ts`, `backend/src/transcript.ts`, `backend/src/seller-service.ts` | Reuse ciphertext upload/readback, persist agreement and delivery references, bind a versioned transcript derivation | Changed blob bytes or ID fail before payment |
| 4. Walrus Memory | `backend/src/memwal.ts`, `backend/src/phase3.ts` | Add metadata-only `MemWal` inventory client, outbox worker, cursor and tombstone sync, safe unresolved handling | Restart shows indexed outcome without semantic recall |
| 5. Deal engine | `backend/src/phase3.ts`, `backend/src/settlement.ts`, `backend/src/live-runtime.ts` | Implement composite orchestration with default shielded selection and existing rail runtimes | One input creates at most one finalized payment |
| 6. Adapters | `backend/src/seam.ts`, `backend/packages/sdk/src/index.ts`, `backend/src/mcp.ts` | Expose the same types and authorization rules over SDK, stdio, and MCP; add HTTP only after the local contract is stable | Different adapters return the same redacted `DealView` |
| 7. Demo | `backend/src/demo.ts`, `backend/src/remote-buyer.ts` | Make procurement call the deal API; show restart and `listMemories()` reconciliation | Live event stream passes `supercuts-demo check` |

Do not build a second wallet, pool verifier, x402 facilitator, transcript
validator, or memory encryption path inside the new orchestrator. It calls
the existing components. `backend/src/remote-buyer.ts` is an example of a
seller-specific workflow, not the generic protocol interface. Keep its
current behavior until equivalent generic paths are verified.

## Required tests and gates

Add focused tests to the backend and SDK packages. The following cases are
release requirements; names are descriptive, not mandatory filenames.

| Case | Expected result |
| --- | --- |
| Same `operationId` and input after restart | Same deal ID, plan/payment child IDs, and receipt; no new spend |
| Same `operationId`, changed input or budget | `DEAL_OPERATION_CONFLICT` before seller or chain I/O |
| Buyer v1 mandate used with new API | Explicit version error; old CLI/SDK path still works |
| Both rails offered, no `requestedRail` | Shielded selected |
| x402 requested without v2 owner opt-in | `DEAL_PUBLIC_RAIL_FORBIDDEN` before challenge or signing |
| x402 requested with opt-in and no stricter privacy rule | Seller-owned 402 challenge checked; public visibility label |
| Trusted privacy rule requires shielded; seller offers only x402 | `DEAL_PRIVACY_UNAVAILABLE` |
| Agent observation asks to weaken privacy | No policy change |
| Seller manifest hash or personal signature changed | Discovery fails before negotiation |
| Agreement ciphertext changed at Walrus aggregator | No payment; `WALRUS_BLOB_MISMATCH` or equivalent named error |
| Broadcast times out after signing | Saved exact transaction reconciled; no replacement signed |
| Sui finality present but Tatum unavailable | Pending or unresolved; never `paid` |
| Memory write times out before blob ID | Outbox `unresolved`; no blind second paid write |
| Inventory returns empty filtered page with `has_more: true` | Continue pagination |
| Inventory reports deletion or `must_resync` | Apply tombstone or restart full walk |
| Memory inventory row exists but evidence blob hash differs | Evidence remains unverified |
| Delivery fails after finalized payment | Payment remains final; deal reports delivery pending/failed honestly |
| Buyer asks for seller or auditor secret | Role check denies it; no secret in error text |
| Mock profile executes a deal | Receipt explicitly labels non-funded evidence; live command refuses mock profile |

Run `pnpm --dir backend check`, `pnpm --dir backend test`, and
`pnpm --dir backend build` for code changes. Run the SDK gate
`./scripts/sdk-check.sh` when the seam or SDK changes. A live claim requires
the repository's live prerequisites, a funded buyer generated by demo setup,
`supercuts-demo doctor`, and `supercuts-demo check` on the event stream. Fund
only that generated buyer address. Never treat deterministic mock receipts as
settlement evidence.

## Claims the implementation must not make

- `listMemories()` proves an entry appears in the relayer inventory. It does
  not prove payload identity, decryption, Walrus availability, or Sui finality.
- A Walrus blob ID or ciphertext hash does not prove that the seller delivered
  the promised work. Delivery is a separate authenticated observation.
- The current pool proof binds fields of the signed agreement. It does not
  query Walrus, enforce storage retention, or validate an application plan.
- Walrus Memory's manual client keeps memory plaintext and embedding local,
  but vectors, blob IDs, timestamps, sizes, and other metadata are visible to
  the relayer or storage infrastructure.
- A generic agent adapter does not make the experimental Testnet pool a
  production custody system.
