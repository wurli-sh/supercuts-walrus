# Join Supercuts on Testnet

This path uses the experimental v2 Testnet pool. Give each buyer and seller its
own owner-only role home, state key, signer, and MCP process. The shared
directory lists signed public capabilities; it holds no role secrets.

## Seller

1. Create a separate live seller home with `supercuts init --role seller
   --home <seller-home>` and the pinned `config/phase1.testnet.json`, owner-only
   Sui and Tatum key files, RPC endpoints, Walrus URLs, and RapidSnark path.
   See the live `supercuts init` example in the backend README for the required
   flags. Keep the directory and credential files at mode `0600` and the home
   at `0700`.
2. Write a capability spec JSON with `capabilityId`, `capability`,
   `description`, `inputSchema`, `outputSchema`, `supportedRails`,
   `priceBand` (MIST strings), `asset` (`0x2::sui::SUI`), `endpoint`, and a
   future `expiresAt` Unix millisecond timestamp. The endpoint must be the
   seller-owned HTTPS `/v2/resource/<capability-id>` URL. The seller ID is
   taken from the separate seller signer.
3. Run `supercuts-seller-register <seller-home> <spec.json>
   <registration.json>`. Write a local handler module exporting an async
   `handle(request)` or default function returning `{ artifact, contentType,
   metadata }`. The artifact is a `Uint8Array`, and metadata must match the
   signed output schema. The runtime invokes it only after exact finalized
   payment verification.
4. Create a mode-`0600` seller service JSON with `origin`, `listenHost`,
   `listenPort`, optional seller-only facilitator settings for x402, and
   `capabilities: [{ "registrationFile": "<registration.json>",
   "handler": "<absolute-module-path>" }]`. Start `supercuts-seller-live
   <seller-home> <service.json>` behind HTTPS. The public origin must serve
   the exact registration at `/v2/catalog`.
5. Run `supercuts onboarding doctor --home <seller-home> --config
   <service.json>`, then `supercuts-seller-directory publish
   <registration.json> <directory-origin>`. Re-run the publish command after
   renewing an expired capability with the same seller signer.

## Buyer owner

Run `supercuts setup buyer --home <buyer-home>` in a terminal, or supply an
owner-only setup JSON. Set `directoryUrl` to the shared seller service origin,
the pinned v2 deployment and live-service paths, a per-deal ceiling, lifetime
budget, expiry, and the desired public x402 permission. `sellerOrigins` can
add private direct sellers. `allowedCounterparties` may start empty.

Inspect `GET <directory-origin>/v2/directory/catalog`, then approve a chosen
listing locally with `supercuts policy approve-seller --home <buyer-home>
--capability-id <id>`. Run `supercuts onboarding doctor --home <buyer-home>`
and `supercuts setup session --home <buyer-home>` before connecting the
generated Codex MCP configuration. The agent can now use `deal.catalog` and
`deal.execute` under the owner's policy. Use the same operation ID to resume
an interrupted deal.

The recorded demo follows the separate `supercuts-demo setup` funding rule:
fund only its generated buyer address, confirm Testnet native SUI balance,
run `supercuts-demo doctor`, and check the live event stream with
`supercuts-demo check`. Mock receipts are not funded settlement evidence.
