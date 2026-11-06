# Self-service Supercuts setup

Supercuts is a private negotiation and settlement layer for agents, boosted by
Walrus Memory. An agent supplies a task and calls protocol tools to discover a
seller, negotiate encrypted terms, settle under the owner's mandate, and reuse
typed preferences and verified outcomes in later decisions. The buyer role
home holds policy, keys, payment state, and Walrus credentials. The agent does
not call Walrus directly. The shielded pool is experimental and runs only on Sui Testnet.

## Buyer: configure once

Install and build the backend, then run `supercuts setup buyer --home
<owner-only-directory>`. The command prompts in the local terminal for the
pinned deployment path, RPC and Walrus endpoints, credential **file paths**,
seller HTTPS origins and Sui addresses, a per-deal ceiling, a lifetime
cumulative budget, a policy duration, and whether public x402 is allowed. It
generates a fresh buyer Sui key unless an owner-only setup JSON supplies
`suiKeyFile`. Do not paste keys or API tokens into Codex.

For noninteractive setup, use `supercuts setup buyer --home <buyer-home>
--config <owner-only-setup.json>`. The JSON keys are `deploymentConfig`,
`tatumKeyFile`, `writeGrpc`, `tatumGrpc`, `walrusPublisher`,
`walrusAggregator`, `memoryConfigFile`, `directoryUrl` (the shared Testnet
seller service origin) or `sellerOrigins` (array), optional
`allowedCounterparties` (approved seller Sui addresses), `perDealCeiling` and
`totalBudget` (MIST strings), `expiresAt` (Unix milliseconds), and optional
`allowPublicX402`, `allowedCapabilityIds`, `allowedCapabilityClasses`,
`suiKeyFile`, and `rapidsnark`. The config file must be mode `0600`; the role
home and all credentials remain owner-only. Seller origins must use HTTPS,
except for loopback development.

Setup prints the generated **buyer** address. For the recorded demo, fund only
the buyer address printed by `supercuts-demo setup`. Check its balance before a
live deal. The role home also contains
`buyer-codex.toml`, which points Codex to the MCP server and a fresh redacted
event stream. If Codex starts before setup, `setup.status` explains the local
setup command. After completing it, call `setup.refresh`; the bootstrap server
reloads the configured buyer tools without restarting the MCP connection.

Use the guided funding commands to budget public payment, shielded payment
plus positive private change, and gas:

```sh
supercuts funding prepare --home <buyer-home> \
  --public-payment <MIST> --shielded-payment <MIST>
supercuts funding execute --home <buyer-home> \
  --public-payment <MIST> --shielded-payment <MIST> \
  --operation-id <stable-id> --request-faucet --confirm
```

Faucet execution requires confirmation, targets only the generated buyer
address, and makes at most one allocation request per invocation. The pool
deposit is separately confirmed and idempotent by operation ID.

Walrus Memory requires 1536-dimensional embeddings. Choose a local model
with an OpenAI-compatible endpoint and set `EMBEDDING_UPSTREAM_BASE_URL` and
`EMBEDDING_UPSTREAM_MODEL` before starting `pnpm --dir circuits embedding:adapter`.
The adapter zero-pads vectors shorter than 1536, passes 1536-dimensional
vectors through, and rejects larger vectors. Point the owner-only Memory
configuration at `http://127.0.0.1:8787/v1`; its model name is a client label,
while `EMBEDDING_UPSTREAM_MODEL` selects the actual model. The existing
`embeddinggemma-1536` label and `embeddinggemma` upstream remain valid.
Use the same model and dimensions for writes and recalls; changing them can
make existing memories incomparable. Keep the adapter and Memory service
running while settling deals. Embedding endpoints receive memory plaintext;
use a trusted local endpoint to keep it local.

`supercuts setup renew --home <buyer-home> --config <owner-only-setup.json>`
updates the standing policy. `totalBudget` is the **lifetime cumulative**
authorization: renewal raises its ceiling rather than forgetting previously
reserved operations. Finish or reconcile an in-flight deal before changing its
policy, because the settlement plan is bound to the original mandate. Use
`supercuts setup session --home <buyer-home>` to generate a fresh Codex run ID
and event file without asking for policy again.

