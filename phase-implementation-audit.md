# Phase 1 and Phase 2 implementation audit

Date: 2026-10-30

## Patched findings

| Severity | Finding | Resolution |
| --- | --- | --- |
| Critical | Withdrawal replay detection treated `Set.add()` as a boolean, so duplicate nullifiers were not rejected by the backend index. | Check membership before insertion; reject duplicate chain positions and nullifiers. |
| Critical | Output-note recovery used SHA-256 instead of the Poseidon commitment enforced by protocol-v1 circuits. | Implement the exact Poseidon spend-tag and note formula, pinned to the Phase 1 semantic vector. |
| High | Wallet reconciliation accepted evidence for another digest, did not require successful effects, and did not bind output commitments. | Persist the complete expectation before proof persistence and require matching digest, success, deployment, nullifiers, and outputs. |
| High | A state transition could finalize with a second digest while SQLite silently retained the first. | Reject conflicting digest transitions and make same-state retries idempotent. |
| High | x402 trusted a caller-supplied `finalized` flag and returned cached resources before authenticating the retry. | Require an injected chain settlement reader and authenticate the payer binding before every delivery. |
| High | Concurrent x402 retries could run the producer more than once; empty resources were not recognized as cached. | Add an atomic cross-process lease and explicit delivered state, including zero-length responses. |
| High | The evidence report presented local Seal and request-binding tests as a completed formal live exit gate. | Correct the README, gate output, and report; both missing live acceptance runs are explicitly open. |
| Medium | Event batches mutated the live index before final pool-state comparison, leaving partial state after an error. | Apply to an isolated candidate and commit only after the root/index assertion passes. |
| Medium | The index did not enforce strict event positions or accepted-root membership for withdrawals. | Track positions and accepted roots; require strict ordering and known withdrawal roots. |
| Medium | Memory operation IDs could identify different facts, and uncertain responses could trigger duplicate writes. | Persist a fact hash and leave uncertain jobs unresolved for explicit reconciliation. |
| Medium | Audit authorizations omitted the opening/version and did not require the exact expected authors. | Canonically bind every disclosure field, exact authors, and the evidence transcript root. |
| Medium | Audit agreement verification used a generic SHA-256 helper instead of the protocol-v1 commitment. | Add strict canonical field parsing and recompute the exact nested Poseidon deal commitment before accepting finalized chain evidence. |
| Medium | Auditor-scoped Seal had only an injected local transport and no deployed allow/deny policy evidence. | Publish the standalone account policy on Testnet and pass threshold-2 designated-auditor decrypt, outsider denial, ciphertext-tamper rejection, and finalized-transfer binding. |
| Medium | The prior live x402 payment predated the Supercuts request-binding challenge and could not prove application-level binding. | Create a fresh live challenge first, sign its request/nonce/requirements/transaction binding, settle the resulting transaction through the protected resource, reconcile finalized chain evidence, and prove same-request deduplication plus cross-request replay rejection. |
| Medium | State directories and SQLite sidecars were not consistently hardened after creation. | Require owner-only directories, validate key length, and chmod the database and sidecars after WAL initialization. |
| Medium | Relayer inputs and Tatum responses lacked practical bounds. | Bound identifiers/proofs, bind payload lengths, and enforce gRPC timeout and response limits. |
| Medium | Dependency scans found vulnerable `ws`, `underscore`, and `tracing-subscriber` transitives. | Override patched JS versions and disable the unnecessary Arkworks default feature that pulled `tracing-subscriber`. |

## Remaining accepted dependency warnings

`cargo audit` reports unmaintained `derivative 2.2.0` and `paste 1.0.15` proc-macro dependencies inherited from Arkworks 0.5. They are build-time transitives with no published vulnerability. Replacing them requires an upstream Arkworks migration and should not be forced inside the pinned proof-serialization implementation.

`pnpm audit` reports one low-severity advisory in `elliptic` inherited through `circomlibjs -> ethers`; no patched `elliptic` version exists. The backend uses `circomlibjs` only for the circuit-compatible Poseidon commitment, not the affected elliptic signing primitive. Moderate and high audits are clean.

## Acceptance status

Phase 1 remains complete for the pinned test-only deployment. Phase 2 implementation and local E2E pass after these patches. The live auditor-scoped Seal and fresh application-bound x402 gates are both closed, so the formal Phase 2 exit gate passes for the pinned test-only deployment.
