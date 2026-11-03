# Self-service Supercuts setup

Supercuts is a private negotiation and settlement layer for agents, boosted by
Walrus Memory. An agent supplies a task and calls protocol tools to discover a
seller, negotiate encrypted terms, settle under the owner's mandate, and reuse
typed preferences and verified outcomes in later decisions. The buyer role
home holds policy, keys, payment state, and Walrus credentials. The agent does
not call Walrus directly. The current pool is experimental and Sui Testnet-only.

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
`walrusAggregator`, `memoryConfigFile`, `sellerOrigins` (array),
`allowedCounterparties` (Sui address array), `perDealCeiling` and
`totalBudget` (MIST strings), `expiresAt` (Unix milliseconds), and optional
`allowPublicX402`, `allowedCapabilityIds`, `allowedCapabilityClasses`,
`suiKeyFile`, and `rapidsnark`. The config file must be mode `0600`; the role
home and all credentials remain owner-only. Seller origins must use HTTPS,
except for loopback development.

Setup prints the generated **buyer** address. Fund only that address with
Testnet SUI. Check its balance before a live deal. The role home also contains
`buyer-codex.toml`, which points Codex to the MCP server and a fresh redacted
event stream. If Codex starts before setup, `setup.status` explains the local
setup command; restart the MCP connection after completing it.

Walrus Memory needs the same 1536-dimensional embedding adapter for writes
and recalls. Start `pnpm --dir circuits embedding:adapter`, point the owner-only
Memory config at `http://127.0.0.1:8787/v1`, and use
`embeddinggemma-1536`. Keep the adapter and Memory service running while
settling deals.

`supercuts setup renew --home <buyer-home> --config <owner-only-setup.json>`
updates the standing policy. `totalBudget` is the **lifetime cumulative**
authorization: renewal raises its ceiling rather than forgetting previously
reserved operations. Finish or reconcile an in-flight deal before changing its
policy, because the settlement plan is bound to the original mandate. Use
`supercuts setup session --home <buyer-home>` to generate a fresh Codex run ID
and event file without asking for policy again.

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
`supercuts init` against the pinned v2 Testnet deployment, publishes a signed capability with
`supercuts-seller-register`, and starts `supercuts-seller-live` with an
owner-only config naming its registration file and handler module. Its public
`/v2/catalog`, `/v2/prepare`, `/v2/fulfill`, and protected x402 resource
endpoints use the same wire protocol as the hosted seller. The default buyer
access policy is open to valid signed buyers; `allowedBuyers` in the seller
config restricts private offerings.

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
