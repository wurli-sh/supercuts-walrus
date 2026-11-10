---
title: "Supercuts: agent payments that learn, with Walrus Memory and Tatum on Sui"
published: true
description: "Private negotiation and settlement for AI agents. Every payment starts with a Walrus Memory recall and ends with a verified memory write, checked against Sui through Tatum."
tags: sui, ai, web3, blockchain
cover_image: https://raw.githubusercontent.com/wurli-sh/supercuts-walrus/main/docs/assets/banner.png
---

AI agents are getting good at finding work and agreeing on a price. Paying for that work is where things get awkward.

A normal Sui transfer shows the amount and the payee to anyone who looks. That is fine for a public market brief. It is not fine when your agent is buying a confidential competitor analysis and you would rather not announce who you hired and what you paid. On top of that, every new agent session starts from zero: it forgets that you asked for private deals, forgets which seller failed last week, and forgets how much of this month's budget it has already spent.

**Supercuts** is my answer for the Total Recall hackathon: a private negotiation and settlement layer for agents, boosted by Walrus Memory. It is a CLI, MCP server and TypeScript SDK that let a buyer agent:

1. discover signed seller capabilities on Walrus,
2. negotiate through an encrypted, signed transcript,
3. pay on the rail the owner approves (public **x402** or an experimental **shielded pool** on Sui Testnet),
4. verify the payment through Sui and **Tatum**, and verify the delivered artifact,
5. and **remember** what happened in **Walrus Memory on Mainnet**, so the next deal is a better one.

- **Repo:** https://github.com/wurli-sh/supercuts-walrus
- **npm:** `@supercuts-walrus/sdk` and `@supercuts-walrus/backend`
- **Demo video:** https://youtu.be/c4zur-LeqPE

---

## The loop: recall → decide → pay → verify → remember

The core idea is simple. Memory is not a chat log bolted onto the side. It sits in the middle of every payment decision.

```text
          ┌────────────── Walrus Memory (Mainnet) ──────────────┐
          │  owner rules · budgets · verified deal outcomes     │
          └──────▲──────────────────────────────────────┬───────┘
                 │ remember (signed, encrypted)          │ recall
                 │                                       ▼
   verify ◄── pay (x402 or shielded) ◄── decide (seller, rail, budget, review)
     │
     └── Sui finality + Tatum gRPC read + delivered-artifact check
```

The runtime does this itself. The buyer agent (Codex or Claude in my demo) never has to call a memory tool. It just asks for a deal through `deal.execute`, and Supercuts recalls, decides, pays, verifies and writes the outcome back.

Here is what memory actually decides:

| Payment decision | What decides it |
| --- | --- |
| Which seller to pay | A per-seller scorecard learned from verified outcomes. Recency-weighted, so a seller that failed is demoted even when it is cheaper. |
| x402 or shielded | Owner privacy rules recalled from memory. Shielded is the default. |
| How much the agent may spend | Owner budget rules, minus spend memory has already verified for the period. |
| Pay now or ask the owner | Recent failed or unresolved outcomes for that seller. |
| What gets remembered | Amount, rail and latency of each Sui/Tatum-verified payment, plus verified seller faults. |

---

## How I use Walrus

Supercuts uses Walrus in two different ways.

### 1. Walrus Memory (Mainnet) as the decision layer

Every memory is a typed record, not free text: `privacy_rule`, `budget_limit` or `outcome`, with a scope (capability ID, capability class, seller) and a provenance (`owner_policy`, `verified_outcome`, or advisory agent notes).

A few design choices mattered a lot:

- **Encrypted before it leaves the machine.** Memory plaintext is embedded and encrypted locally. The Walrus Memory relayer only sees ciphertext.
- **Signed, so authority travels.** Trusted memories are wrapped in an Ed25519 envelope signed with the owner's memory key. When the same buyer recalls them on another machine, Supercuts checks the signature before treating a memory as an owner rule. Anything an agent wrote itself stays advisory: a model cannot relax the owner's privacy rule by "remembering" something convenient.
- **Each buyer gets its own namespace.** Onboarding a fresh buyer creates a fresh Memory namespace, so one buyer's lessons never leak into another's.
- **Ten live Mainnet memories in the recording.** The 2026-11-02 recorded run used ten completed live encrypted Memory writes (labelled as reused in the event stream) plus a fresh recall of the owner policy. Every `deal.execute` deal since then writes its own verified outcome memory.

