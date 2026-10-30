# Phase 2 implementation and gate report

Date: 2026-10-30
Scope: pinned test-only Sui Testnet deployment and live Walrus services. This is hackathon evidence, not a production-safety claim.

## Reproduction

The deterministic gate is `./scripts/phase2-check.sh`. Live evidence was produced with `scripts/tatum-history-check.mjs`, `backend/scripts/live-negotiation.ts`, `backend/scripts/seal-live-e2e.ts`, `backend/scripts/x402-live-e2e.ts`, and `scripts/phase2-memory-check.mjs`. Secrets are loaded from the environment and are neither printed nor stored in this report. The Seal gate can be repeated with `pnpm --dir backend test:seal-live`; it creates fresh ephemeral auditor and authorizer keys and persists none of them. The x402 gate can be repeated with `pnpm --dir backend test:x402-live` using a funded Testnet `SUI_PRIVATE_KEY`.

## 1. Negotiation and storage

Pass. A buyer completed separate signed, encrypted Walrus Testnet sessions with three ephemeral sellers. Only the 9-unit offer was selected. A fresh SQLite-backed process fetched all blobs, verified Sui personal-message signatures, ordering, parent hashes, peers, revisions, and ciphertext hashes, then reconstructed each offer. An unrelated key failed AEAD authentication.

| Session hash | Selected | Transcript root | Walrus blob IDs |
| --- | --- | --- | --- |
| `b2c7840865f00160b9fe23f4a3a4b29e8015fa31d4c6ea597a93a82d6abb533f` | no | `a65c9289e26060012ff79131e525687f38f475e05307060361da29b5b51d47ee` | `2W4mTDhV6LJYeB_tlUErDpLKNsHgwWwhzx4U9b2wP4A`, `wYmTqt3gt7v_XS45205vn80t3VbLUlaTfKm4o2fg5_Q` |
| `6a8886c836dc61b07d78ac2e5821e9a9008ba9ae0bdc9d9b260d1dca38e5ce2e` | yes | `54b66d9e59654a445da80c399b7d0e3768ce69bb706576c6db0ca423b133907d` | `W0n8fL_Kx5DX8sS_LIL7UQOLBTYnl_tL4Xui25jjp28`, `6TgV9CyfuvBz8lkfxTESHF2I0whpCeGfOyY1h6RNvFM` |
| `50d99ed6324828e1c6f150c2b94cd7ef3b7b8dca26b5c768aa1f7226dd10aaaf` | no | `b793555dd86546eb55d04d26fdfe61c7864025f961ecd55cef39d43c984b5171` | `pg45y2geU_HdKMmN8rYT9mRwnrRN_ZpSAUnw-Cq4EqI`, `bRRYSXayqSBUJK-5S4VvdKo2ZIKmkEVP4P3VVfa2W2I` |

The E2E suite also rejects altered, missing, reordered, replayed, wrong-session, and wrong-peer messages. It resolves a lost upload response to the original durable message and exact ciphertext.

## 2. Shielded wallet and chain evidence

Implementation and local E2E pass, supported by the pinned deployment evidence below. The role store reserves the input before proof persistence, encrypts proofs and note openings at rest, reuses an operation ID after restart, and recovers seller payment and buyer change only when the protocol-v1 Poseidon opening recomputes the event commitment. Rebuilt events must equal the pool root and leaf index. Wrong roots, order, pool, asset, output commitments, nullifiers, transaction digest, failed effects, fabricated digests, and pending evidence fail closed.

Tatum reported chain `testnet`, current checkpoint `400906197`, retention floor `314252673`, and oldest required checkpoint `400806621`; full replay remains available. Service response SHA-256 was `e44849e5f80a5a268e4f96010ce104d3760719e23e1f0a35bbe18ab6f0b7fd83`. The finalized private transfer is `9GkRqDK6RYNEMBs3iEY1aa3HqNhZ6vxQViHTAvBfuGcv`; its seller-note recovery and change evidence are recorded in `phase-1-report.md` without secret openings.

## 3. Public x402

Pass. The fresh application-bound settlement is `GESuMYAZxdxh7eXvHWCNdsnJ3CoLSNodgjfx2h8VayLx`, finalized successfully at checkpoint `400919183`. The live resource challenge came from `https://sui-facilitator.onrender.com/signal/whales` and required x402 v2 `exact` payment of 10,000 atomic Circle Testnet USDC. On-chain balance changes credit exactly 10,000 units to `0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d`, debit exactly 10,000 units from the payer, and charge 2,322,532 MIST net gas. The returned 486-byte resource has SHA-256 `73f0a683433f98425711b784fc2cae152ff58e19900a49261823356fd5c1a03b`.

