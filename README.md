<img src="docs/assets/supercuts-banner-placeholder.svg" width="100%" alt="Supercuts: private negotiation and settlement for agents, boosted by Walrus Memory" />

[Judges guide](JUDGES.md) · [Architecture](ARCHITECTURE.md) · [Live walkthrough](docs/remote-codex-demo.md)

### Terms used here

- **Public payment** uses x402; the Sui transfer exposes the amount and seller payee.
- **Shielded payment** uses the experimental shielded pool; the deal amount and counterparty are committed in a proof. Pool activity, funding, deposits, withdrawals and gas remain visible.
- **Walkthrough** refers to the recorded or live sequence. Commands and paths containing `demo` retain their existing names.
- **Pool version** identifies compatibility. The current pool is v2; existing v1 notes remain on their original pool.

Payments use Sui Testnet. Testnet SUI has no Mainnet value, and the pool is not a production custody system. Walrus Memory uses Mainnet services.

## Problem

An agent can find work and agree on a price, but the offer exchange and payment can expose a confidential deal. A normal Sui transfer shows the amount and payee. Agents need a private way to negotiate and settle, with evidence of the accepted terms and delivered artifact. They also need to carry owner privacy preferences and lessons from earlier work across sessions without putting keys or private notes in a prompt.

## Solution

**Private negotiation and settlement for agents, boosted by Walrus Memory.** Supercuts is a headless Sui layer for agent deals. Sellers publish signed capabilities; a buyer discovers them, negotiates through an authenticated encrypted transcript, pays within an owner mandate, and verifies delivery.

Public work uses a seller-owned x402 resource and a visible Sui Testnet SUI transfer. Confidential work uses an experimental v2 shielded pool on Sui Testnet: the deal amount and counterparty are committed in a proof rather than published as a direct payment. Walrus stores signed capability registrations and encrypted negotiation transcripts. The CLI, MCP server, and TypeScript SDK share the same role-scoped runtime.

### Agent payments that learn

Every payment starts with a Walrus Memory recall and ends with a verified Walrus Memory write: **recall → decide → pay → verify → remember**. The runtime does this itself, so buyer and seller agents make no memory calls and need no extra setup.

| Payment decision | What decides it |
| --- | --- |
| Which seller to pay | A per-seller scorecard learned from verified outcomes. Recency-weighted, so a seller that failed is demoted even when it is cheaper. |
| x402 or shielded | Owner privacy rules recalled from memory. Shielded is the default. |
| How much the agent may spend | Owner budget rules, minus spend that memory has already verified for the period |
| Pay now or ask the owner | Recent failed or unresolved outcomes for that seller |
| What is remembered | Amount, rail, and latency of each Sui/Tatum-verified payment, plus verified seller faults |

Trusted memories are signed with the owner's memory key, so they keep their authority when recalled on another machine. Memories an agent writes stay advisory. Each deal's evidence includes `memoryInfluence`: what the same mandate would have paid with no memory, next to what Supercuts actually paid. `supercuts memory insights` and the dashboard show the learned scorecards.

### Sui Testnet settlement evidence

The pinned test-only pool has a funded deposit, private transfer, seller note recovery, and standard relayed exit verified by Sui and Tatum. The recorded demo also includes a public x402 payment and a confidential pool payment. Its ten completed live Memory writes were reused and labeled as such; it performed a fresh policy recall.

| Action | Testnet transaction | Record |
| --- | --- | --- |
| Shielded pool deposit | `FNBVYbsX7jxQ2uFkZhcgidfcxiBdntyELdEMUbDffvZH` | [v2 pool evidence](docs/pool-v2.md) |
| Shielded pool transfer | `472A2B2bhTR1eELDoYJbU5QRSZCU5MPUQ3unNJhnGnA4` | [v2 pool evidence](docs/pool-v2.md) |
| Standard relayed exit | `GthWzx5kXsZ8DDkGiWZQJKaraDw3PAhHyXv5F9TJ9oGu` | [v2 pool evidence](docs/pool-v2.md) |
| Recorded public x402 payment | `GrK5gR9SBzGehv63f8xbau58YyiyssZ1pn2AbBT114kE` | [v2 demo record](docs/pool-v2.md) |
| Recorded confidential payment | `3merQzwRfYuQ2y4gr9Qe2VJTFS4TYHJXiwvQbEtbESwW` | [v2 demo record](docs/pool-v2.md) |

