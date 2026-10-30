# Phase 1 report

Date: 2026-10-30
Network target: Sui testnet
Status: **Phase 1 exit gate passed for the test-only Sui Testnet deployment**

This report is deliberately strict about the plan's gate rule. No mock or local
result below is represented as a funded chain transaction.

## Reproducible local evidence

Run the complete local suite:

```sh
./scripts/phase1-check.sh
```

Or run each component independently:

```sh
cargo test --workspace
pnpm --dir circuits install --frozen-lockfile
pnpm --dir circuits compile
pnpm --dir circuits test
sui move test --path contracts --statistics
```

Observed locally on 2026-10-30:

- Rust: 3 protocol-vector tests passed.
- Circom: deposit 154,871 constraints; transfer 290,796; withdrawal 144,132.
  Each declares exactly 2 public inputs. Nine semantic witness/adversarial tests
  pass, including rejection of a noncanonical BN254 scalar encoding. The deposit
  witness matches
  digest `448934bfc2b0bba6dcf39f9fcaacf0e7d42cfed555427bd674a797313feec7b8`;
  a one-unit public-input change is rejected.
- Move: 8 tests passed. The installed Sui runtime verified the official
  Arkworks-compressed BN254 probe plus generated semantic deposit, transfer,
  and withdrawal proofs. Statement lengths and all three complete statement
  encodings plus digest-to-little-endian-public-input conversion match the Rust
  vectors.
- The local feasibility run used `sui 1.68.1-3c0f387ebb40`, `circom 2.2.3`,
  and `cargo 1.96.0`. The funded Testnet publish used the network-matched
  `sui 1.83.0-16d2dc1e05ed` CLI.

Generated circuit hashes are written by `pnpm --dir circuits compile` to
`circuits/build/artifact-manifest.json`. They are intentionally ignored because
the artifacts are test-only and reproducibly regenerated.

## Implemented artifacts

- `docs/protocol-v1.md`: fixed byte order, widths, tags, public inputs, replay
  identities, deployment binding, visibility, tree capacity, and migration rule.
- `crates/supercuts-protocol`: Rust encoder and pinned positive/malformed vectors.
- `circuits/`: fixed-width SHA-256 statement compression for deposit, transfer,
  and withdrawal, witness tests, a resumable test-only proving pipeline, and
  pinned artifact manifests.
- `crates/supercuts-groth16`: validates SnarkJS points and proofs, resolves the
  Fq2 coefficient order by verification, and emits Sui's Arkworks canonical
  compressed verifier-key, proof, and public-input bytes.
- `contracts/`: generic `Pool<T>` custody object, three pinned prepared verifying
  keys, exact-coin deposits, current root/index checks, historical roots, note and
  deal replay tables, expiry against `Clock`, atomic transfer events, withdrawal
  payment, and two-input BN254 verification.
- `config/phase1.env.example` and `scripts/phase1-check.sh`: operator preflight
  without printing credential values.

## Security fence: test-only proving artifacts

The current circuits constrain the fixed-width statement digest together with
note openings, canonical field encodings, Merkle append or membership, value
conservation, note ownership, seller destination binding, and both agreement
signatures. The deployed Testnet pool pins the corresponding prepared verifier
keys. The remaining safety fence is the absence of a reviewed production
ceremony and complete live settlement/adversarial evidence. For that reason:

- `circuits/build/artifact-manifest.json` and `proving-manifest.json` are marked
  `testOnly: true`;
- locally contributed `.zkey` files and compatible verifier bytes exist, are
  pinned below, and back the deployed Testnet pool;
- the deployed pool is restricted to funded Testnet demonstration assets;
- deployment-bound deposit/transfer/withdraw proofs and live adversarial
  transactions remain open exit-gate dependencies.

## Feasibility and exit-gate ledger

### Funded Testnet Groth16 path

On 2026-10-30, the deployed pool accepted a complete proof-backed path using
the pinned test-only artifacts. Every proof was generated locally with the
pinned zkey, verified by SnarkJS, verified again by the Arkworks converter, and
then dry-run against the live shared pool before submission. The buyer and
seller note keys were fresh local test material; the withdrawal recipient was
the configured Testnet address. No secret recovery material was submitted to
the chain.

