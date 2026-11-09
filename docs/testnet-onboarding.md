# Join Supercuts on Testnet

This path uses the experimental v2 Testnet pool. Give each buyer and seller its
own owner-only role home, state key, signer, and MCP process. The shared
directory lists signed public capabilities; it holds no role secrets.

## Seller

1. Install with `pnpm add @supercuts-walrus/backend@0.1.10` after allowing the `blake-hash` build
   (`printf 'allowBuilds:\n  blake-hash: true\n' > pnpm-workspace.yaml`), or use npm. Create a separate
   live seller home with `supercuts onboard seller --home <seller-home>`. A setup JSON containing only
   `{ "tatumKeyFile": "<owner-only file>" }` is enough; the endpoints default to public Testnet. In a noninteractive environment, add `--config
   <owner-only-setup.json>`. The config keys are `deploymentConfig`,
   `tatumKeyFile`, `writeGrpc`, `tatumGrpc`, `walrusPublisher`,
   `walrusAggregator`, and optional `suiKeyFile`, `snarkjs`, `converter`, and
   `rapidsnark`. `deploymentConfig` may be omitted for an x402-only seller;
   npm includes the pinned experimental Testnet metadata. Sellers offering the
   `shielded` rail run `supercuts proofs install` once per machine (about 370 MB,
   every file SHA-256 checked against the pinned index) to recover and exit notes.
   Shielded payments arrive as pool notes. `supercuts wallet balance --home
   <seller-home>` lists the spendable `noteCommitments`; queue a standard
   delayed exit for one with `supercuts wallet exit queue --home <seller-home>
   --operation-id <id> --commitment <commitment> --amount 1000000
   --window-start <unix-ms> --window-end <unix-ms> --authorize`. When `suiKeyFile` is omitted, Supercuts generates a fresh
   seller signer inside the seller home and also writes `seller-codex.toml`.
   The command explicitly reports that the seller does not need faucet funds.
   Keep the setup JSON and credentials at mode `0600` and the home at `0700`.
2. Run `supercuts seller scaffold --home <seller-home> --output <offer-dir>
   --capability-id <id> --capability <class> --description <text> --origin
   <https-origin> --price <MIST> --rails x402 --expires-in-days 30`. It writes
   owner-only capability, replaceable handler, and service templates and prints
   the exact next commands. For manual setup, write a capability spec JSON with `capabilityId`, `capability`,
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
   the exact registration at `/v2/catalog`; `/health` provides a non-secret
   readiness check. Generated x402 configs reference `X402_FACILITATOR_URL`
   and `FACILITATOR_SHARED_KEY` instead of embedding secrets. A self-hosted seller can run its own
   facilitator from the package. It needs no funds and only validates and relays the buyer-signed transfer:

   ```sh
   umask 077; openssl rand -hex 32 > credentials/facilitator.key
   export FACILITATOR_SHARED_KEY="$(cat credentials/facilitator.key)"
   PORT=8894 pnpm exec supercuts-facilitator &
   X402_FACILITATOR_URL=http://127.0.0.1:8894 pnpm exec supercuts-seller-live <seller-home> <service.json>
   ```

   The scaffolded `inputSchema` uses a `task` field. Change it to match the inputs buyers send for your
   capability class; for example, the directory's `sui.market-brief` sellers take `query`. Buyers only route
   to sellers whose signed schema accepts their input. The service holds an exclusive role-home lease. Stop it
   before running a seller MCP worker or another long-running owner process on
   that home.
5. Run `supercuts onboarding doctor --home <seller-home> --config
   <service.json>`, then `supercuts-seller-directory publish
   <registration.json> <directory-origin>`. Re-run the publish command after
   renewing an expired capability with the same seller signer.

The npm package contains the runtime, CLI, MCP server, SDK, and pinned Testnet
metadata needed by an x402-only seller. It does not bundle the large shielded
circuit artifacts or native Groth16 converter. A shielded seller points setup
at separately installed, hash-pinned artifacts and executables. A
loopback seller is suitable for local validation but cannot enter the shared
directory; directory listings require a publicly reachable HTTPS origin on a
standard port.

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
