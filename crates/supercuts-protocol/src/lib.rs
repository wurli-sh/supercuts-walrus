#![forbid(unsafe_code)]
//! Canonical Supercuts Phase 1 statement encoding.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAGIC: &[u8; 4] = b"SCUT";
pub const STATEMENT_VERSION: u8 = 1;
pub const COMMON_BYTES: usize = 106;
pub const DEPOSIT_BYTES: usize = COMMON_BYTES + 120;
pub const TRANSFER_BYTES: usize = COMMON_BYTES + 248;
pub const WITHDRAW_BYTES: usize = COMMON_BYTES + 104;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum StatementKind {
    Deposit = 1,
    Transfer = 2,
    Withdraw = 3,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Deployment {
    pub domain: [u8; 32],
    pub pool_id: [u8; 32],
    pub coin_type_hash: [u8; 32],
    pub verifier_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Transition {
    pub old_root: [u8; 32],
    pub old_index: u64,
    pub new_root: [u8; 32],
    pub new_index: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Statement {
    Deposit {
        deployment: Deployment,
        amount: u64,
        note_commitment: [u8; 32],
        transition: Transition,
    },
    Transfer {
        deployment: Deployment,
        deal_commitment: [u8; 32],
        deal_nullifier: [u8; 32],
        input_nullifier: [u8; 32],
        payment_commitment: [u8; 32],
        change_commitment: [u8; 32],
        expiry_ms: u64,
        transition: Transition,
    },
    Withdraw {
        deployment: Deployment,
        root: [u8; 32],
        note_nullifier: [u8; 32],
        recipient: [u8; 32],
        amount: u64,
    },
}

impl Statement {
    pub fn kind(&self) -> StatementKind {
        match self {
            Self::Deposit { .. } => StatementKind::Deposit,
            Self::Transfer { .. } => StatementKind::Transfer,
            Self::Withdraw { .. } => StatementKind::Withdraw,
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let (deployment, expected) = match self {
            Self::Deposit { deployment, .. } => (deployment, DEPOSIT_BYTES),
            Self::Transfer { deployment, .. } => (deployment, TRANSFER_BYTES),
            Self::Withdraw { deployment, .. } => (deployment, WITHDRAW_BYTES),
        };
        let mut out = Vec::with_capacity(expected);
        out.extend_from_slice(MAGIC);
        out.push(STATEMENT_VERSION);
        out.push(self.kind() as u8);
        out.extend_from_slice(&deployment.domain);
        out.extend_from_slice(&deployment.pool_id);
        out.extend_from_slice(&deployment.coin_type_hash);
        out.extend_from_slice(&deployment.verifier_version.to_be_bytes());
        match self {
            Self::Deposit {
                amount,
                note_commitment,
                transition,
                ..
            } => {
                out.extend_from_slice(&amount.to_be_bytes());
                out.extend_from_slice(note_commitment);
                encode_transition(&mut out, transition);
            }
            Self::Transfer {
                deal_commitment,
                deal_nullifier,
                input_nullifier,
                payment_commitment,
                change_commitment,
                expiry_ms,
                transition,
                ..
            } => {
                out.extend_from_slice(deal_commitment);
                out.extend_from_slice(deal_nullifier);
                out.extend_from_slice(input_nullifier);
                out.extend_from_slice(payment_commitment);
                out.extend_from_slice(change_commitment);
                out.extend_from_slice(&expiry_ms.to_be_bytes());
                encode_transition(&mut out, transition);
            }
            Self::Withdraw {
                root,
                note_nullifier,
                recipient,
                amount,
                ..
            } => {
                out.extend_from_slice(root);
                out.extend_from_slice(note_nullifier);
                out.extend_from_slice(recipient);
                out.extend_from_slice(&amount.to_be_bytes());
            }
        }
        debug_assert_eq!(out.len(), expected);
        out
    }

    pub fn digest(&self) -> [u8; 32] {
        Sha256::digest(self.encode()).into()
    }

    /// Arkworks canonical field serialization is little-endian. Each digest half is
    /// below 2^128, so it is a canonical BN254 scalar and needs no modular reduction.
    pub fn public_inputs(&self) -> [[u8; 32]; 2] {
        let digest = self.digest();
        let mut high = [0u8; 32];
        let mut low = [0u8; 32];
        for index in 0..16 {
            high[index] = digest[15 - index];
            low[index] = digest[31 - index];
        }
        [high, low]
    }

    pub fn public_inputs_bytes(&self) -> [u8; 64] {
        let [high, low] = self.public_inputs();
        let mut result = [0u8; 64];
        result[..32].copy_from_slice(&high);
        result[32..].copy_from_slice(&low);
        result
    }
}

fn encode_transition(out: &mut Vec<u8>, transition: &Transition) {
    out.extend_from_slice(&transition.old_root);
    out.extend_from_slice(&transition.old_index.to_be_bytes());
    out.extend_from_slice(&transition.new_root);
    out.extend_from_slice(&transition.new_index.to_be_bytes());
}

pub fn hex32(value: &str) -> Result<[u8; 32], Hex32Error> {
    let value = value.strip_prefix("0x").unwrap_or(value);
    if value.len() != 64 {
        return Err(Hex32Error::Length(value.len()));
    }
    let bytes = hex::decode(value).map_err(Hex32Error::Hex)?;
    bytes
        .try_into()
        .map_err(|v: Vec<u8>| Hex32Error::Length(v.len() * 2))
}

#[derive(Debug, thiserror::Error)]
pub enum Hex32Error {
    #[error("expected 64 hexadecimal characters, got {0}")]
    Length(usize),
    #[error("invalid hexadecimal value: {0}")]
    Hex(hex::FromHexError),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fill(byte: u8) -> [u8; 32] {
        [byte; 32]
    }
    fn deployment() -> Deployment {
        Deployment {
            domain: fill(0x11),
            pool_id: fill(0x22),
            coin_type_hash: fill(0x33),
            verifier_version: 1,
        }
    }

    #[test]
    fn pinned_encodings_and_inputs() {
        let deposit = Statement::Deposit {
            deployment: deployment(),
            amount: 100,
            note_commitment: fill(0x44),
            transition: Transition {
                old_root: fill(0x55),
                old_index: 0,
                new_root: fill(0x66),
                new_index: 1,
            },
        };
        assert_eq!(deposit.encode().len(), DEPOSIT_BYTES);
        assert_eq!(
            hex::encode(deposit.digest()),
            "448934bfc2b0bba6dcf39f9fcaacf0e7d42cfed555427bd674a797313feec7b8"
        );
        assert_eq!(
            hex::encode(deposit.public_inputs_bytes()),
            "e7f0acca9f9ff3dca6bbb0c2bf34894400000000000000000000000000000000b8c7ee3f3197a774d67b4255d5fe2cd400000000000000000000000000000000"
        );

        let transfer = Statement::Transfer {
            deployment: deployment(),
            deal_commitment: fill(0x44),
            deal_nullifier: fill(0x45),
            input_nullifier: fill(0x46),
            payment_commitment: fill(0x47),
            change_commitment: fill(0x48),
            expiry_ms: 1_900_000_000_000,
            transition: Transition {
                old_root: fill(0x55),
                old_index: 1,
                new_root: fill(0x66),
                new_index: 3,
            },
        };
        assert_eq!(transfer.encode().len(), TRANSFER_BYTES);
        assert_eq!(
            hex::encode(transfer.digest()),
            "1278a4506a4ea9285bd36179bacb5c8f0109b54ddc7d2493b7ad77862034ecd0"
        );

        let withdraw = Statement::Withdraw {
            deployment: deployment(),
            root: fill(0x55),
            note_nullifier: fill(0x46),
            recipient: fill(0x77),
            amount: 60,
        };
        assert_eq!(withdraw.encode().len(), WITHDRAW_BYTES);
        assert_eq!(
            hex::encode(withdraw.digest()),
            "58d50fd516eba11b7d30d4eaae0d3be41ce4cec60195daf3177d27709c978f05"
        );
    }

    #[test]
    fn every_boundary_field_is_bound() {
        let base = Statement::Deposit {
            deployment: deployment(),
            amount: 100,
            note_commitment: fill(0x44),
            transition: Transition {
                old_root: fill(0x55),
                old_index: 0,
                new_root: fill(0x66),
                new_index: 1,
            },
        };
        let digest = base.digest();
        let mut variants = Vec::new();
        let mut value = base.clone();
        if let Statement::Deposit { deployment, .. } = &mut value {
            deployment.domain[0] ^= 1;
        }
        variants.push(value);
        let mut value = base.clone();
        if let Statement::Deposit { deployment, .. } = &mut value {
            deployment.pool_id[0] ^= 1;
        }
        variants.push(value);
        let mut value = base.clone();
        if let Statement::Deposit { deployment, .. } = &mut value {
            deployment.coin_type_hash[0] ^= 1;
        }
        variants.push(value);
        let mut value = base.clone();
        if let Statement::Deposit { amount, .. } = &mut value {
            *amount += 1;
        }
        variants.push(value);
        assert!(
            variants
                .into_iter()
                .all(|statement| statement.digest() != digest)
        );
    }

    #[test]
    fn malformed_fixed_bytes_are_rejected() {
        assert!(matches!(hex32("01"), Err(Hex32Error::Length(2))));
        assert!(matches!(hex32(&"g".repeat(64)), Err(Hex32Error::Hex(_))));
    }
}