### 2. Walrus blobs for the deal trail

Sellers publish **signed capability registrations** to Walrus. Buyer and seller exchange **encrypted, signed offers**, and the ordered transcript lives as a Walrus blob trail. The accepted agreement binds the exact amount, parties, capability and operation, so "what was agreed" can be checked later against "what was paid."

---

## How I use Tatum

Settlement evidence is only useful if you don't trust a single source for it. Supercuts submits transactions through a Sui RPC, then **independently reads them back through Tatum's Sui Testnet gRPC gateway** (`sui-testnet-grpc.gateway.tatum.io`) before it marks anything paid or remembers an outcome.

Tatum exposes plain gRPC, not gRPC-web, so I wrote a small native HTTP/2 client (`backend/src/tatum.ts`) that frames protobuf requests to `sui.rpc.v2.LedgerService` (`GetTransaction`, `GetServiceInfo` and friends). It enforces HTTPS, timeouts and response-size limits, and reads digest, checkpoint, effects, events and balance changes.

That Tatum read feeds three things:

- **Delivery gating.** The seller only releases the artifact after finality is confirmed.
- **Retry safety.** Every payment has a stable operation ID and a signed-transaction journal. If a broadcast is ambiguous, Supercuts reconciles it against Sui and Tatum instead of paying twice.
- **What memory learns.** Only payments verified by Sui *and* Tatum become `verified_outcome` memories. Unverified claims never become "experience."

For example, the shielded pool's relayed exit was confirmed final by both Sui and Tatum at checkpoint `401764344`.

---

## Two payment rails

**Public work → x402.** The seller runs its own protected resource. It returns an HTTP `402` challenge, the buyer signs the exact SUI transfer, a Sui Testnet facilitator validates and relays it, and the resource verifies the payment before delivering. Amount and payee are visible on chain, by design.

**Confidential work → shielded pool.** The buyer prefunds a standard-sized deposit into an experimental v2 Sui Move pool. To pay, it builds a Circom witness locally, proves it with RapidSnark, and submits the transfer. The deal amount and counterparty are committed in the proof instead of appearing as a direct transfer to the seller. The seller recovers its note locally and later queues a delayed exit through a separate relayer.

I want to be honest about the limits here: deposits, exits, gas, timing, payout addresses and the existence of pool activity are all still public, and a small Testnet pool is not a strong anonymity set. This is Testnet-only, unaudited software, not a production custody system.

If the owner approves it, a designated **auditor** can receive a **Seal**-encrypted disclosure scoped to exactly one deal.

---

## What it learned over time

This is the part I care about most, because it is what makes Supercuts more useful the longer you use it.

### Lesson 1: "My owner wants this private"

In the demo, I tell the agent, in plain language, to buy a confidential DeepBook competitor analysis and to **pay with public x402 because it's quicker**.

The agent asks for x402. Supercuts recalls the owner's privacy rule from Walrus Memory (`sui.confidential-analysis` classes must settle privately) and overrides the request. The settlement plan carries the reason code `MEMORY_PRIVACY_OVERRODE_RAIL`, and the deal evidence shows the difference memory made (trimmed):

```json
"memoryInfluence": {
  "changedSeller": false,
  "changedRail": true,
  "withoutMemory": { "rail": "x402", "...": "..." },
  "withMemory":    { "rail": "shielded", "...": "..." },
  "citedBlobIds": ["<owner rule memory blob id>"]
}
```

The rule is saved once, by class rather than by capability ID, so it still applies when a seller rotates its capability. The agent never had to be told twice, and it couldn't argue its way out of the rule.

### Lesson 2: "Which seller actually delivers?"

After every verified payment, Supercuts writes an outcome memory: amount, rail, latency, success or failure. Verified seller faults count as failures: a mismatched agreement, a Walrus readback mismatch or an invalid delivery. A buyer running out of funds is never blamed on the seller.

On the next deal, discovery builds a scorecard per seller from those memories: a recency-weighted Beta(1,1) posterior with a 7-day half-life. A seller that failed recently drops below a cheaper-but-reliable competitor. When memory changes the choice, the evidence shows `changedSeller: true`. `supercuts memory insights` prints the learned scorecards and how many payments memory has changed.

### Lesson 3: "How much have I already spent?"

Budget rules are memories too. A periodic budget subtracts spend that memory has already **verified** for the period, so a fresh agent session on a new machine still knows the month is half spent.

