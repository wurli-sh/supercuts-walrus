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

It has **not passed the Phase 1 exit gate**. A test-only verifier-backed pool is
deployed on Sui Testnet, but the funded deposit/transfer/withdrawal path and
remaining live service evidence listed in
[phase-1-report.md](phase-1-report.md) remain open. The generated circuit
artifacts and deployed pool are experimental and must not custody production
assets.