| Step | Transaction | Result | Net gas (MIST) |
| --- | --- | --- | ---: |
| Initial test deposit, 10,000,000 MIST | `6wfqrtzqUUAxnMJGA5N7Hs6mJFZsTkGiSg7tVd49APED` | leaf 0 | 2,612,937 |
| Recoverable buyer deposit, 10,000,000 MIST | `AM1iG733cJv1ZuR65BMRUsCD4Nt6VMwN75EF9RmSF75` | leaf 1 | 2,612,937 |
| Private transfer, 6,000,000 MIST payment + 4,000,000 MIST change | `9GkRqDK6RYNEMBs3iEY1aa3HqNhZ6vxQViHTAvBfuGcv` | leaves 2–3; one deal and input nullifier consumed | 5,835,337 |
| Seller-note withdrawal, 6,000,000 MIST | `Nm5ZkZMjLMgDyALSAb25sZes29mQQjH3aWpGAuhFzGz` | paid to configured recipient | 3,600,937 |

The transfer's new root was
`2b878e4ebebdb808929a16f9ab30ba34b3bd06e46511f70bcf6b89c3d8bd0070`
(base64: `K4eOTr69uAiSmhb5qzC6NLO9BuRlEfcLz2uJw9i9AHA=`), and the withdrawal event
used that same root. The final pool state is custody **14,000,000 MIST**,
`next_leaf = 4`, four accepted roots, two spent-note nullifiers, and one
consumed deal. This reconciles as 20,000,000 deposited − 6,000,000 withdrawn;
the remaining value is the deliberately retained first 10,000,000-MIST test
note plus the 4,000,000-MIST buyer change note.

Measured local proving time for the 290,796-constraint transfer circuit was
7,278 ms in SnarkJS and 2,023 ms with the pinned RapidSnark v0.0.4 generic
OpenMP build (3.6× faster). Both proofs had identical public inputs and passed
the same SnarkJS and Arkworks/Sui checks.

### Testnet package publication

- Network: Sui Testnet
- Package ID: `0xf887433ddfd1068f6df3020cd757939b99ceb418f0d8b9924092b01c7aee846e`
- Publish transaction: `6qDfLyy3HjB6moYb32JqSCH6KAeUSE78zThzSXDZmA4e`
- Upgrade capability: `0xc82df2742da1b4dd102b8793e2204af4c4d1ba6072a12e982a4052d1825ba308`
- Actual gas used: 38,331,200 MIST. The package contains the pool code only;
  its verifier-backed pool deployment is recorded below.

### Testnet pool creation

- Pool ID: `0x873e37b4745316f21a2780893f5fc36f87da559b08923fb4dad6237cd2e95d98`
- Creation transaction: `7D4q2VQDx35aAarLVzUgq7PrZ3y38ZCuEdfvpKb59ZV9`
- Deployment domain: `124998efcdbc869bb75638c05ab6b4b8f7cc8a1b7a278c9c50a755dd406385a0`
- Coin type: `0x2::sui::SUI`
- Verifier version: 1
- Initial root: `2134e76ac5d21aab186c2be1dd8f84ee880a1e46eaf712f9d371b6df22191f3e`
- Actual gas used: 19,977,200 MIST
- Initial state: balance 0, next leaf 0, one accepted root, zero spent
  notes, and zero consumed deals.

### Test-only Groth16 artifacts

The universal transcript is the official SnarkJS/Hermez power-19 phase-2-ready
file (54 contributions plus beacon). Its BLAKE2b-512 value matched the published
value:

`bca9d8b04242f175189872c42ceaa21e2951e0f0f272a0cc54fc37193ff6648600eaf1c555c70cdedfaf9fb74927de7aa1d33dc1e2a7f1a50619484989da0887`

Each circuit received one fresh local test-only Phase 2 contribution. SnarkJS
returned `ZKey Ok!`, SnarkJS verified the proof, the Rust converter verified the
converted Arkworks objects, and Sui Move accepted the exact serialized vector.

