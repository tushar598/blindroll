//! Leaf and Merkle rules. Must match `packages/core/src/merkle` byte for byte.
//! Shared vectors: `packages/core/test-vectors/merkle.json`.

use near_sdk::{AccountId, env};

pub const LEAF_PREFIX: &str = "blindroll:leaf:v1";
/// Proofs longer than this are rejected (a tree of depth 32 holds 4 billion leaves).
pub const MAX_PROOF_LEN: usize = 32;

/// `[A-Za-z0-9_-]{1,64}`
pub fn is_valid_run_key(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Decodes lowercase hex of exactly `N` bytes.
pub fn from_hex<const N: usize>(s: &str) -> Option<[u8; N]> {
    if !is_lower_hex(s, N * 2) {
        return None;
    }
    let raw = s.as_bytes();
    let nibble = |c: u8| if c <= b'9' { c - b'0' } else { c - b'a' + 10 };
    let mut out = [0u8; N];
    for (i, o) in out.iter_mut().enumerate() {
        *o = (nibble(raw[2 * i]) << 4) | nibble(raw[2 * i + 1]);
    }
    Some(out)
}

/// Canonical positive decimal: no sign, no leading zeros, fits in `u128`, greater than zero.
pub fn parse_amount(s: &str) -> Option<u128> {
    let b = s.as_bytes();
    if b.is_empty() || b.len() > 39 || b[0] == b'0' || !b.iter().all(u8::is_ascii_digit) {
        return None;
    }
    s.parse::<u128>().ok()
}

fn is_valid_evm_address(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && is_lower_hex(&s[2..], 40)
}

fn is_valid_solana_address(s: &str) -> bool {
    (32..=44).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() && !matches!(b, b'0' | b'O' | b'I' | b'l'))
}

/// Validates every leaf field and returns the parsed amount.
/// None of the accepted alphabets contain `|`, `\n` or `\r`, so the preimage is unambiguous.
pub fn validate_leaf(
    run_key: &str,
    chain: &str,
    address: &str,
    amount: &str,
    salt_hex: &str,
) -> Result<u128, &'static str> {
    if !is_valid_run_key(run_key) {
        return Err("run_key must match [A-Za-z0-9_-]{1,64}");
    }
    let address_ok = match chain {
        "near" => address.parse::<AccountId>().is_ok(),
        "evm" => is_valid_evm_address(address),
        "solana" => is_valid_solana_address(address),
        _ => return Err("chain must be near, evm or solana"),
    };
    if !address_ok {
        return Err("address is not valid for its chain");
    }
    let amount =
        parse_amount(amount).ok_or("amount must be a canonical positive decimal string")?;
    if !is_lower_hex(salt_hex, 32) {
        return Err("salt_hex must be 32 lowercase hex chars");
    }
    Ok(amount)
}

/// `blindroll:leaf:v1|run_key|chain|address|amount|salt_hex`
pub fn leaf_preimage(
    run_key: &str,
    chain: &str,
    address: &str,
    amount: &str,
    salt_hex: &str,
) -> Result<String, &'static str> {
    validate_leaf(run_key, chain, address, amount, salt_hex)?;
    Ok([LEAF_PREFIX, run_key, chain, address, amount, salt_hex].join("|"))
}

pub fn leaf_hash(
    run_key: &str,
    chain: &str,
    address: &str,
    amount: &str,
    salt_hex: &str,
) -> Result<[u8; 32], &'static str> {
    Ok(env::sha256_array(
        leaf_preimage(run_key, chain, address, amount, salt_hex)?.as_bytes(),
    ))
}

/// Internal node = sha256(min(a, b) || max(a, b)), byte-wise comparison.
pub fn hash_pair(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(lo);
    buf[32..].copy_from_slice(hi);
    env::sha256_array(&buf[..])
}

/// Recomputes the root. `None` if the proof is too long or an item is not 64 lowercase hex chars.
pub fn compute_root(leaf: &[u8; 32], proof: &[String]) -> Option<[u8; 32]> {
    if proof.len() > MAX_PROOF_LEN {
        return None;
    }
    let mut node = *leaf;
    for item in proof {
        node = hash_pair(&node, &from_hex::<32>(item)?);
    }
    Some(node)
}

pub fn verify_proof(leaf: &[u8; 32], proof: &[String], root: &[u8; 32]) -> bool {
    compute_root(leaf, proof).as_ref() == Some(root)
}
