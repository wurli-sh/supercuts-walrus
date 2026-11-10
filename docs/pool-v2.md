# Experimental pool v2 rollout

The v2 pool is Supercuts' confidential settlement rail for privately negotiated
agent deals. Walrus Memory can supply a scoped owner rule that selects this rail;
the pool proof then commits the accepted payment instead of publishing a direct
seller transfer. Memory does not hide the pool activity described below.

Pool v2 is a separate Move module (`pool_v2`) with statement version 2. The
current pinned Testnet deployment is `config/phase1.testnet.json`. Existing v1
notes must be redeemed against `config/pool-v1.testnet.json`; no note is
migrated or converted automatically.

V2 deposits accept 10,000,000 or 100,000,000 MIST. A standard exit pays
1,000,000 MIST and appends a private change note. An owner-approved exact exit
can pay another positive amount and visibly reveals that amount. The withdrawal
proof binds the input note, nullifier, payout address, amount, change commitment,
and current tree transition. A zero-value change commitment is appended when a
note is fully exited; it cannot fund another exit.

The buyer-side `V2PrefundQueue` schedules a standard amount and calls the live
deposit path when due; negotiation should start only after that deposit
finalizes. The owner-side `V2ExitQueue` selects a cryptographically random execution time
inside the chosen window and creates a new Sui payout key for each exit. Its
state database encrypts that key. `V2ExitRelayer` uses a separate funded key and
state database. It receives the public withdrawal fields and proof, simulates
the call, journals its signed bytes, and submits as the transaction sender.
It never receives a note opening. The caller must only send a queued request
when its scheduled time arrives. A stale root requires a new local proof and
a new operation ID; retrying an ambiguous broadcast uses the same signed bytes.
The separately funded relayer wallet is recorded in the workspace `AGENTS.md`.

Build the v2 circuit artifacts without replacing v1 artifacts:

```sh
pnpm --dir circuits compile:v2
pnpm --dir circuits test:v2
pnpm --dir circuits prove:v2:test-only
sui move test --path contracts
cargo test -p supercuts-protocol
pnpm --dir backend exec tsx --test test/pool-v2.test.ts
```

The Testnet gate completed with a funded deposit, private transfer, seller
recovery, and relayed exit verified by Sui and Tatum. The package, pool,
domain, checkpoint, and artifact hashes are pinned in the config files. The
separate relayer was funded before its exit and its address is in `AGENTS.md`.
Demo setup still requests faucet funds only for its generated buyer address.
The v2 recorded demo path now prefunds before negotiation and queues a seller
exit after the confidential payment. The gate transactions are:

| Action | Testnet transaction |
| --- | --- |
| Pool creation | `BnzMqokgQVWwSkRYCCrMTyWwHN6HVdDKWwVDJXTZqC6b` |
| Standard buyer deposit | `FNBVYbsX7jxQ2uFkZhcgidfcxiBdntyELdEMUbDffvZH` |
| Private payment | `472A2B2bhTR1eELDoYJbU5QRSZCU5MPUQ3unNJhnGnA4` |
| Standard relayed exit | `GthWzx5kXsZ8DDkGiWZQJKaraDw3PAhHyXv5F9TJ9oGu` |

The exit was submitted by the separate relayer address, credited a fresh
payout address with 1,000,000 MIST, and left a private change note. Sui and
Tatum reported successful finality at checkpoint `401764344`. A second exit
was queued for a later window and has not been submitted early.

The full v2 recording is in the owner-only local file
`.state/v2-demo/events-v2-accepted.jsonl`. Its prefunding deposit is
`CWygujqdti1zetVnqWMTxyR7MveUhJxcu6cWjjtUB244`, public x402 payment is
`GrK5gR9SBzGehv63f8xbau58YyiyssZ1pn2AbBT114kE`, and confidential pool
payment is `3merQzwRfYuQ2y4gr9Qe2VJTFS4TYHJXiwvQbEtbESwW`. The buyer
reused ten completed encrypted memories from an earlier live run; each event
marks that reuse, and the recording performs a fresh Walrus recall of the
owner policy. The recalled policy selected the shielded rail. The confidential
seller recovered its note and queued a 1,000,000 MIST exit for a later window.
`supercuts-demo check --require-claude` passed on this event file. This
recording used the earlier scripted runner; current recordings run every deal
through `deal.execute` in Codex and use `scripts/recording-check.mjs` as the
acceptance gate.
The buyer profile used a 0.61 memory distance limit with the zero-padded
`embeddinggemma-1536` adapter; the planner's longer query ranked the exact
scoped owner rule at 0.59. This limit is specific to this demo's embedding
setup and should be recalibrated if the embedding model changes.

The demo exit is scheduled under the owner-only user timer
`supercuts-v2-demo-exit.timer` for 2026-11-02 16:16:26 UTC, after the random
execution time of 16:16:21 and inside the owner-approved
15:29:20–16:29:20 UTC window. The worker retries unresolved broadcasts using
the relayer's signed transaction journal and writes verified Sui and Tatum
evidence to `.state/v2-demo/exit-completion.json` when final. Check the timer
with `systemctl --user status supercuts-v2-demo-exit.timer`, and check the
evidence file after execution. A stale, unsubmitted root is reproved locally
with a new relayer request ID before submission.

Deposits, withdrawals, payout addresses, gas use, transaction timing, and the
existence of pool activity remain public. Standard amounts and delayed exits
reduce some linkage, especially with more activity, but a small Testnet pool
does not support a strong anonymity claim. The pool is experimental Testnet
software, not a production custody system.

The live balance view reports deposit and exit counts plus distinct observed
depositing addresses. It warns when fewer than five depositing addresses are
observed. That count is only a visible address metric; one operator can control
many addresses.