The Supercuts challenge was created before payment construction with request ID `supercuts-live-1793369448300-9f6904f53d5883d2`. Requirements hash `f6004930d08229b879cb00880afeae3accc5a8a62843e581eec666e01ba1cf15` binds the exact live 402 terms; the signed request/nonce/requirements/transaction message has SHA-256 `6805df4715fc6aaced9a6bf8b0e330a8bdb9bf00915cf16b634ee2f7578e3530`. The facilitator verified the signed Sui transaction before the protected endpoint settled it. The local resource server then independently read finalized chain evidence, authenticated the payer binding, and persisted the returned resource.

Request binding is a Supercuts application extension, not a facilitator claim. The payer signs the request ID, nonce, canonical requirements hash, and transaction digest. In the live run, a mutated nonce was rejected before settlement, replay of the original request returned the persisted response without rerunning its producer, and reuse of the finalized payment for another freshly signed request failed as consumed. The local suite additionally rejects wrong request, payee, exact amount, asset, network, signature, and digest. This closes the application-bound x402 gate.

## 4. Crash and retry matrix

Pass. `backend/test/phase2.e2e.test.ts` injects all five required boundaries: before proof persistence, after proof persistence, after broadcast before reply, after settlement before confirmation, and after confirmation before delivery. Reopened role stores reuse the operation, proof, digest, challenge, payment, and delivery. Every path ends in one finalized digest or `unresolved`; attempts to bind a second digest fail.

## 5. Scoped audit

Pass, including live Testnet policy enforcement. The disclosure contains selected terms and the deal blinding, transcript root, the exact required buyer/seller authorizers, deal nullifier, and finalized payment digest. It rejects a different deal, auditor, edited terms, substituted transcript root, missing/duplicate/invalid authorization, and non-final evidence. Wallet spend keys, note openings, and parent session keys are structurally rejected.

The standalone account policy was published on Testnet as package `0xcc689cc619cb2e7babeff498bf454e7b5fac9c118f4d8145485efcd8d85fbcce` in transaction `Ehpv7zZnxou3kxcYZDhDsZRueyiwWzT39SxsKefkZQG2` at checkpoint `400916719`. Its `seal_approve` accepts only when the encrypted identity equals `bcs::to_bytes(&ctx.sender())`; Move allow/deny tests pass.

The live gate encrypted a 2,423-byte disclosure at threshold 2 using the documented Mysten Testnet committee and independent key servers. Auditor `0x40de59a7c800af63396b02c941a3c609a5cf0c293782ed47472de00dce5d1514` decrypted it; a separately signed auditor was denied and a one-byte ciphertext mutation failed. Ciphertext SHA-256 was `1cce4ac856ee1785496f2a1852576c85a24bcb92a00bb8492dd3a91b44fdb1b4`.

Before decryption was accepted, the gate fetched finalized private transfer `9GkRqDK6RYNEMBs3iEY1aa3HqNhZ6vxQViHTAvBfuGcv` directly from Sui Testnet and required its event commitment `253210608e661fbc257bc34819d533ee20394a6d15eae2486844d429cb2e26b7` and nullifier `24fe74128adfbf1d586a6acfb8be8b5f0f0475abb57567fabb6d995fe87dec52`. The disclosed protocol-v1 terms and blinding independently reproduced that Poseidon commitment. This closes the auditor-scoped Seal policy gate.

## 6. Mainnet memory loop

Pass. Ten distinct client-managed Walrus Memory Mainnet jobs completed in namespace `supercuts-phase2-2026-10-30`:

```text
ALGz0PUlNCacN6-1xWYu_s6bG_IkbOQQMZTNWCbZ5iI
GtniFSPTh8rQErDBVF-AdjiAQ-gmnc3dm9x3-BZKsKc
RZ8ix-ISuTLgVLBMdz0pcUSM9WHmwrqfi_D8PAdx6U0
Zg8VLjZPzAWrZFY9kkpxMEjQWId0wAW15XlBsokB4jY
r1bu6nLFvSWC-eqpz--M7SfvtFs0TbbHgyovTS5Iv8A
XaIA3S9_ZgaFgTxlx5y-Xdfd3RdTQ25A6YgwPwMVi_s
65pW7sbtAX8RhFwaI3cTa7wezLAwUDM-qP4pPSty-Dg
dXPUXYwsOE6KLqhqN6ags0Z61Hupg9ZhWtXexGmpdxo
8dzBTG7Pj5TeUgqeOkahocVut-Tol4mECWQf465lWdU
JkBdzVy6A6CphaoX_dGLsF44bb33Hge2AkT46CeqK4A
```

Recall returned ten relevant facts and found the hidden-amount rule. The visible decision changed from `x402` before recall to `shielded` after recall. Empty and contradictory recall stop payment. The managed relayer received ciphertext; the separate embedding provider saw plaintext only on `127.0.0.1` through the 1536-dimensional adapter.

## Result and boundary

The Phase 2 implementation, local E2E suite, live auditor-specific Seal policy, and fresh application-bound x402 resource payment all pass. The formal Phase 2 exit gate is closed for the pinned test-only deployment. Production remains blocked on a reviewed proving ceremony, security review, and operated Mainnet Walrus publisher. No production-safety claim is made.
