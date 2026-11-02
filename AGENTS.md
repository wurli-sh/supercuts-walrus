# Testnet funding

Supercuts' live demo uses Sui Testnet. Fund only the address printed by
`supercuts-demo setup` for the buyer role.

Request Testnet SUI with the Sui faucet:

```sh
sui client faucet --url https://faucet.testnet.sui.io --address 0xYOUR_ADDRESS
```

The faucet sends the Testnet native SUI asset, `0x2::sui::SUI`, to that address.
These tokens are for Testnet gas, x402 payment, and the shielded-pool deposit.
They have no Mainnet value and cannot be used on Mainnet.

Explorer and RPC responses may display the same type with a 32-byte padded
address: `0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI`.
Treat it as the same native SUI asset. For example, Testnet transaction
`CY3gyzMdQrQG7FzAhAzsvcEcYWfG6JwubNZs897wLjaG` credited its recipient with
`1000000000` MIST, which is 1 Testnet SUI.

Confirm the funded balance before running the live demo:

```sh
sui client balance 0xYOUR_ADDRESS --coin-type 0x2::sui::SUI
```

Faucet allocation and rate limits are controlled by the public faucet. Request
another allocation only if the address does not have enough Testnet SUI for the
planned demo transactions.

## Separate v2 withdrawal relayer

The owner authorized a separate Testnet relayer wallet on 2026-11-02. Its
address is `0x405f473ed1f7f609b16d3d7dabc7cd04831cfc73b4a7fcebe9fa502d72e357a3`.
The faucet funded it with 1 Testnet SUI in transaction
`DZ5spWBffooyD798fXW9APrEja2MyUKez5q2mkZRdkiD`; the confirmed balance
was `1000000000` MIST. Its encrypted signer and separate state key are in
`.state/v2-relayer/`, with owner-only permissions. Never copy that signer into
a buyer, seller, or auditor role home. Demo setup still requests faucet funds
only for its generated buyer address.

# Core demo rules

## Use the live path

The recorded demo must use live Testnet and Mainnet-backed services, not
`--mock`. Mock receipts are explicitly non-funded and cannot be presented as
settlement evidence. `supercuts-demo live` refuses mock profiles.

The deployed pool is Testnet-only and experimental. Do not describe it as a
production custody system.
The current pinned live pool is v2 in `config/phase1.testnet.json`.
`config/pool-v1.testnet.json` remains available for existing v1 note redemption;
do not migrate old notes implicitly.

## Keep roles separate

The demo creates five owner-only state directories:

- buyer
- public seller
- second public seller
- confidential seller
- auditor

Do not reuse a role home, SQLite database, state key, Sui private key, or MCP
server configuration for another role. Keep credential files mode `0600` and
directories mode `0700`.

`supercuts-demo setup --state-dir <path>` generates fresh Sui addresses and
writes them to `<path>/run.json` as `buyer`, `publicSeller`,
`secondPublicSeller`, `confidentialSeller`, and `auditor`. Do not hard-code or commit these addresses.
Fund only `buyer`. The public x402 resource uses `publicSeller` as its payee;
the confidential seller receives a shielded note and later recovers it locally.

## Settlement rails

- Public work uses x402: the amount and payee are visible in a normal Testnet
  SUI transfer.
- Confidential work uses the shielded pool: the deal amount and counterparty
  are committed in the proof rather than published as a direct payment.

The x402 facilitator only validates and relays a buyer-signed transaction. It
is not the seller resource. The workflow's `publicResourceUrl` must point to a
seller-owned protected resource that first returns an x402 `402` challenge.

For a shielded payment, do not claim that funding, deposits, withdrawals, gas,
or the existence of a pool transaction are hidden. The designated auditor can
receive a Seal-encrypted disclosure for one approved deal.

## Live-service prerequisites

Before recording, verify that the buyer has Testnet SUI and that these live
dependencies are configured:

- pinned deployment configuration in `config/phase1.testnet.json`
- Sui write RPC and Tatum read RPC credentials
- a seller-owned x402 resource and the Sui Testnet facilitator
- Walrus publisher and aggregator URLs for capabilities and transcripts
- an owner-only Walrus Memory configuration for durable memories
- circuit artifacts and RapidSnark for shielded proofs

Run `supercuts-demo setup` first. Its output identifies the buyer address that
needs Testnet funding and the public seller address that receives x402 payment.
Run `supercuts-demo doctor` before the live recording, then use
`supercuts-demo check` on the produced event stream.

## Walrus Memory embeddings

Walrus Mainnet Memory requires 1536-dimensional embeddings. The local
`embeddinggemma` model produces 768 dimensions, so run the repository adapter
before a live memory flow:

```sh
export EMBEDDING_UPSTREAM_BASE_URL=http://127.0.0.1:11434/v1
export EMBEDDING_UPSTREAM_MODEL=embeddinggemma
pnpm --dir circuits embedding:adapter
```

Point the memory configuration at `http://127.0.0.1:8787/v1` and use
`embeddinggemma-1536`. The adapter preserves the original 768 values and
zero-pads the remaining 768 positions to reach 1536. Use the same adapter for
both memory writes and recalls; sending `embeddinggemma` directly to the
relayer fails its 1536-dimension check. Memory plaintext must not be sent to
logs, browser state, prompts, or the Walrus relayer.

## Demo sequence

1. Prefund the buyer with a standard v2 pool deposit before negotiation.
2. Discover public and confidential seller capabilities.
3. Select a capability and negotiate the public exact amount.
4. Pay the public seller resource through x402 and show one delivered artifact.
5. Store ten meaningful encrypted memories, or explicitly label reuse of ten completed live writes; recall the privacy rule.
6. Show that the privacy rule selects shielded settlement instead of x402.
7. Settle the accepted confidential agreement through the pool.
8. Recover the confidential seller's note and queue a standard delayed exit.
9. If needed, demonstrate the auditor's scoped Seal disclosure.

Never print or record a Sui private key, seed phrase, note opening, approval
token, signature, ciphertext, or full model prompt in demo events or output.
