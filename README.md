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