With a shared directory, `supercuts policy approve-seller --home <buyer-home>
--capability-id <id>` verifies the signed listing and its Walrus manifest,
then adds the seller identity to both local buyer policy layers. Run it in an
owner terminal after reviewing the directory listing. A listing by itself
does not authorize payment. The buyer can still use direct `sellerOrigins` for
existing private catalogs.

## Buyer: give Codex a task

Run `supercuts-demo doctor --buyer-home <buyer-home>` before recording. In
Codex, ask for the task in ordinary language. Codex should call `deal.policy`
and `deal.catalog`, choose one signed capability whose input schema fits the
task, construct the structured input, and call `deal.execute` with a stable
operation ID. The deal's maximum comes from the standing ceiling and remaining
budget. If several capabilities fit and seller choice matters, Codex asks the
buyer before paying. Shielded is the default when supported; x402 is available
only when the standing policy permits it and the deal requests it. Read
`deal.get`, `deal.evidence`, and `deal.delivery` to show settlement status,
Walrus evidence IDs, and the verified artifact. Resume an interrupted deal
with the same operation ID; never create a second payment for a retry.

The backend verifies the signed seller manifest against Walrus, exchanges
encrypted negotiation and agreement evidence through Walrus, reserves the
planned payment amount, settles on Testnet, verifies delivery, and indexes a
Walrus Memory outcome. `deal.execute` does not require a fresh human mandate
when the task fits the standing policy. A policy expiry, exhausted budget,
funding shortfall, or review state stops the deal and gives Codex a concrete
next action.

For a capability-specific owner privacy rule, run `supercuts policy add
--home <buyer-home> --capability-id <id>` locally. The command looks up its
signed Walrus registration and writes a scoped owner policy to Walrus Memory.
Codex can then use `memory.recall` and show the citation without seeing owner
credentials. The owner can still use the typed SDK or another agent framework:
`listDealCapabilities()`, `getDealPolicy()`, `executeDeal()`, `getDeal()`,
`resumeDeal()`, `getDealEvidence()`, and `getDealDelivery()` expose the same
protocol path.

## Sellers

A self-hosted seller initializes a **separate** seller role home with
`supercuts onboard seller --home <seller-home>` against the pinned v2 Testnet
deployment. Use `--config <owner-only-setup.json>` for noninteractive setup;
Supercuts generates a fresh seller signer when `suiKeyFile` is omitted and
prints that the seller must not be faucet-funded. It publishes a signed capability with
`supercuts-seller-register`, and starts `supercuts-seller-live` with an
owner-only config naming its registration file and handler module. Its public
`/v2/catalog`, `/v2/prepare`, `/v2/fulfill`, and protected x402 resource
endpoints use the same wire protocol as the hosted seller. The default buyer
access policy is open to valid signed buyers; `allowedBuyers` in the seller
config restricts private offerings.

`supercuts seller scaffold` generates the capability spec, replaceable handler,
future expiry, service config, and exact next commands. Its x402 config refers
to facilitator environment variables rather than storing the secret. Public-only
sellers can use npm's bundled pinned deployment metadata; shielded sellers still
install the proof artifacts required for recovery and exits.

The live seller service exposes `/health` and owns the seller role-home process
lease while running. Stop it before starting the seller MCP worker or another
long-running process that mutates the same home. Protected resource URLs are
created only after negotiation; requesting the unsigned endpoint prefix returns
the structured `NEGOTIATION_REQUIRED` response.

For a research capability, create a cited owner-review draft before packaging:

```sh
export CLAUDE_API_KEY=...
supercuts seller research --kind market-brief \
  --topic "Current Sui ecosystem market structure and risks" \
  --output <owner-only-draft.json>
```

