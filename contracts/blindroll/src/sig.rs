//! EVM claim message and signature recovery. Must match
//! `packages/core/src/claims/message.ts` byte for byte.
//! Shared vectors: `packages/core/test-vectors/claim-message.json`.

use near_sdk::{AccountId, env};

use crate::merkle::{from_hex, is_lower_hex, is_valid_run_key, to_hex};

/// Printable ASCII without `|`, 1..=128 bytes. Excludes `\n` and `\r` by construction.
pub fn is_valid_message_field(s: &str) -> bool {
    (1..=128).contains(&s.len()) && s.bytes().all(|b| (0x20..=0x7e).contains(&b) && b != b'|')
}

/// The exact text the recipient signed with `personal_sign`.
#[allow(clippy::too_many_arguments)]
pub fn build_claim_message(
    contract_id: &AccountId,
    run_key: &str,
    leaf_hash_hex: &str,
    payout_kind: &str,
    payout_target: &AccountId,
    destination_asset: &str,
    destination_address: &str,
    expires_at_ms: u64,
) -> Result<String, &'static str> {
    if !is_valid_run_key(run_key) {
        return Err("run_key must match [A-Za-z0-9_-]{1,64}");
    }
    if !is_lower_hex(leaf_hash_hex, 64) {
        return Err("leaf_hash must be 64 lowercase hex chars");
    }
    if payout_kind != "near_ft" && payout_kind != "oneclick" {
        return Err("payout_kind must be near_ft or oneclick");
    }
    if !is_valid_message_field(destination_asset) {
        return Err(
            "destination_asset must be 1-128 printable ASCII chars without '|' or newlines",
        );
    }
    if !is_valid_message_field(destination_address) {
        return Err(
            "destination_address must be 1-128 printable ASCII chars without '|' or newlines",
        );
    }
    if expires_at_ms == 0 {
        return Err("expires_at_ms must be positive");
    }
    Ok(format!(
        "Blindroll claim v1\ncontract: {contract_id}\nrun: {run_key}\nleaf: {leaf_hash_hex}\npayout: {payout_kind}:{payout_target}\nto: {destination_asset}:{destination_address}\nexpires: {expires_at_ms}"
    ))
}

/// keccak256("\x19Ethereum Signed Message:\n" + len(message) + message)
pub fn eip191_hash(message: &str) -> [u8; 32] {
    let mut data = format!("\x19Ethereum Signed Message:\n{}", message.len()).into_bytes();
    data.extend_from_slice(message.as_bytes());
    env::keccak256_array(&data[..])
}

/// Parses `0x` + 130 lowercase hex chars into `(r || s, v)` with `v` normalized to 0/1.
pub fn parse_signature(signature_hex: &str) -> Option<([u8; 64], u8)> {
    let raw = from_hex::<65>(signature_hex.strip_prefix("0x")?)?;
    let v = match raw[64] {
        0 | 27 => 0,
        1 | 28 => 1,
        _ => return None,
    };
    let mut rs = [0u8; 64];
    rs.copy_from_slice(&raw[..64]);
    Some((rs, v))
}

/// Recovers the lowercase `0x` EVM address that signed `message` with personal_sign.
/// High-s (malleable) signatures are rejected.
pub fn recover_evm_address(message: &str, signature_hex: &str) -> Option<String> {
    let (rs, v) = parse_signature(signature_hex)?;
    let hash = eip191_hash(message);
    let pubkey = env::ecrecover(&hash, &rs, v, true)?;
    let digest = env::keccak256_array(&pubkey[..]);
    Some(format!("0x{}", to_hex(&digest[12..])))
}