| Circuit | R1CS SHA-256 | zkey SHA-256 | Sui VK SHA-256 | proof SHA-256 |
| --- | --- | --- | --- | --- |
| Deposit | `0639967a15d6620d406c39dec98e51e4eae582438514420d78106ab4a42e4fc5` | `f6a06251552ef9e835389e09e95076e4bb44f15918d83111217f0f5656c24255` | `5dbdda85143b3756355ea88554e2e3bdd56c8732ca4ca68674aa6d6fbb16e4fd` | `b7f25cfb71d46a196732bdbfefd6f642642ac03b16f58cb445fd4e7d420dbeae` |
| Transfer | `fd5055fe7073f2ef6f6097e935b500f306f1eec10a9e5f5e03b3d7e9af0666c8` | `66259d5b9a7c2297e9f99ce38867856db9559cc4573b8fe036d51f271a8d9ff0` | `8c89c32a76a16dc14f5ac9aab362f7391e163fa89fbc9a256cb3498aec2bd325` | `ea606a98a583d9924b5c9d1e9c8e0f9ab2f7ecc222bb35007017cdc8a154c7f7` |
| Withdraw | `ff3fb629496f85515872ec5eb00bb199832a4d5138febc321d379d045e354fbb` | `5a340940e79dbb9979907d283100c95748e27841d28f0f76ce88018f2dbc7f45` | `44413f15569af9b0f95a84da6d1430601d332de509266b605bfc9587dc467372` | `097ecc74094026844691443d355fa57bb02e968fd4e126e94b4c671038c20a7e` |

Every serialized verifier key is 328 bytes, proof is 128 bytes, and public-input
vector is 64 bytes (two BN254 scalars).

## Reproducing the remaining live-gate evidence

Tatum retention coverage is checked against every required historical digest:

```sh
set -a; source .env; set +a
node scripts/tatum-history-check.mjs \
  6qDfLyy3HjB6moYb32JqSCH6KAeUSE78zThzSXDZmA4e \
  AM1iG733cJv1ZuR65BMRUsCD4Nt6VMwN75EF9RmSF75 \
  9GkRqDK6RYNEMBs3iEY1aa3HqNhZ6vxQViHTAvBfuGcv \
  Nm5ZkZMjLMgDyALSAb25sZes29mQQjH3aWpGAuhFzGz \
  BH8BHVHRVjix2phymB3GdBoxvtg3wqfF6UBuw9Z46JGb
```

The disposable-pool adversarial workflow is implemented by the following
commands. Deployment is dry-run by default and requires `--execute` explicitly:

```sh
pnpm --dir circuits pool:adversarial-deploy -- --execute
PHASE1_CONFIG=circuits/build/adversarial/config.json \
LIVE_FIXTURE_DIR=circuits/build/adversarial/fixtures \
  node circuits/scripts/create-live-fixtures.mjs
pnpm --dir circuits pool:adversarial-check
pnpm --dir circuits pool:adversarial-withdraw
pnpm --dir circuits pool:revision-race
```

Generated fixtures, proofs, recovery material, configs, and JSON evidence remain
under ignored `circuits/build/`; recovery secrets are not included in this report.

