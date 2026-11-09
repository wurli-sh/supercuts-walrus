# npm release preparation

Supercuts 0.1.8 is a matched pair: `@supercuts-walrus/sdk` depends on the exact matching `@supercuts-walrus/backend` version. Both are ESM packages for Node 22.13 or later. The deployed pool in `config/phase1.testnet.json` is experimental and Testnet only. Existing v1 notes stay on the v1 pool.

## Install and try locally

On Linux or macOS, install Node 22.13 or later and pnpm. From `backend/`, run:

```sh
pnpm install
pnpm check
pnpm test
pnpm test:sdk
pnpm release:gate
```

The gate builds and packs both packages, checks tarball contents (including the Apache-2.0 license) and matching versions, installs them in a clean temporary project, then exercises CLI help, the seam, setup and role MCP tools, and a non-funded SDK mock payment. It does not publish or send a Testnet transaction. It seeds the candidate backend tarball locally before installing the SDK tarball; after publication, `npm install @supercuts-walrus/sdk@0.1.8` installs the backend dependency itself.

For a local mock trial, create a distinct owner-only home for each role. The SDK example in [the SDK guide](../backend/packages/sdk/README.md) shows a buyer client with an approval provider. Mock receipts say `deterministic-mock-not-funded` and are not settlement evidence.

CLI and MCP start without a profile:

```sh
supercuts help
SUPERCUTS_HOME="$PWD/private-buyer" supercuts-mcp
```

The unconfigured MCP connection exposes `setup.status`, which gives local buyer
and seller setup commands. `supercuts setup buyer --home <buyer-home>` and
`supercuts setup seller --home <seller-home>` walk the owner through the
corresponding live setup in a terminal; both also accept an owner-only
`--config` JSON. With a configured profile, `supercuts-mcp` exposes tools
permitted by its role mandate and configured services. Give each role a
separate `SUPERCUTS_HOME`, database, state key, signer, and MCP process. Keep
directories at mode `0700` and credentials at mode `0600`.

The backend tarball includes pinned Testnet metadata for an x402-only seller.
`supercuts seller scaffold` creates owner-only offer templates without embedding
facilitator secrets. Shielded proving artifacts remain a separate verified install.

`supercuts seller research` uses Claude web search to create an owner-only,
source-validated draft for a market brief or matching competitor analysis. The
draft is explicitly unapproved and cannot be provisioned by the hosted demo
until an owner reviews its claims and citations.

## Live Testnet prerequisites

Supply the pinned `config/phase1.testnet.json`, proving manifest and circuit artifacts, executable SnarkJS, converter and RapidSnark paths, an owner-only Sui signer and Tatum API key, write and read RPC endpoints, a seller-owned x402 protected resource and Testnet facilitator, Walrus publisher and aggregator URLs, and owner-only Walrus Memory configuration with the 1536-dimensional adapter. See [self-service setup](self-service-setup.md) and [the backend guide](../backend/README.md). Live setup does not download proving artifacts or request faucet funds. Fund only the buyer address printed by `supercuts-demo setup`, and confirm its Testnet SUI balance before the live demo.

Run `supercuts doctor --home <buyer-home>` for the role runtime checks, then `supercuts-demo doctor --state-dir <demo-state>` for the five-role demo. The doctor needs live RPC access; the release gate does not.

## Publishing handoff

The release owner must confirm that the npm account has permission to publish under the `@supercuts-walrus` organization scope. Run `npm whoami` and check organization membership in the npm account settings. The npm requirement is documented in the [organization scoped package guide](https://docs.npmjs.com/creating-and-publishing-an-organization-scoped-package/).

From the repository root, after the gate passes, build release tarballs outside the repository. Publish the backend first because the SDK depends on its exact version:

```sh
release_dir=$(mktemp -d)
pnpm --dir backend pack --pack-destination "$release_dir"
pnpm --dir backend/packages/sdk pack --pack-destination "$release_dir"
npm publish "$release_dir/supercuts-walrus-backend-0.1.8.tgz" --access public --dry-run
npm publish "$release_dir/supercuts-walrus-sdk-0.1.8.tgz" --access public --dry-run
# After reviewing both dry runs and confirming scope access:
npm publish "$release_dir/supercuts-walrus-backend-0.1.8.tgz" --access public
npm publish "$release_dir/supercuts-walrus-sdk-0.1.8.tgz" --access public
```

Publishing is irreversible for a version. Verify both packages with `npm view @supercuts-walrus/backend@0.1.8 version` and `npm view @supercuts-walrus/sdk@0.1.8 version`, then install the SDK in a clean project. If npm requires interactive authentication or a one-time code, complete it in the terminal; never put npm credentials in the repository.