For a matching analysis, use `--kind competitor-analysis --context-file
<approved-brief.json>`. Claude uses web search, the command requires at least
three observed HTTPS sources, and the output remains
`draft-needs-owner-review`. It does not register, publish, or start a service.
Use optional `--allowed-domains domain-a,domain-b` for a strict source policy.
Review every claim and citation before changing the status to `approved`.

The existing hosted seller keeps its `/v1/*` routes and v1 role homes. Create
**separate v2 seller role homes and addresses** for shielded v2 capabilities;
do not migrate old v1 notes or copy a v1 state key into a v2 home. Register
each capability with that v2 seller signer, then run
`supercuts-seller-v2-provision <owner-only-config.json>`. The provisioning JSON
contains `sellers: [{ sellerId, home, capabilities: [{ registrationFile,
artifactFile, outputMetadata, contentType? }] }]`; `home` is required when
adding a new hosted seller and can be omitted when refreshing its v2 snapshot.
Each registration must
point to that service's `/v2/resource/<capability-id>` path and have a current
expiry. Provisioning creates or updates the encrypted Supabase v2 seller snapshot,
then adds catalog rows. **Stop the hosted seller before provisioning and
restart it afterward** so no running instance writes an older snapshot over
the new revision. The packaged hosted handler serves the configured artifact
only after exact payment verification; self-hosted sellers may supply arbitrary
handlers. No seller state or key is copied into a buyer home.

For operator-assisted onboarding, package one hosted capability with:

```sh
supercuts seller package --home <seller-home> --spec <capability.json> \
  --artifact <artifact-file> --metadata <output-metadata.json> \
  --registration <registration.json> --bundle <provisioning.json>
```

This validates output metadata, publishes and signs the capability, and emits
an owner-only provisioning bundle plus the exact host-operator command.

To publish a running self-hosted capability to the shared directory, run
`supercuts-seller-directory publish <owner-only-registration.json>
<directory-origin>`. The directory checks the signature, Walrus manifest,
and that the seller's `/v2/catalog` serves the exact registration. Renew by
publishing a newly signed registration from the same seller identity. The
directory service needs `DIRECTORY_WALRUS_AGGREGATOR` set to the trusted Walrus
aggregator, and its `backend/sql/seller-directory.sql` migration applied before accepting
registrations. This directory is part of the existing hosted seller service;
its records are separate from hosted seller role snapshots.

Run `supercuts onboarding doctor --home <buyer-home>` to check buyer runtime,
policy consistency, and directory health. For a self-hosted seller run
`supercuts onboarding doctor --home <seller-home> --config
<owner-only-seller-live.json>` after starting its HTTPS service. These checks
do not submit a payment. A real transaction still requires the existing live
Testnet prerequisites and buyer funding.

## Recorded Testnet demo

For the full video, use the live v2 pool and Mainnet-backed Walrus services.
Prefund the buyer before negotiation; show a public x402 deal and its artifact;
complete ten encrypted Memory writes or clearly label ten reused completed
live writes with `supercuts-demo reuse-memories --buyer-home <buyer-home>
--events <event-path>`; recall the owner privacy rule; settle a confidential deal; and
queue the confidential seller's standard delayed exit after recovering its
note. The seller must use its own role home. The Codex event stream contains
redacted `deal-lifecycle` evidence, never task plaintext, key material,
signatures, ciphertext, approval tokens, or note openings.

After the seller exit is recorded, run `supercuts-demo check --buyer-home
<buyer-home> --seller-home <confidential-seller-home> --events <event-path>`.
The generic checker requires the
prefunding event, ten distinct live memory IDs, a recalled owner privacy
rule, complete x402 and shielded paid deliveries with indexed outcomes, and
a queued confidential-seller exit. It reconciles the payment digests and exit
against the separate owner journals. A seller MCP process can append to the
same run using `SUPERCUTS_RUN_ID` and `SUPERCUTS_EVENT_PATH`; start it after
the buyer MCP process closes so event sequence numbers remain ordered. Mock
receipts cannot satisfy this check.
