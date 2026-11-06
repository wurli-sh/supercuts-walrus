# Judging Supercuts

Supercuts is a private negotiation and settlement layer for agents, boosted by Walrus Memory. Its CLI, TypeScript SDK, and MCP server let a buyer verify signed seller capabilities, negotiate through an encrypted transcript, pay on the owner-approved rail, and learn from encrypted memories. The live walkthrough uses Sui Testnet for payments and live Walrus services. The shielded pool is experimental and test-only.

## Fast review

1. Read the [README](README.md) for the product flow and [architecture](ARCHITECTURE.md) for trust boundaries.
2. Inspect the pinned v2 deployment in [`config/phase1.testnet.json`](config/phase1.testnet.json) and the funded transaction digests in [`docs/pool-v2.md`](docs/pool-v2.md).
3. Review the [v2 pool gate and recorded demo](docs/pool-v2.md). The recording reused ten completed live Memory writes and made a fresh policy recall; it labels that reuse.
4. Follow [`docs/remote-codex-demo.md`](docs/remote-codex-demo.md) for the remote buyer and seller recording, or [`docs/self-service-setup.md`](docs/self-service-setup.md) for a reusable buyer setup.

There is no public login or hosted judge dashboard in this repository. A fresh funded run needs the operator's service credentials and private role state; those are intentionally excluded from Git.

## Run a fresh live walkthrough

From the repository root, build the backend and follow the setup arguments in the [remote demo guide](docs/remote-codex-demo.md). `supercuts-demo setup --state-dir <path>` creates separate buyer, two public sellers, a confidential seller, and an auditor. It prints the buyer address to fund and the public seller's x402 payee address. Fund **only the generated buyer address**:

```sh
sui client faucet --url https://faucet.testnet.sui.io --address 0xYOUR_BUYER_ADDRESS
sui client balance 0xYOUR_BUYER_ADDRESS --coin-type 0x2::sui::SUI
```

Check the pinned deployment, Sui write RPC, Tatum read RPC, seller-owned protected x402 resource, Testnet facilitator, Walrus publisher and aggregator, owner-only Walrus Memory configuration, circuit artifacts, and RapidSnark. The Memory relayer requires 1536-dimensional embeddings; use the repository adapter described in [`AGENTS.md`](AGENTS.md). Then run `supercuts-demo doctor`, record the **live** path, and run `supercuts-demo check` on its event stream. The exact command arguments depend on the owner-only workflow and role homes created during setup; the [remote demo guide](docs/remote-codex-demo.md) supplies them.

The recording should show prefunding before negotiation, capability discovery, signed encrypted negotiation, a public x402 purchase and delivery, ten live encrypted memories or clearly marked reuse, privacy-rule recall that changes the rail choice, shielded settlement, confidential seller note recovery, and a queued standard delayed exit. The auditor disclosure is optional and scoped to one approved deal. `--mock` receipts are explicitly non-funded and do not count as settlement evidence.

## Existing Testnet evidence

| Action | Transaction digest | Source |
| --- | --- | --- |
| v2 pool creation | `BnzMqokgQVWwSkRYCCrMTyWwHN6HVdDKWwVDJXTZqC6b` | [`docs/pool-v2.md`](docs/pool-v2.md) |
| Shielded pool deposit | `FNBVYbsX7jxQ2uFkZhcgidfcxiBdntyELdEMUbDffvZH` | [`docs/pool-v2.md`](docs/pool-v2.md) |
| Shielded pool transfer | `472A2B2bhTR1eELDoYJbU5QRSZCU5MPUQ3unNJhnGnA4` | [`docs/pool-v2.md`](docs/pool-v2.md) |
| Relayed pool exit | `GthWzx5kXsZ8DDkGiWZQJKaraDw3PAhHyXv5F9TJ9oGu` | [`docs/pool-v2.md`](docs/pool-v2.md) |
| Recorded public payment (x402) | `GrK5gR9SBzGehv63f8xbau58YyiyssZ1pn2AbBT114kE` | [`docs/pool-v2.md`](docs/pool-v2.md) |
| Recorded shielded payment | `3merQzwRfYuQ2y4gr9Qe2VJTFS4TYHJXiwvQbEtbESwW` | [`docs/pool-v2.md`](docs/pool-v2.md) |

The recorded demo event stream is owner-only at `.state/v2-demo/events-v2-accepted.jsonl`; it is not checked in. [`docs/pool-v2.md`](docs/pool-v2.md) reports that `supercuts-demo check --require-claude` passed against it.

## The memory learning loop

Walrus Memory is the decision layer for every agent payment, not a log.

1. **Discovery** recalls verified outcomes for every seller that matches the task. It ranks sellers by a recency-weighted reliability scorecard instead of by price alone (`backend/src/memory-scorecard.ts`, `Phase3App.rankDealCandidates`).
2. **Planning** applies owner privacy rules (shielded vs x402) and budget rules. A periodic budget subtracts spend that memory has already verified. Planning also asks for owner review after a fresh failure (`createSettlementPlan`).
3. **After payment** the runtime queues a verified outcome memory carrying amount, rail, and latency. A verified seller fault is recorded as a failed outcome, for example a mismatched agreement, a Walrus readback mismatch, or an invalid delivery. Buyer funding gaps are never blamed on the seller.
4. **Next deal** recalls those memories, possibly from another machine: trusted memories carry the owner's memory-key signature.

To see the change, call `deal.evidence` for any deal and look at `memoryInfluence`. It shows the decision the same mandate would have made without memory (`withoutMemory`) next to the actual one (`withMemory`), with the cited memory blob IDs. Then run `supercuts memory insights --home <buyer-home>` to see the learned per-seller scorecards and how many payments memory changed.

## What the walkthrough shows

The public x402 resource issues its own `402` challenge and releases the artifact after payment verification; the facilitator validates and relays the buyer-signed transaction. Its amount and payee are public. The confidential pool transfer avoids a direct public payment naming the seller and deal amount. Deposits, exits, gas, timing, payout addresses, and the presence of pool activity remain public. This Testnet pool is not a production custody system and its small activity set does not support a strong anonymity claim.