---

## Quick start

```sh
printf 'allowBuilds:\n  blake-hash: true\n' > pnpm-workspace.yaml   # pnpm 10+ only
pnpm add @supercuts-walrus/sdk@0.1.9 @supercuts-walrus/backend@0.1.9
pnpm exec supercuts onboard buyer --home ./buyer --config buyer-setup.json
pnpm exec supercuts proofs install   # once per machine, ~370 MB, only for shielded payments
```

Buyer setup needs only owner-only credential files, a budget, and an expiry. Endpoints default to public Testnet, Walrus, and the shared seller directory. Follow the [SDK quick start](backend/packages/sdk/README.md#quick-start-a-new-buyer-on-testnet) for the buyer's first deal and the [onboarding guide](docs/testnet-onboarding.md) for sellers.

## Deployments

| Resource | Value |
| --- | --- |
| Settlement network | Sui Testnet |
| Native asset | `0x2::sui::SUI` |
| Shielded pool package | `0x32d104c1ab422d497df4ae3a6861258694949c86428f886ca338e07bd055cf76` |
| Shielded pool object | `0x8fd22140c906495bb5334a497dcdd9112479c638e21c5df4b4cfb66f633a106b` |
| Pinned deployment | [`config/phase1.testnet.json`](config/phase1.testnet.json) |
| Existing v1 note redemption | [`config/pool-v1.testnet.json`](config/pool-v1.testnet.json) |
| Seal account policy | [`config/seal-policy.testnet.json`](config/seal-policy.testnet.json) |
| Live-service topology | [`render.yaml`](render.yaml) |

The current shielded pool is experimental and runs only on Sui Testnet. Existing v1 notes stay on their v1 pool; no migration happens implicitly. The x402 facilitator validates and relays a buyer-signed transaction. A separate seller-owned protected resource issues the `402` challenge and verifies payment before delivering work. See the [remote demo guide](docs/remote-codex-demo.md) for its live service setup.

### Testnet (Sui)

| Available now | Notes |
| --- | --- |
| Public x402 settlement | Visible Testnet SUI amount and seller payee |
| Confidential pool settlement | v2 deposit, private transfer, local note recovery, delayed standard exit |
| Capability and transcript exchange | Signed, encrypted Walrus-backed records |
| Buyer Memory | Encrypted Mainnet Memory writes and scoped owner-rule recall |
| Auditor disclosure | Seal-encrypted, approved disclosure for one deal |
| Interfaces | CLI, MCP, and typed SDK with role-specific state |

Testnet SUI has no Mainnet value. The pool is experimental and must not be treated as a production custody system. Funding, deposits, withdrawals, gas, payout addresses, timing, and pool activity remain public.

---

## Workspace

| Package / app | Purpose |
| --- | --- |
| [`backend`](backend) | Role stores, CLI, MCP, SDK, seller services, x402 resource, and demo runner |
| [`contracts`](contracts) | Sui Move pool and settlement guards |
| [`circuits`](circuits) | Circom statements, witnesses, proof artifacts, and Memory embedding adapter |
| [`crates`](crates) | Rust protocol encoding and verification helpers |
| [`seal-policy`](seal-policy) | Scoped auditor approval policy |
| [`config`](config) | Pinned Testnet deployments and policy configuration |
| [`docs`](docs) | Setup, protocol, pool, and live-demo guides |

---

## Core Architecture

```text
Buyer agent
  → calls buyer-only CLI, MCP tools, or TypeScript SDK
  → discovers signed seller capabilities on Walrus
  → negotiates and verifies accepted terms
  → recalls an owner privacy rule from encrypted Walrus Memory
  → chooses the mandate-approved x402 or shielded rail
  → checks finalized payment evidence and delivered artifact

Seller
  → publishes a signed capability from a separate role home
  → serves a protected x402 resource or recovers a pool note locally
  → delivers the agreed artifact after verified payment

Auditor
  → receives only a Seal-encrypted disclosure for an approved deal
```

```text
Agent-facing CLI / MCP / @supercuts-walrus/sdk
  ↓
Role-scoped backend runtime · mandate · encrypted SQLite · operation journal
  ├── Walrus capabilities and encrypted transcripts
  ├── Walrus Mainnet Memory and local embedding adapter
  ├── seller-owned x402 resource → Sui Testnet facilitator
  └── local Circom witness + RapidSnark → v2 Sui Move pool
                                          ↓
                                Sui + Tatum finality checks
```

```text
supercuts-walrus/
├── backend/         CLI, MCP, SDK, live runtime, seller services
├── contracts/       Sui Move contracts and tests
├── circuits/        proof circuits and tooling
├── crates/          Rust protocol helpers
├── seal-policy/     auditor disclosure policy
├── config/          pinned Testnet manifests
├── docs/            setup and protocol guides
├── demo/            local voiceover kit, ignored by Git
└── scripts/         phase gates and verification tools
```

The SDK calls the runtime through a one-request subprocess seam, keeping role keys out of the agent application's heap. Buyer, each seller, auditor, and withdrawal relayer have separate owner-only homes. The private negotiation transcript binds what was agreed; the settlement rail proves how it was paid; Memory carries policy and verified outcomes into later decisions. Details are in [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Payment Workflow

1. **Setup** — create isolated role homes and a bounded buyer mandate. Fund only the buyer address generated by `supercuts-demo setup`.
2. **Prefund** — make a standard v2 pool deposit before negotiation and confirm its finality.
3. **Discover** — verify signed public and confidential seller capabilities from Walrus.
4. **Negotiate** — select a capability, exchange signed encrypted offers, and bind accepted terms to the settlement plan.
5. **Pay publicly** — request the seller-owned x402 resource, receive its `402` challenge, sign the exact SUI transfer, and verify the delivered artifact.
6. **Recall policy** — write ten meaningful encrypted memories or label reuse of ten completed live writes; recall the owner rule and select shielded settlement when required.
7. **Pay confidentially** — prove and submit the accepted pool transfer; the seller recovers its note locally and queues a standard delayed exit.
8. **Check** — reconcile the event stream with Sui and Tatum evidence. If approved, disclose one deal to the designated auditor through Seal.

---

## Key Features

- **Role-scoped agent tools** — buyer, seller, and auditor operations are separated across CLI, MCP, and SDK surfaces.
- **Signed capability discovery** — sellers publish verifiable registrations through Walrus.
- **Private negotiation** — authenticated encrypted offers and ordered, signed transcripts bind the accepted agreement.
- **Owner-bound policy** — allowed counterparties, capabilities, amounts, budgets, and rails constrain every deal.
- **Public x402 delivery** — the seller's protected resource issues the challenge and releases work after payment verification.
- **Confidential pool payment** — a local proof commits to terms without a direct public transfer naming the confidential seller and amount.
- **Memory-driven payments** — encrypted Walrus Mainnet Memory chooses the seller, the rail, the spend ceiling, and owner review from verified outcomes and owner rules. Each deal reports what memory changed.
- **Retry-safe operations** — stable operation IDs and signed-transaction journals reconcile uncertain broadcasts.
- **Scoped audit** — approved Seal disclosure targets one deal and one auditor.

---

## Tech Stack

| Layer | Stack |
| --- | --- |
| Agent interface | Node.js CLI, MCP, TypeScript SDK |
| Runtime state | Encrypted SQLite role stores and owner mandates |
| Contracts | Sui Move on Testnet |
| Proofs | Circom, BN254, RapidSnark |
| Public payment | x402 exact SUI transfer and seller-owned resource |
| Data and memory | Walrus and Walrus Mainnet Memory |
| Chain evidence | Sui RPC and Tatum read RPC |
| Disclosure | Seal and a Testnet account policy |

---

## Local Development

**Prerequisites:** Node.js `>=22.13` · pnpm · Rust/Cargo · Sui CLI · Circom toolchain. Live work also needs funded Testnet SUI, Sui and Tatum endpoints, Walrus services, a seller-owned x402 resource, and RapidSnark.

| Command | Description |
| --- | --- |
| `cargo test --workspace` | Runs Rust protocol tests |
| `pnpm --dir circuits install --frozen-lockfile` | Installs circuit tooling |
| `pnpm --dir circuits compile:v2` | Builds v2 circuit artifacts |
| `pnpm --dir circuits test:v2` | Checks v2 witness behavior |
| `sui move test --path contracts` | Runs Move tests |
| `pnpm --dir backend install --frozen-lockfile` | Installs backend dependencies |
| `pnpm --dir backend build` | Builds CLI, MCP, and services |
| `./scripts/phase2-check.sh` | Runs the Phase 2 gate |
| `./scripts/phase3-check.sh` | Runs the Phase 3 gate |

For a reusable buyer setup, follow [`docs/self-service-setup.md`](docs/self-service-setup.md). Development `--mock` profiles label every receipt as non-funded; they are not live settlement evidence.

---

## Environment & Deployment

The live path uses the pinned Sui Testnet v2 pool, a Sui write RPC, a Tatum read RPC, a seller-owned x402 resource, the Testnet facilitator, Walrus publisher and aggregator URLs, owner-only Walrus Memory configuration, circuit artifacts, and RapidSnark. Hosted seller and facilitator services are described in [`render.yaml`](render.yaml) and the [remote demo guide](docs/remote-codex-demo.md).

```sh
pnpm --dir backend build
# Run supercuts-demo setup with the owner-only arguments in docs/remote-codex-demo.md.
sui client faucet --url https://faucet.testnet.sui.io --address 0xYOUR_BUYER_ADDRESS
sui client balance 0xYOUR_BUYER_ADDRESS --coin-type 0x2::sui::SUI
# Run supercuts-demo doctor, record the live path, then supercuts-demo check.
```

Walrus Mainnet Memory requires 1536-dimensional embeddings. The local adapter supports OpenAI-compatible models producing up to 1536 values and zero-pads shorter vectors. Use the same model and dimensions for writes and recalls. The [`buyer setup guide`](docs/self-service-setup.md) explains configuration; [`AGENTS.md`](AGENTS.md) provides the recorded walkthrough's `embeddinggemma` example and safeguards. The recorded event stream stays in owner-only local state and is not committed.

---

## Trust & Security

- **Visible public rail** — x402 transfers show the amount and seller payee on Sui Testnet.
- **Bounded confidential rail** — the pool avoids a direct public payment naming the confidential seller and deal amount; funding, deposits, exits, gas, timing, and pool activity remain visible.
- **Separated roles** — buyer, each seller, auditor, and withdrawal relayer have distinct owner-only homes, databases, state keys, and signers.
- **Local secret handling** — the runtime holds keys and note openings; events and tool output must omit private keys, approval tokens, signatures, ciphertext, and full model prompts.
- **Evidence before delivery** — finality checks and operation journals reconcile payment evidence before an artifact is marked paid.
- **Scoped disclosure** — a designated auditor receives only a Seal-encrypted package for an approved deal.
- **Experimental deployment** — the v2 pool and proof artifacts are Testnet-only and unaudited; no production custody claim is made.

More detail: [`ARCHITECTURE.md`](ARCHITECTURE.md) · [`docs/pool-v2.md`](docs/pool-v2.md) · [`docs/protocol-v1.md`](docs/protocol-v1.md) · [`backend/README.md`](backend/README.md)

---

## Future Plans

The current focus is a verifiable, live Testnet agent workflow that joins private negotiation, settlement, and memory-guided decisions. Before stronger security or privacy claims, the pool needs a reviewed proving ceremony, security review, operated infrastructure, and a broader anonymity set.

- **Review the protocol** — audit the circuits, Move pool, role boundaries, and failure recovery.
- **Operate the services** — harden seller resources, relayers, RPC dependencies, and Walrus publishing.
- **Grow useful markets** — test more seller capabilities and buyer mandates against real delivery workflows.
- **Measure privacy honestly** — report visible metadata and pool activity alongside any shielded settlement claim.
