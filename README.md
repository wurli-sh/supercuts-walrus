# Supercuts

Supercuts is a headless private negotiation and settlement prototype for Sui.
The repository is implementing the sequential plan in [supercuts-plan.md](supercuts-plan.md).

## Phase 1 local checks

```sh
cargo test --workspace
pnpm --dir circuits install --frozen-lockfile
pnpm --dir circuits compile
pnpm --dir circuits test
sui move test --path contracts --statistics
```

The current local implementation includes the frozen v1 statement encoder,
cross-implementation vectors, complete two-public-input SHA-256 Circom
settlement constraints, a Sui Move pool with pinned verifier storage and
replay/custody guards, and a native BN254 serialization probe.

The **Phase 1 exit gate has passed** for the pinned test-only Sui Testnet
deployment. The funded proof-backed path, deployed adversarial/replay races,
Tatum history coverage, Walrus Mainnet round trip, x402 Testnet settlement, and
public-data inspection are recorded in `phase-1-report.md`. The generated
circuit artifacts and deployed pools remain experimental and must not custody
production assets.

## Phase 2 backend gate

```sh
./scripts/phase2-check.sh
```

The **Phase 2 formal exit gate passes** for the pinned test-only deployment.
Live transcript, Tatum, auditor-scoped Seal, application-bound x402, and ten-
Mainnet-memory artifacts are recorded in `phase-2-report.md`. The generated
proof system and deployed services remain experimental and are not a production
safety claim.

## Phase 3 CLI and MCP

Build and run the installable terminal interfaces:

```sh
pnpm --dir backend install --frozen-lockfile
pnpm --dir backend build
pnpm --dir backend exec supercuts init --role buyer --mock --home .state/buyer
pnpm --dir backend exec supercuts doctor --home .state/buyer
SUPERCUTS_HOME=.state/buyer pnpm --dir backend exec supercuts-mcp
```

For one-time self-service buyer setup and task-driven Codex deals, see
[Self-service setup](docs/self-service-setup.md).

Every command writes one `supercuts.v1` JSON value and failures use stable error
codes with a nonzero exit status. Mutating operations require `--authorize`.
Buyer, seller, and auditor homes must be separate. `--mock` is deterministic
development infrastructure: every receipt labels its evidence as non-funded and
must not be cited as a live settlement.

Run the Phase 3 implementation gate with:

```sh
./scripts/phase3-check.sh
```

The local E2E gate covers clean initialization, role isolation, negotiation with
a counteroffer, shielded and x402 mock settlement, crash/restart reconciliation,
seller note recovery and withdrawal, resource retrieval, ten memories, scoped
audit, MCP role surfaces, policy bypass attempts, packaging, and artifact pin
checks. Live/public release evidence remains separately identified in
`phase-3-report.md`.

## TypeScript SDK

The typed SDK is a separate package at `backend/packages/sdk`.
It invokes a one-request subprocess seam, so role state keys and wallet material
remain in the Supercuts process rather than entering the agent application's
heap. Buyer, seller, and auditor clients expose role-specific methods and use
canonical, short-lived approval tokens for every mutation.

```ts
import { BuyerClient } from "@supercuts/sdk";

const buyer = await BuyerClient.connect({
  home: "/private/supercuts/buyer",
  approvalProvider: {
    async approve(intent) {
      return operatorUi.review(intent);
    },
  },
});
const quote = await buyer.quote({
  rail: "shielded",
  amount: 100n,
  counterparty: "seller-a",
});
```

The approval provider must live in trusted host code, not in model-controlled
tool arguments. Run the SDK package, subprocess, and clean-install gate with:

```sh
./scripts/sdk-check.sh
```

The SDK also has an explicit Testnet profile. Its wallet runtime generates fresh
deposit/transfer/withdraw witnesses, proves them locally, journals locally signed
transactions before broadcast, and requires Sui plus Tatum finality. x402 is
challenge-driven through `payX402Resource`; unsupported live tools fail closed
and never route through the deterministic mock implementation.