### Every deal shows its work

For any deal, `deal.evidence` returns `memoryInfluence`: what the same mandate would have done **without** memory, next to what Supercuts actually did, with the cited Mainnet memory blob IDs. "The agent learned" is something you can check, not just a claim.

---

## What I learned building it

- **Embedding dimensions bite.** Walrus Mainnet Memory requires 1536-dimensional embeddings. My local `embeddinggemma` produces 768. I wrote a small OpenAI-compatible adapter that keeps the original values and zero-pads to 1536. The rule is: use the same adapter for writes *and* recalls, or nothing matches.
- **Recall thresholds need calibrating.** With the padded embeddings, the exact owner rule ranked at distance `0.59` against the planner's longer query, so the demo profile uses a `0.61` limit. If the embedding model changes, that number has to be measured again.
- **Memory needs provenance, not just content.** The biggest design shift was separating *who* wrote a memory from *what* it says. Signed owner rules and verified outcomes can steer payments. Agent notes can only advise.
- **Verify with a second source.** Reading every settlement back through Tatum caught timing and finality edge cases that a single RPC would have hidden, and it gave memory a clean "verified only" input.
- **Keep keys out of the agent.** The SDK calls the runtime through a one-request subprocess, so role keys never sit in the agent's process. Buyer, sellers, auditor and relayer each have separate owner-only homes.

---

## On-chain evidence (Sui Testnet)

| Action | Transaction |
| --- | --- |
| v2 pool creation | [`BnzMqokg…`](https://suiscan.xyz/testnet/tx/BnzMqokgQVWwSkRYCCrMTyWwHN6HVdDKWwVDJXTZqC6b) |
| Shielded pool deposit | [`FNBVYbsX…`](https://suiscan.xyz/testnet/tx/FNBVYbsX7jxQ2uFkZhcgidfcxiBdntyELdEMUbDffvZH) |
| Shielded pool transfer | [`472A2B2b…`](https://suiscan.xyz/testnet/tx/472A2B2bhTR1eELDoYJbU5QRSZCU5MPUQ3unNJhnGnA4) |
| Relayed pool exit | [`GthWzx5k…`](https://suiscan.xyz/testnet/tx/GthWzx5kXsZ8DDkGiWZQJKaraDw3PAhHyXv5F9TJ9oGu) |
| Recorded public x402 payment | [`GrK5gR9S…`](https://suiscan.xyz/testnet/tx/GrK5gR9SBzGehv63f8xbau58YyiyssZ1pn2AbBT114kE) |
| Recorded confidential payment | [`3merQzwR…`](https://suiscan.xyz/testnet/tx/3merQzwRfYuQ2y4gr9Qe2VJTFS4TYHJXiwvQbEtbESwW) |
| `deal.execute` shielded deal | [`HxyeTY9T…`](https://suiscan.xyz/testnet/tx/HxyeTY9ThQoAtz4a1FLcgJhj1vtsSGSB3zyz6A9fyoeq) |
| `deal.execute` public x402 deal | [`CAWTGRYS…`](https://suiscan.xyz/testnet/tx/CAWTGRYSr5aTzMmToxZbZQmeX4DN2KiZz7ANoZxNsGeM) |

---

## Try it

```sh
printf 'allowBuilds:\n  blake-hash: true\n' > pnpm-workspace.yaml   # pnpm 10+
pnpm add @supercuts-walrus/sdk@0.1.10 @supercuts-walrus/backend@0.1.10
pnpm exec supercuts onboard buyer --home ./buyer
pnpm exec supercuts proofs install   # once per machine, only for shielded payments
```

Onboarding creates the buyer, approves sellers, saves your privacy rule to Walrus Memory, requests Testnet SUI from the faucet, makes the pool deposit, and wires the `supercuts-buyer` MCP server into your agent's config. After that, you just talk to your agent.

---

## What's next

Before anyone should trust the shielded pool with real value, it needs a reviewed proving ceremony, a security audit, operated infrastructure and a much bigger anonymity set. On the memory side, I want richer outcome signals (delivery quality, not just success) and shared, opt-in seller reputation across buyers.

Built for the **Total Recall: Tatum x Walrus Memory Hackathon**. Thanks to the Tatum and Walrus teams for the tooling. Feedback and issues are welcome on GitHub.

#Sui #Walrus #Tatum #AIAgents #x402