| Requirement | Evidence/status |
| --- | --- |
| Minimal locally generated BN254 serialization | Pass: Sui native verification accepts the generated semantic proofs and 328-byte verifying keys for all three circuits; deployed deposit, transfer, and withdrawal transactions use the same two-input proof serialization. |
| Statement encoding across Circom/Rust/Move | Pass: Rust and Move independently match all three full positive vectors; Circom accepts complete witnesses and rejects altered digests, noncanonical fields, invalid conservation, forged signatures/append paths, and wrong secrets. Deployed proof-bound mutations and a cross-domain/pool proof were rejected. |
| Deployment/network binding | Pass within Sui's enforceable boundary: random deployment domain + pool object ID + canonical coin-type hash + verifier version are proof-bound. Cross-domain/pool proof transaction `9zD8PDGqcRkT5LyT9XxuhfTuXFjc9Z52FxNkNJePYCzf` failed verification; a USDC call against `Pool<SUI>` was rejected with `TypeMismatch`. Sui Move exposes no authenticated chain ID, so no stronger claim is made. |
| Tatum authenticated read/history | Pass: `scripts/tatum-history-check.mjs` authenticated to Tatum and retrieved the package publication, deposit, transfer, withdrawal, and x402 transactions. `GetServiceInfo` reported lowest retained checkpoint `314252673`, before the required deployment checkpoint `400806621`; current checkpoint was `400842071`. The script hashes every protobuf response and exits nonzero if the retention floor moves past the oldest required transaction. |
| Walrus Memory Mainnet remember/recall | Pass: on 2026-10-30, `EMBEDDING_ENDPOINT=http://127.0.0.1:8787/v1 EMBEDDING_API_KEY=local-placeholder EMBEDDING_MODEL=embeddinggemma-1536 pnpm --dir circuits walrus:manual-check -- --write` completed client-managed encryption, uploaded blob `CSqwDAPctsLcyL4O6BqvEvrDxs18rOLt8s4_GC6gOuM`, and recalled its exact marker. The localhost adapter forwards to embeddinggemma and zero-pads its 768-dimensional output to the relayer-required 1536 dimensions. |
| Standard Sui x402 testnet paid request | Pass: on 2026-10-30, the configured facilitator returned its x402 v2 `402` challenge for `GET /signal/whales`. The active Testnet keystore signed an exact payment of 10,000 atomic Circle Testnet USDC to `0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d`; `/verify` accepted it, and one `PAYMENT-SIGNATURE` retry returned HTTP `200` plus a successful `PAYMENT-RESPONSE`. Settlement transaction `BH8BHVHRVjix2phymB3GdBoxvtg3wqfF6UBuw9Z46JGb` succeeded on Testnet. Its chain balance changes debit the payer by 10,000 USDC and credit the required payee by 10,000 USDC; SUI gas was 2,322,532 MIST. |
| Complete deposit/transfer/withdraw constraints | Pass for the test-only deployment: semantic witness tests and live proof-bound mutation transactions cover positive transitions and adversarial changes. Compatible proofs and serialized verifier artifacts pass SnarkJS, Arkworks, and deployed Sui verification. A reviewed production ceremony remains a separate production-safety requirement. |
| Funded testnet path | Pass for the Testnet demonstration: two proof-backed deposits, one agreement-bound private transfer with change, seller-note recovery material, and one withdrawal succeeded. Exact digests, events, roots, custody reconciliation, gas, and proof times are recorded above. |
| Adversarial direct contract calls | Pass on disposable Testnet pool `0x09627ea5f649b9b7a3c94d1c7f3710ede3a1117b97138c5eaee7ca57ed586f2a`: agreement, deal/input nullifier, payment/change output, expiry, root, leaf index, proof/signature/conservation, withdrawal amount, recipient, accepted root, withdrawal nullifier, and withdrawal proof mutations all failed. Every run compared custody, root, index, and table sizes before/after and found them unchanged. Evidence is generated by `pool:adversarial-check` and `pool:adversarial-withdraw`. |
| Concurrent replay and recovery | Pass: on pool `0x09627ea5f649b9b7a3c94d1c7f3710ede3a1117b97138c5eaee7ca57ed586f2a`, concurrent distinct transactions spending one note produced one success (`Dhqyf6dXnRYPPaoUZzmxXWZ41fSZkv8WZYbwBSyN77nj`) and one failure (`3ZV8rrhoWdQ4tqEEyc8kUayAoiFo5BR486roF7a7LHVR`), followed by rejected replay `6tRy9YezaT6VRCSMVR6c3rrFZnDBa3KTRNwbxmSztAja`. On pool `0x07fcc2c3d7bdb7ec4ec3b0d1dc7c3b51517c47d4d0254121f731e9b15905cb83`, two independently proved and buyer/seller-signed deal revisions with one shared deal nullifier raced: revision 1 succeeded (`9UsChzfCsa2iM1TW76ms82TY2m9NTGDJRuogfTGEhA5Q`) and revision 2 failed (`AQfE7rUotqburtkjLfgUZ5Sb7QDdQ5N9JDcfjTr3zHW2`). Each race advanced the root/index and replay tables exactly once. |
| Public-data inspection | Pass: ordinary `sui client tx-block <digest> --json` reads decoded all three recorded successful transactions. Deposit `AM1iG733cJv1ZuR65BMRUsCD4Nt6VMwN75EF9RmSF75` exposes leaf index, old/new roots, and note commitment. Transfer `9GkRqDK6RYNEMBs3iEY1aa3HqNhZ6vxQViHTAvBfuGcv` exposes roots, first output index, commitments, and deal/input nullifiers; it does not expose agreement plaintext, the 6,000,000-MIST private payment amount, recipient note opening, or 4,000,000-MIST change amount. Withdrawal `Nm5ZkZMjLMgDyALSAb25sZes29mQQjH3aWpGAuhFzGz` exposes its 6,000,000-MIST amount, recipient, nullifier, and root. As expected, ordinary chain metadata additionally exposes sender, timing, gas, and public deposit/withdrawal coin movements. |

## Phase 1 closure and production boundary

All Phase 1 exit-gate items now have recorded local, deployed Testnet, or live
service evidence. Phase 2 may integrate against the pinned test-only pool.
This does not make the proving setup production-safe: any production-value
deployment still requires an independently reviewed ceremony, security review,
and new deployment-bound evidence.
