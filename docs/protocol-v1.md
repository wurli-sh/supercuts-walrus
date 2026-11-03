# Supercuts shielded pool protocol v1

This statement is the original shielded settlement component of Supercuts'
private agent negotiation and settlement layer. The negotiated agreement and
Walrus Memory decisions live above the pool protocol; this document defines
the proof and on-chain checks for existing v1 notes.

Status: experimental and unaudited. This document freezes the Phase 1 statement
encoding. It does not make a production-safety claim.

## Primitive choices

- Proof system: Groth16 over BN254, using Sui's Arkworks-compatible compressed
  verification-key, proof, and public-input serialization.
- Public proof inputs: exactly two BN254 scalars. They are the high and low
  128-bit halves of `SHA-256(statement_bytes)`, in that order. Each scalar is
  serialized as 32 little-endian bytes for Sui. No field reduction occurs.
- Statement integers: unsigned, fixed-width, big-endian. Amounts and indices are
  `u64`; verifier version is `u32`; expiry is Unix epoch milliseconds in `u64`.
- All identifiers, roots, commitments, nullifiers, hashes, addresses, and the
  deployment domain are exactly 32 bytes. Variable-width values are forbidden.
- Every 32-byte value decoded by a circuit as a BN254 scalar (roots,
  commitments, and nullifiers) uses the canonical big-endian encoding strictly
  below the BN254 scalar modulus. The circuit rejects modular aliases.
- The authenticated deployment domain is an operator-selected random 32-byte
  value created for one package/pool/network deployment. Move also binds the
  pool object's ID and `SHA-256(UTF-8 canonical Move type name of T)`. Sui does
  not expose a chain ID to Move, so the protocol does not claim that Move can
  independently authenticate a human-readable network name.

For a deployed pool, the coin-type hash is read from that pool's immutable
state (it is the SHA-256 of Move's `type_name::with_original_ids<T>()`), not
recomputed from a CLI shorthand such as `0x2::sui::SUI`.

## Common prefix

Every statement starts with the following 106 bytes:

| Offset | Width | Field |
| ---: | ---: | --- |
| 0 | 4 | ASCII `SCUT` |
| 4 | 1 | statement version, `0x01` |
| 5 | 1 | kind: deposit `1`, transfer `2`, withdraw `3` |
| 6 | 32 | deployment domain |
| 38 | 32 | pool object ID |
| 70 | 32 | coin-type hash |
| 102 | 4 | verifier version |

The following kind-specific fields are concatenated without BCS, lengths, or
padding.

### Deposit (226 bytes total)

`amount:u64 || note_commitment || old_root || old_index:u64 || new_root || new_index:u64`

The circuit proves a nonzero note opening for exactly `amount` and an append of
that note at `old_index`. It enforces `new_index = old_index + 1`.

### Transfer (354 bytes total)

`deal_commitment || deal_nullifier || input_nullifier || payment_commitment ||
change_commitment || expiry_ms:u64 || old_root || old_index:u64 || new_root ||
new_index:u64`

The circuit proves input membership and ownership, both authorizations over the
same agreement commitment, one settlement identity shared across agreement
revisions, `input_amount = payment_amount + change_amount` without field wrap,
seller-bound payment-note recovery data, buyer-derived change, and consecutive
append positions. It enforces `new_index = old_index + 2`.

The seller must reconstruct its proposed note commitment from seller-held
recovery material before signing. Proof validity alone does not establish that
the seller retained the recovery secret.

### Withdraw (210 bytes total)

`root || note_nullifier || recipient_address || amount:u64`

The circuit proves membership and ownership of a note for exactly the public
amount. Move checks the root is accepted and records the nullifier before paying
the recipient.

## Replay and transaction rules

- `deal_nullifier` derives from the stable logical deal ID, buyer authorization
  key, and settlement nonce, not the revision. All signed revisions therefore
  share one settlement identity; Move accepts it once.
- `input_nullifier`/`note_nullifier` derive from the note commitment and its
  spend secret. Move accepts either identity once.
- Move checks current root and index for appends, expiry using `Clock.timestamp_ms`,
  fixed verifier keys stored in the pool, domain, object ID, coin type, and
  verifier version before mutating custody or replay state.
- Failed Move calls are atomic and leave balance, roots, index, and tables unchanged.

## Tree and lifecycle

The v1 tree depth is 20 (1,048,576 leaves). Historical roots are retained in a
table for withdrawals; append operations require the current root. Events emit
the old/new roots, indices, commitments, and consumed public identities. At
exhaustion, appends abort. Verifier keys cannot be supplied per call. v1 has no
in-place verifier upgrade: deploy a new pool and withdraw/migrate notes through
an explicitly reviewed flow.

## Positive vector

The authoritative machine-readable vectors are generated and checked by
`supercuts-protocol`. Run `cargo test -p supercuts-protocol`. The pinned deposit
vector hashes to:

`448934bfc2b0bba6dcf39f9fcaacf0e7d42cfed555427bd674a797313feec7b8`

Its Sui public-input bytes are:

`e7f0acca9f9ff3dca6bbb0c2bf34894400000000000000000000000000000000b8c7ee3f3197a774d67b4255d5fe2cd400000000000000000000000000000000`

