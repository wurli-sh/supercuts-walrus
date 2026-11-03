# npm release preparation

Supercuts 0.1.0 is an unpublished pair: `@supercuts/sdk` depends on the exact matching `@supercuts/backend` version. Both are ESM packages for Node 22.13 or later. The deployed pool in `config/phase1.testnet.json` is experimental and Testnet only. Existing v1 notes stay on the v1 pool.

## Install and try locally

On Linux or macOS, install Node 22.13 or later and pnpm. From `backend/`, run:

```sh
pnpm install
pnpm check
pnpm test
pnpm test:sdk
pnpm release:gate
```

The gate builds and packs both packages, checks tarball contents and matching versions, installs them in a clean temporary project, then exercises CLI help, the seam, setup and role MCP tools, and a non-funded SDK mock payment. It does not publish or send a Testnet transaction. It seeds the unpublished backend tarball locally before installing the SDK tarball; after publication, `npm install @supercuts/sdk@0.1.0` installs the backend dependency itself.

For a local mock trial, create a distinct owner-only home for each role. The SDK example in [the SDK guide](../backend/packages/sdk/README.md) shows a buyer client with an approval provider. Mock receipts say `deterministic-mock-not-funded` and are not settlement evidence.

CLI and MCP start without a profile:

```sh
supercuts help
SUPERCUTS_HOME="$PWD/private-buyer" supercuts-mcp
```

The unconfigured MCP connection exposes `setup.status`, which gives a local setup command. `supercuts setup buyer --home <buyer-home>` walks the owner through live buyer setup in a terminal. With a configured profile, `supercuts-mcp` exposes tools permitted by its role mandate and configured services. Give each role a separate `SUPERCUTS_HOME`, database, state key, signer, and MCP process. Keep directories at mode `0700` and credentials at mode `0600`.

## Live Testnet prerequisites

Supply the pinned `config/phase1.testnet.json`, proving manifest and circuit artifacts, executable SnarkJS, converter and RapidSnark paths, an owner-only Sui signer and Tatum API key, write and read RPC endpoints, a seller-owned x402 protected resource and Testnet facilitator, Walrus publisher and aggregator URLs, and owner-only Walrus Memory configuration with the 1536-dimensional adapter. See [self-service setup](self-service-setup.md) and [the backend guide](../backend/README.md). Live setup does not download proving artifacts or request faucet funds. Fund only the buyer address printed by `supercuts-demo setup`, and confirm its Testnet SUI balance before the live demo.

Run `supercuts doctor --home <buyer-home>` for the role runtime checks, then `supercuts-demo doctor --state-dir <demo-state>` for the five-role demo. The doctor needs live RPC access; the release gate does not.

## Publishing handoff

The release owner must confirm control of the `@supercuts` npm scope and publish `@supercuts/backend` before `@supercuts/sdk`. For public scoped packages use `npm publish --access public` for each tarball. Keep both versions equal and inspect `pnpm pack` output before publishing. The npm requirement is documented in the [scoped public package guide](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/). Publishing, account ownership, credentials, and live funds remain the release owner's responsibility.
