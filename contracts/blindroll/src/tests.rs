//! Unit tests. Merkle and claim-message tests read the same JSON vectors as the TypeScript
//! tests in `packages/core`, which proves both implementations agree byte for byte.

use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};

use super::*;

const MERKLE_JSON: &str = include_str!("../../../packages/core/test-vectors/merkle.json");
const CLAIM_JSON: &str = include_str!("../../../packages/core/test-vectors/claim-message.json");

const CONTRACT: &str = "blindroll.test.near";
const TOKEN: &str = "usdc.test.near";
const OWNER: &str = "owner.test.near";
const RELAYER: &str = "relayer.test.near";
const CREATOR: &str = "creator.test.near";
const A1: &str = "approver1.test.near";
const A2: &str = "approver2.test.near";
const REFUND: &str = "treasury.test.near";
const STRANGER: &str = "stranger.test.near";

const NOW: u64 = 1_794_300_000_000;
const DEADLINE: u64 = 1_794_400_000_000;
const DEPOSIT: &str = "3ccf686b516ede32e2936c25798378623c99a5fce5bcee411d2df4b4f5fea1e0";
const HASH_AB: &str = "abababababababababababababababababababababababababababababababab";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}

fn builder(predecessor: &str, now_ms: u64, deposit: NearToken) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .block_timestamp(now_ms * 1_000_000)
        .attached_deposit(deposit)
        .account_balance(NearToken::from_near(10));
    b
}

fn ctx(predecessor: &str) {
    ctx_at(predecessor, NOW);
}

fn ctx_at(predecessor: &str, now_ms: u64) {
    testing_env!(builder(predecessor, now_ms, NearToken::from_yoctonear(0)).build());
}

fn ctx_deposit(predecessor: &str, deposit: NearToken) {
    testing_env!(builder(predecessor, NOW, deposit).build());
}

/// Context for a `#[private]` callback with one promise result.
fn ctx_callback(result: PromiseResult, now_ms: u64) {
    testing_env!(
        builder(CONTRACT, now_ms, NearToken::from_yoctonear(0)).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
}

fn merkle_vectors() -> Value {
    serde_json::from_str(MERKLE_JSON).unwrap()
}

fn claim_vectors() -> Value {
    serde_json::from_str(CLAIM_JSON).unwrap()
}

fn tree(name: &str) -> Value {
    merkle_vectors()["trees"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == name)
        .unwrap_or_else(|| panic!("no tree {name}"))
        .clone()
}

fn leaf_of(t: &Value, i: usize) -> Leaf {
    serde_json::from_value(t["leaves"][i].clone()).unwrap()
}

fn proof_of(t: &Value, i: usize) -> Vec<String> {
    serde_json::from_value(t["proofs"][i].clone()).unwrap()
}

fn strings(v: &Value) -> Vec<String> {
    serde_json::from_value(v.clone()).unwrap()
}

fn total_of(t: &Value) -> u128 {
    s(&t["total_amount"]).parse().unwrap()
}

fn new_contract() -> Blindroll {
    ctx(OWNER);
    Blindroll::new(acc(OWNER), acc(TOKEN), acc(RELAYER))
}

fn create(c: &mut Blindroll, t: &Value) {
    ctx_deposit(CREATOR, NearToken::from_near(1));
    c.create_run(
        s(&t["run_key"]).to_string(),
        vec![acc(A1), acc(A2)],
        2,
        s(&t["root"]).to_string(),
        HASH_AB.to_string(),
        t["leaves"].as_array().unwrap().len() as u32,
        U128(total_of(t)),
        DEADLINE,
        acc(REFUND),
    );
}

fn approve_both(c: &mut Blindroll, run_key: &str) {
    ctx(A1);
    c.approve_run(run_key.to_string());
    ctx(A2);
    c.approve_run(run_key.to_string());
}

fn fund(c: &mut Blindroll, run_key: &str, amount: u128) -> u128 {
    ctx(TOKEN);
    c.ft_on_transfer(
        acc(CREATOR),
        U128(amount),
        format!(r#"{{"fund_run":"{run_key}"}}"#),
    )
    .0
}

/// A funded, Active run built from a vector tree.
fn active(name: &str) -> (Blindroll, Value) {
    let mut c = new_contract();
    let t = tree(name);
    create(&mut c, &t);
    approve_both(&mut c, s(&t["run_key"]));
    assert_eq!(fund(&mut c, s(&t["run_key"]), total_of(&t)), 0);
    (c, t)
}

fn run_of(c: &Blindroll, t: &Value) -> RunView {
    c.get_run(s(&t["run_key"]).to_string()).unwrap()
}

fn near_ft(receiver: &str) -> Payout {
    Payout::NearFt {
        receiver: acc(receiver),
    }
}

fn claim_near_leaf(c: &mut Blindroll, t: &Value, i: usize, payout: Payout) {
    let leaf = leaf_of(t, i);
    ctx(&leaf.address.clone());
    c.claim_near(s(&t["run_key"]).to_string(), leaf, proof_of(t, i), payout)
        .detach();
}

struct EvmCase {
    tree: Value,
    index: usize,
    payout: Payout,
    destination_asset: String,
    destination_address: String,
    expires_at_ms: u64,
    signature: String,
    wrong_signer_signature: String,
}

fn evm_case(i: usize) -> EvmCase {
    let v = claim_vectors();
    let c = &v["cases"][i];
    let target = acc(s(&c["payout_target"]));
    EvmCase {
        tree: tree(s(&c["tree"])),
        index: c["leaf_index"].as_u64().unwrap() as usize,
        payout: match s(&c["payout_kind"]) {
            "near_ft" => Payout::NearFt { receiver: target },
            "oneclick" => Payout::OneClick {
                deposit_address: target,
            },
            other => panic!("unknown payout kind {other}"),
        },
        destination_asset: s(&c["destination_asset"]).to_string(),
        destination_address: s(&c["destination_address"]).to_string(),
        expires_at_ms: s(&c["expires_at_ms"]).parse().unwrap(),
        signature: s(&c["signature"]).to_string(),
        wrong_signer_signature: s(&c["wrong_signer_signature"]).to_string(),
    }
}

fn claim_evm_case(c: &mut Blindroll, e: &EvmCase) {
    c.claim_evm(
        s(&e.tree["run_key"]).to_string(),
        leaf_of(&e.tree, e.index),
        proof_of(&e.tree, e.index),
        e.payout.clone(),
        e.destination_asset.clone(),
        e.destination_address.clone(),
        e.expires_at_ms,
        e.signature.clone(),
    )
    .detach();
}

/// The `(method, args)` function calls this transaction scheduled on the token contract.
fn token_calls() -> Vec<(String, Value)> {
    get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id == acc(TOKEN))
        .flat_map(|r| r.actions)
        .filter_map(|a| match a {
            MockAction::FunctionCallWeight {
                method_name, args, ..
            } => Some((
                String::from_utf8(method_name).unwrap(),
                serde_json::from_slice(&args).unwrap(),
            )),
            _ => None,
        })
        .collect()
}

fn assert_paid(target: &str, amount: u128) {
    let calls = token_calls();
    assert_eq!(
        calls.len(),
        2,
        "expected storage_deposit + ft_transfer, got {calls:?}"
    );
    assert_eq!(calls[0].0, "storage_deposit");
    assert_eq!(calls[0].1["account_id"], target);
    assert_eq!(calls[0].1["registration_only"], true);
    assert_eq!(calls[1].0, "ft_transfer");
    assert_eq!(calls[1].1["receiver_id"], target);
    assert_eq!(calls[1].1["amount"], amount.to_string());
}

fn events() -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str(j).unwrap())
        .collect()
}

fn assert_invariants(r: &RunView) {
    assert!(r.claimed_amount.0 + r.reclaimed_amount.0 <= r.funded_amount.0);
    assert!(r.funded_amount.0 <= r.total_amount.0);
}

// ───────────── Shared vectors: leaf + Merkle ─────────────

#[test]
fn vectors_leaf_preimages_and_hashes_match_typescript() {
    ctx(OWNER);
    let v = merkle_vectors();
    let trees = v["trees"].as_array().unwrap();
    assert!(trees.len() >= 6);
    for t in trees {
        let run_key = s(&t["run_key"]);
        for (i, l) in t["leaves"].as_array().unwrap().iter().enumerate() {
            let (chain, address, amount, salt) = (
                s(&l["chain"]),
                s(&l["address"]),
                s(&l["amount"]),
                s(&l["salt_hex"]),
            );
            assert_eq!(
                merkle::leaf_preimage(run_key, chain, address, amount, salt).unwrap(),
                s(&t["preimages"][i]),
                "preimage {} #{i}",
                t["name"]
            );
            assert_eq!(
                to_hex(&merkle::leaf_hash(run_key, chain, address, amount, salt).unwrap()),
                s(&t["leaf_hashes"][i]),
                "leaf hash {} #{i}",
                t["name"]
            );
        }
    }
}

#[test]
fn vectors_roots_and_proofs_match_typescript() {
    ctx(OWNER);
    for t in merkle_vectors()["trees"].as_array().unwrap() {
        let root = from_hex::<32>(s(&t["root"])).unwrap();
        let hashes: Vec<[u8; 32]> = strings(&t["leaf_hashes"])
            .iter()
            .map(|h| from_hex::<32>(h).unwrap())
            .collect();
        // Rebuild the root independently of the proofs.
        let mut level = hashes.clone();
        while level.len() > 1 {
            level = level
                .chunks(2)
                .map(|c| {
                    if c.len() == 2 {
                        merkle::hash_pair(&c[0], &c[1])
                    } else {
                        c[0]
                    }
                })
                .collect();
        }
        assert_eq!(level[0], root, "root {}", t["name"]);
        for (i, h) in hashes.iter().enumerate() {
            let proof = proof_of(t, i);
            assert!(
                merkle::verify_proof(h, &proof, &root),
                "proof {} #{i}",
                t["name"]
            );
        }
    }
}

#[test]
fn vectors_single_leaf_tree_has_empty_proof() {
    ctx(OWNER);
    let t = tree("single");
    assert_eq!(t["root"], t["leaf_hashes"][0]);
    assert!(proof_of(&t, 0).is_empty());
}

#[test]
fn vectors_invalid_leaves_are_rejected() {
    ctx(OWNER);
    let v = merkle_vectors();
    let bad = v["invalid_leaves"].as_array().unwrap();
    assert!(bad.len() >= 25);
    for l in bad {
        let r = merkle::leaf_hash(
            s(&l["run_key"]),
            s(&l["chain"]),
            s(&l["address"]),
            s(&l["amount"]),
            s(&l["salt_hex"]),
        );
        assert!(r.is_err(), "should reject: {}", l["reason"]);
    }
}

#[test]
fn vectors_invalid_proofs_are_rejected() {
    ctx(OWNER);
    let v = merkle_vectors();
    let bad = v["invalid_proofs"].as_array().unwrap();
    assert!(bad.len() >= 8);
    for p in bad {
        let t = tree(s(&p["tree"]));
        let i = p["leaf_index"].as_u64().unwrap() as usize;
        let leaf = from_hex::<32>(s(&t["leaf_hashes"][i])).unwrap();
        let root = from_hex::<32>(s(&t["root"])).unwrap();
        assert!(
            !merkle::verify_proof(&leaf, &strings(&p["proof"]), &root),
            "should reject: {}",
            p["reason"]
        );
    }
}

#[test]
fn proof_longer_than_cap_is_rejected() {
    ctx(OWNER);
    let proof = vec![HASH_AB.to_string(); merkle::MAX_PROOF_LEN + 1];
    assert!(merkle::compute_root(&[1u8; 32], &proof).is_none());
}

// ───────────── Shared vectors: claim message + signature ─────────────

fn message_from(c: &Value) -> Result<String, &'static str> {
    let contract_id = s(&c["contract_id"])
        .parse::<AccountId>()
        .map_err(|_| "bad contract_id")?;
    let target = s(&c["payout_target"])
        .parse::<AccountId>()
        .map_err(|_| "bad payout_target")?;
    let expires = s(&c["expires_at_ms"])
        .parse::<u64>()
        .map_err(|_| "bad expires")?;
    sig::build_claim_message(
        &contract_id,
        s(&c["run_key"]),
        s(&c["leaf_hash"]),
        s(&c["payout_kind"]),
        &target,
        s(&c["destination_asset"]),
        s(&c["destination_address"]),
        expires,
    )
}

#[test]
fn vectors_claim_messages_hashes_and_signers_match_typescript() {
    ctx(OWNER);
    let v = claim_vectors();
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 2);
    for c in cases {
        let message = message_from(c).unwrap();
        assert_eq!(message, s(&c["message"]), "message {}", c["name"]);
        assert_eq!(to_hex(&sig::eip191_hash(&message)), s(&c["eip191_hash"]));
        assert_eq!(
            sig::recover_evm_address(&message, s(&c["signature"])).unwrap(),
            s(&c["signer_address"])
        );
        let other = sig::recover_evm_address(&message, s(&c["wrong_signer_signature"])).unwrap();
        assert_ne!(other, s(&c["signer_address"]));
    }
}

#[test]
fn vectors_invalid_claim_messages_are_rejected() {
    ctx(OWNER);
    let v = claim_vectors();
    let bad = v["invalid_messages"].as_array().unwrap();
    assert!(bad.len() >= 15);
    for c in bad {
        assert!(message_from(c).is_err(), "should reject: {}", c["reason"]);
    }
}

#[test]
fn malformed_signatures_are_rejected() {
    ctx(OWNER);
    let v = claim_vectors();
    let c = &v["cases"][0];
    let good = s(&c["signature"]);
    let msg = s(&c["message"]);
    assert!(
        sig::recover_evm_address(msg, &good[2..]).is_none(),
        "missing 0x"
    );
    assert!(
        sig::recover_evm_address(msg, &good[..good.len() - 2]).is_none(),
        "too short"
    );
    assert!(
        sig::recover_evm_address(msg, &good.to_uppercase()).is_none(),
        "uppercase"
    );
    let bad_v = format!("{}1d", &good[..good.len() - 2]);
    assert!(sig::recover_evm_address(msg, &bad_v).is_none(), "v = 29");
    // A different message recovers a different address.
    let other = sig::recover_evm_address(&format!("{msg} "), good);
    assert_ne!(other.as_deref(), Some(s(&c["signer_address"])));
}

// ───────────── create_run ─────────────

#[test]
fn create_run_stores_draft_and_emits_event() {
    let mut c = new_contract();
    let t = tree("sample-run");
    create(&mut c, &t);
    let ev = events();
    assert_eq!(ev[0]["standard"], "blindroll");
    assert_eq!(ev[0]["event"], "run_created");
    assert_eq!(ev[0]["data"][0]["merkle_root"], t["root"]);
    assert_eq!(ev[0]["data"][0]["total_amount"], "14600500000");

    let r = run_of(&c, &t);
    assert_eq!(r.status, RunStatus::Draft);
    assert_eq!(r.creator, acc(CREATOR));
    assert_eq!(r.merkle_root, s(&t["root"]));
    assert_eq!(r.report_hash, HASH_AB);
    assert_eq!(r.total_amount.0, 14_600_500_000);
    assert_eq!(r.recipient_count, 6);
    assert_eq!(r.funded_amount.0, 0);
    assert_eq!(c.get_runs_by_approver(acc(A1), None, None).len(), 1);
    assert_eq!(c.get_runs_by_approver(acc(STRANGER), None, None).len(), 0);
}

#[test]
fn create_run_refunds_unused_deposit() {
    let mut c = new_contract();
    create(&mut c, &tree("sample-run"));
    let refunds: Vec<NearToken> = get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id == acc(CREATOR))
        .flat_map(|r| r.actions)
        .filter_map(|a| match a {
            MockAction::Transfer { deposit, .. } => Some(deposit),
            _ => None,
        })
        .collect();
    assert_eq!(refunds.len(), 1);
    let charged = NearToken::from_near(1).saturating_sub(refunds[0]);
    // 6 recipients × (0.001 + 0.00125) NEAR plus the run's own storage.
    assert!(charged > NearToken::from_yoctonear(13_500_000_000_000_000_000_000));
    assert!(charged < NearToken::from_millinear(40), "charged {charged}");
}

fn create_with(c: &mut Blindroll, f: impl FnOnce(&mut CreateArgs)) {
    let t = tree("pair");
    let mut a = CreateArgs {
        run_key: s(&t["run_key"]).to_string(),
        approvers: vec![acc(A1), acc(A2)],
        threshold: 2,
        root: s(&t["root"]).to_string(),
        report: HASH_AB.to_string(),
        count: 2,
        total: total_of(&t),
        deadline: DEADLINE,
        deposit: NearToken::from_near(1),
    };
    f(&mut a);
    ctx_deposit(CREATOR, a.deposit);
    c.create_run(
        a.run_key,
        a.approvers,
        a.threshold,
        a.root,
        a.report,
        a.count,
        U128(a.total),
        a.deadline,
        acc(REFUND),
    );
}

struct CreateArgs {
    run_key: String,
    approvers: Vec<AccountId>,
    threshold: u8,
    root: String,
    report: String,
    count: u32,
    total: u128,
    deadline: u64,
    deposit: NearToken,
}

#[test]
#[should_panic(expected = "run_key already exists")]
fn create_run_rejects_duplicate_key() {
    let mut c = new_contract();
    create_with(&mut c, |_| {});
    create_with(&mut c, |_| {});
}

#[test]
#[should_panic(expected = "run_key must match")]
fn create_run_rejects_pipe_in_key() {
    create_with(&mut new_contract(), |a| a.run_key = "run|1".into());
}

#[test]
#[should_panic(expected = "run_key must match")]
fn create_run_rejects_newline_in_key() {
    create_with(&mut new_contract(), |a| a.run_key = "run\n1".into());
}

#[test]
#[should_panic(expected = "run_key must match")]
fn create_run_rejects_long_key() {
    create_with(&mut new_contract(), |a| a.run_key = "r".repeat(65));
}

#[test]
#[should_panic(expected = "approvers must contain 1 to 10")]
fn create_run_rejects_no_approvers() {
    create_with(&mut new_contract(), |a| a.approvers = vec![]);
}

#[test]
#[should_panic(expected = "approvers must contain 1 to 10")]
fn create_run_rejects_eleven_approvers() {
    create_with(&mut new_contract(), |a| {
        a.approvers = (0..11).map(|i| acc(&format!("a{i}.test.near"))).collect()
    });
}

#[test]
#[should_panic(expected = "approvers must be unique")]
fn create_run_rejects_duplicate_approvers() {
    create_with(&mut new_contract(), |a| {
        a.approvers = vec![acc(A1), acc(A1)]
    });
}

#[test]
#[should_panic(expected = "threshold must be between")]
fn create_run_rejects_zero_threshold() {
    create_with(&mut new_contract(), |a| a.threshold = 0);
}

#[test]
#[should_panic(expected = "threshold must be between")]
fn create_run_rejects_threshold_above_approvers() {
    create_with(&mut new_contract(), |a| a.threshold = 3);
}

#[test]
#[should_panic(expected = "merkle_root_hex must be 64 lowercase hex")]
fn create_run_rejects_bad_root() {
    create_with(&mut new_contract(), |a| a.root = "xyz".into());
}

#[test]
#[should_panic(expected = "report_hash_hex must be 64 lowercase hex")]
fn create_run_rejects_uppercase_report_hash() {
    create_with(&mut new_contract(), |a| a.report = HASH_AB.to_uppercase());
}

#[test]
#[should_panic(expected = "total_amount must be greater than 0")]
fn create_run_rejects_zero_total() {
    create_with(&mut new_contract(), |a| a.total = 0);
}

#[test]
#[should_panic(expected = "recipient_count must be at least 1")]
fn create_run_rejects_zero_recipients() {
    create_with(&mut new_contract(), |a| a.count = 0);
}

#[test]
#[should_panic(expected = "claim_deadline_ms must be in the future")]
fn create_run_rejects_past_deadline() {
    create_with(&mut new_contract(), |a| a.deadline = NOW);
}

#[test]
#[should_panic(expected = "yoctoNEAR for storage")]
fn create_run_rejects_insufficient_deposit() {
    create_with(&mut new_contract(), |a| {
        a.deposit = NearToken::from_yoctonear(1)
    });
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn create_run_rejects_when_paused() {
    let mut c = new_contract();
    c.set_paused(true);
    create_with(&mut c, |_| {});
}

// ───────────── Admin ─────────────

#[test]
fn owner_can_update_relayer_and_pause() {
    let mut c = new_contract();
    c.set_relayer(acc(STRANGER));
    c.set_paused(true);
    let cfg = c.get_config();
    assert_eq!(cfg.relayer, acc(STRANGER));
    assert_eq!(cfg.token_id, acc(TOKEN));
    assert!(cfg.paused);
}

#[test]
#[should_panic(expected = "Only the owner")]
fn stranger_cannot_pause() {
    let mut c = new_contract();
    ctx(STRANGER);
    c.set_paused(true);
}

#[test]
#[should_panic(expected = "Only the owner")]
fn stranger_cannot_set_relayer() {
    let mut c = new_contract();
    ctx(STRANGER);
    c.set_relayer(acc(STRANGER));
}

// ───────────── approve_run / cancel_run ─────────────

#[test]
fn approvals_reach_threshold() {
    let mut c = new_contract();
    let t = tree("pair");
    create(&mut c, &t);
    ctx(A1);
    c.approve_run(s(&t["run_key"]).to_string());
    let r = run_of(&c, &t);
    assert_eq!(r.status, RunStatus::Draft);
    assert_eq!(r.approvals, vec![acc(A1)]);
    ctx(A2);
    c.approve_run(s(&t["run_key"]).to_string());
    assert_eq!(run_of(&c, &t).status, RunStatus::Approved);
    let ev = events();
    assert_eq!(ev[0]["event"], "run_approved");
    assert_eq!(ev[0]["data"][0]["approvals"], 2);
    assert_eq!(ev[0]["data"][0]["status"], "Approved");
}

#[test]
#[should_panic(expected = "Only an approver")]
fn stranger_cannot_approve() {
    let mut c = new_contract();
    let t = tree("pair");
    create(&mut c, &t);
    ctx(STRANGER);
    c.approve_run(s(&t["run_key"]).to_string());
}

#[test]
#[should_panic(expected = "Only an approver")]
fn creator_who_is_not_an_approver_cannot_approve() {
    let mut c = new_contract();
    let t = tree("pair");
    create(&mut c, &t);
    ctx(CREATOR);
    c.approve_run(s(&t["run_key"]).to_string());
}

#[test]
#[should_panic(expected = "Already approved")]
fn approver_cannot_approve_twice() {
    let mut c = new_contract();
    let t = tree("pair");
    create(&mut c, &t);
    ctx(A1);
    c.approve_run(s(&t["run_key"]).to_string());
    c.approve_run(s(&t["run_key"]).to_string());
}

#[test]
#[should_panic(expected = "Run not found")]
fn approve_unknown_run_fails() {
    let mut c = new_contract();
    ctx(A1);
    c.approve_run("nope".to_string());
}

#[test]
fn approver_can_cancel_unfunded_run() {
    let mut c = new_contract();
    let t = tree("pair");
    create(&mut c, &t);
    approve_both(&mut c, s(&t["run_key"]));
    ctx(A2);
    c.cancel_run(s(&t["run_key"]).to_string());
    assert_eq!(run_of(&c, &t).status, RunStatus::Cancelled);
    // Funding a cancelled run returns everything.
    assert_eq!(fund(&mut c, s(&t["run_key"]), 500), 500);
}

#[test]
#[should_panic(expected = "already has funds")]
fn cannot_cancel_partially_funded_run() {
    let mut c = new_contract();
    let t = tree("pair");
    create(&mut c, &t);
    approve_both(&mut c, s(&t["run_key"]));
    fund(&mut c, s(&t["run_key"]), 1);
    ctx(A1);
    c.cancel_run(s(&t["run_key"]).to_string());
}

#[test]
#[should_panic(expected = "Only Draft or Approved")]
fn cannot_cancel_active_run() {
    let (mut c, t) = active("pair");
    ctx(A1);
    c.cancel_run(s(&t["run_key"]).to_string());
}

#[test]
#[should_panic(expected = "Only an approver")]
fn stranger_cannot_cancel() {
    let mut c = new_contract();
    let t = tree("pair");
    create(&mut c, &t);
    ctx(STRANGER);
    c.cancel_run(s(&t["run_key"]).to_string());
}

// ───────────── Funding (invariants 1 and 4) ─────────────

#[test]
#[should_panic(expected = "Only the configured token can fund runs")]
fn other_tokens_cannot_fund() {
    let mut c = new_contract();
    let t = tree("pair");
    create(&mut c, &t);
    approve_both(&mut c, s(&t["run_key"]));
    ctx("fake-usdc.test.near");
    c.ft_on_transfer(
        acc(CREATOR),
        U128(100),
        r#"{"fund_run":"run_pair"}"#.to_string(),
    );
}

#[test]
fn funding_a_draft_run_returns_everything() {
    let mut c = new_contract();
    let t = tree("pair");
    create(&mut c, &t);
    assert_eq!(fund(&mut c, s(&t["run_key"]), 777), 777);
    assert_eq!(run_of(&c, &t).funded_amount.0, 0);
}

#[test]
fn funding_in_parts_activates_and_returns_excess() {
    let mut c = new_contract();
    let t = tree("sample-run");
    let key = s(&t["run_key"]);
    create(&mut c, &t);
    approve_both(&mut c, key);

    assert_eq!(fund(&mut c, key, 600_500_000), 0);
    let r = run_of(&c, &t);
    assert_eq!(r.status, RunStatus::Approved);
    assert_eq!(r.funded_amount.0, 600_500_000);
    assert_invariants(&r);

    // 15,000 USDC sent, only the missing 14,000 is accepted.
    assert_eq!(fund(&mut c, key, 15_000_000_000), 1_000_000_000);
    let ev = events();
    assert_eq!(ev[0]["event"], "run_funded");
    assert_eq!(ev[0]["data"][0]["amount"], "14000000000");
    assert_eq!(ev[0]["data"][0]["status"], "Active");
    let r = run_of(&c, &t);
    assert_eq!(r.status, RunStatus::Active);
    assert_eq!(r.funded_amount.0, r.total_amount.0);
    assert_invariants(&r);

    // An Active run accepts nothing more.
    assert_eq!(fund(&mut c, key, 5), 5);
    assert_eq!(run_of(&c, &t).funded_amount.0, 14_600_500_000);
}

#[test]
fn bad_funding_messages_return_everything() {
    let mut c = new_contract();
    let t = tree("pair");
    create(&mut c, &t);
    approve_both(&mut c, s(&t["run_key"]));
    ctx(TOKEN);
    for msg in [
        "",
        "run_pair",
        "{}",
        r#"{"fund_run":"unknown-run"}"#,
        r#"{"fund_run":"run_pair","extra":1}"#,
        r#"{"fund_run":42}"#,
    ] {
        assert_eq!(
            c.ft_on_transfer(acc(CREATOR), U128(9), msg.to_string()).0,
            9,
            "msg {msg:?}"
        );
    }
    assert_eq!(run_of(&c, &t).funded_amount.0, 0);
}

#[test]
fn funding_while_paused_or_after_deadline_returns_everything() {
    let mut c = new_contract();
    let t = tree("pair");
    let key = s(&t["run_key"]);
    create(&mut c, &t);
    approve_both(&mut c, key);
    ctx(OWNER);
    c.set_paused(true);
    assert_eq!(fund(&mut c, key, 10), 10);
    ctx(OWNER);
    c.set_paused(false);
    ctx_at(TOKEN, DEADLINE + 1);
    let unused = c.ft_on_transfer(
        acc(CREATOR),
        U128(10),
        r#"{"fund_run":"run_pair"}"#.to_string(),
    );
    assert_eq!(unused.0, 10);
}

// ───────────── claim_near ─────────────

#[test]
fn near_recipient_claims_to_own_account() {
    let (mut c, t) = active("claim-demo");
    let leaf_hash = s(&t["leaf_hashes"][1]).to_string();
    let key = s(&t["run_key"]).to_string();
    assert!(!c.is_claimed(key.clone(), leaf_hash.clone()));

    claim_near_leaf(&mut c, &t, 1, near_ft("ben.test.near"));
    assert_paid("ben.test.near", 800_000_000);
    assert!(c.is_claimed(key.clone(), leaf_hash.clone()));
    let r = run_of(&c, &t);
    assert_eq!(r.claimed_amount.0, 800_000_000);
    assert_invariants(&r);

    ctx_callback(PromiseResult::Successful(vec![]), NOW);
    assert!(c.on_payout(key.clone(), leaf_hash.clone(), "near_ft".into()));
    let ev = events();
    assert_eq!(ev[0]["event"], "claimed");
    assert_eq!(ev[0]["data"][0]["leaf_hash"], leaf_hash);
    assert_eq!(ev[0]["data"][0]["payout_kind"], "near_ft");
    assert!(
        ev[0]["data"][0].get("amount").is_none(),
        "claimed event must not carry the amount"
    );
    assert!(c.is_claimed(key, leaf_hash));
}

#[test]
fn near_recipient_can_choose_oneclick_or_another_receiver() {
    let (mut c, t) = active("claim-demo");
    let deposit = "3ccf686b516ede32e2936c25798378623c99a5fce5bcee411d2df4b4f5fea1e0";
    claim_near_leaf(
        &mut c,
        &t,
        3,
        Payout::OneClick {
            deposit_address: acc(deposit),
        },
    );
    assert_paid(deposit, 1_050_000_000);
}

#[test]
#[should_panic(expected = "Only the recipient account can claim this leaf")]
fn near_claim_by_another_account_fails() {
    let (mut c, t) = active("claim-demo");
    ctx(STRANGER);
    c.claim_near(
        s(&t["run_key"]).to_string(),
        leaf_of(&t, 1),
        proof_of(&t, 1),
        near_ft(STRANGER),
    )
    .detach();
}

#[test]
#[should_panic(expected = "Only the recipient account can claim this leaf")]
fn relayer_cannot_claim_near_leaf_for_the_recipient() {
    let (mut c, t) = active("claim-demo");
    ctx(RELAYER);
    c.claim_near(
        s(&t["run_key"]).to_string(),
        leaf_of(&t, 1),
        proof_of(&t, 1),
        near_ft("ben.test.near"),
    )
    .detach();
}

#[test]
#[should_panic(expected = "claim_near requires a near leaf")]
fn claim_near_rejects_evm_leaf() {
    let (mut c, t) = active("claim-demo");
    ctx(STRANGER);
    c.claim_near(
        s(&t["run_key"]).to_string(),
        leaf_of(&t, 0),
        proof_of(&t, 0),
        near_ft(STRANGER),
    )
    .detach();
}

#[test]
#[should_panic(expected = "This leaf has already been claimed")]
fn leaf_cannot_be_claimed_twice() {
    let (mut c, t) = active("claim-demo");
    claim_near_leaf(&mut c, &t, 1, near_ft("ben.test.near"));
    claim_near_leaf(&mut c, &t, 1, near_ft("ben.test.near"));
}

#[test]
#[should_panic(expected = "Invalid Merkle proof")]
fn claim_with_inflated_amount_fails() {
    let (mut c, t) = active("claim-demo");
    let mut leaf = leaf_of(&t, 1);
    leaf.amount = "800000001".into();
    ctx("ben.test.near");
    c.claim_near(
        s(&t["run_key"]).to_string(),
        leaf,
        proof_of(&t, 1),
        near_ft("ben.test.near"),
    )
    .detach();
}

#[test]
#[should_panic(expected = "Invalid Merkle proof")]
fn claim_with_wrong_proof_fails() {
    let (mut c, t) = active("claim-demo");
    ctx("ben.test.near");
    c.claim_near(
        s(&t["run_key"]).to_string(),
        leaf_of(&t, 1),
        proof_of(&t, 3),
        near_ft("ben.test.near"),
    )
    .detach();
}

#[test]
#[should_panic(expected = "amount must be a canonical positive decimal string")]
fn claim_with_non_canonical_amount_fails() {
    let (mut c, t) = active("claim-demo");
    let mut leaf = leaf_of(&t, 1);
    leaf.amount = "0800000000".into();
    ctx("ben.test.near");
    c.claim_near(
        s(&t["run_key"]).to_string(),
        leaf,
        proof_of(&t, 1),
        near_ft("ben.test.near"),
    )
    .detach();
}

#[test]
#[should_panic(expected = "Run is not Active")]
fn claim_before_funding_fails() {
    let mut c = new_contract();
    let t = tree("claim-demo");
    create(&mut c, &t);
    approve_both(&mut c, s(&t["run_key"]));
    claim_near_leaf(&mut c, &t, 1, near_ft("ben.test.near"));
}

#[test]
#[should_panic(expected = "Claim deadline has passed")]
fn claim_after_deadline_fails() {
    let (mut c, t) = active("claim-demo");
    ctx_at("ben.test.near", DEADLINE + 1);
    c.claim_near(
        s(&t["run_key"]).to_string(),
        leaf_of(&t, 1),
        proof_of(&t, 1),
        near_ft("ben.test.near"),
    )
    .detach();
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn claim_while_paused_fails() {
    let (mut c, t) = active("claim-demo");
    ctx(OWNER);
    c.set_paused(true);
    claim_near_leaf(&mut c, &t, 1, near_ft("ben.test.near"));
}

#[test]
#[should_panic(expected = "below the reserve")]
fn claim_fails_when_contract_balance_is_below_reserve() {
    let (mut c, t) = active("claim-demo");
    let mut b = builder("ben.test.near", NOW, NearToken::from_yoctonear(0));
    b.account_balance(NearToken::from_millinear(50));
    testing_env!(b.build());
    c.claim_near(
        s(&t["run_key"]).to_string(),
        leaf_of(&t, 1),
        proof_of(&t, 1),
        near_ft("ben.test.near"),
    )
    .detach();
}

// ───────────── claim_near_relayed (gas-free NEAR claim) ─────────────

fn relayed(c: &mut Blindroll, caller: &str, t: &Value, leaf: Leaf, proof_index: usize) {
    ctx(caller);
    c.claim_near_relayed(s(&t["run_key"]).to_string(), leaf, proof_of(t, proof_index))
        .detach();
}

#[test]
fn relayer_claims_for_near_recipient_and_pays_only_the_leaf_account() {
    let (mut c, t) = active("claim-demo");
    let leaf_hash = s(&t["leaf_hashes"][1]).to_string();
    let key = s(&t["run_key"]).to_string();

    relayed(&mut c, RELAYER, &t, leaf_of(&t, 1), 1);
    // The relayer signed the transaction, but the USDC goes to the leaf's account.
    assert_paid("ben.test.near", 800_000_000);
    assert!(c.is_claimed(key.clone(), leaf_hash.clone()));
    let r = run_of(&c, &t);
    assert_eq!(r.claimed_amount.0, 800_000_000);
    assert_invariants(&r);

    ctx_callback(PromiseResult::Successful(vec![]), NOW);
    assert!(c.on_payout(key, leaf_hash, "near_ft".into()));
    assert_eq!(events()[0]["event"], "claimed");
    assert_eq!(events()[0]["data"][0]["payout_kind"], "near_ft");
}

#[test]
#[should_panic(expected = "Only the relayer can call this")]
fn relayed_claim_by_a_stranger_fails() {
    let (mut c, t) = active("claim-demo");
    relayed(&mut c, STRANGER, &t, leaf_of(&t, 1), 1);
}

#[test]
#[should_panic(expected = "Only the relayer can call this")]
fn relayed_claim_by_the_recipient_fails() {
    let (mut c, t) = active("claim-demo");
    relayed(&mut c, "ben.test.near", &t, leaf_of(&t, 1), 1);
}

#[test]
#[should_panic(expected = "Only the relayer can call this")]
fn relayed_claim_by_the_owner_fails() {
    let (mut c, t) = active("claim-demo");
    relayed(&mut c, OWNER, &t, leaf_of(&t, 1), 1);
}

#[test]
#[should_panic(expected = "Only the relayer can call this")]
fn relayed_claim_by_a_replaced_relayer_fails() {
    let (mut c, t) = active("claim-demo");
    ctx(OWNER);
    c.set_relayer(acc("relayer2.test.near"));
    relayed(&mut c, RELAYER, &t, leaf_of(&t, 1), 1);
}

#[test]
#[should_panic(expected = "claim_near_relayed requires a near leaf")]
fn relayed_claim_rejects_evm_leaf() {
    let (mut c, t) = active("claim-demo");
    relayed(&mut c, RELAYER, &t, leaf_of(&t, 0), 0);
}

#[test]
#[should_panic(expected = "Invalid Merkle proof")]
fn relayed_claim_cannot_redirect_by_changing_the_leaf_address() {
    let (mut c, t) = active("claim-demo");
    let mut leaf = leaf_of(&t, 1);
    leaf.address = RELAYER.into();
    relayed(&mut c, RELAYER, &t, leaf, 1);
}

#[test]
#[should_panic(expected = "Invalid Merkle proof")]
fn relayed_claim_with_inflated_amount_fails() {
    let (mut c, t) = active("claim-demo");
    let mut leaf = leaf_of(&t, 1);
    leaf.amount = "800000001".into();
    relayed(&mut c, RELAYER, &t, leaf, 1);
}

#[test]
#[should_panic(expected = "This leaf has already been claimed")]
fn relayed_claim_after_a_direct_claim_fails() {
    let (mut c, t) = active("claim-demo");
    claim_near_leaf(&mut c, &t, 1, near_ft("ben.test.near"));
    relayed(&mut c, RELAYER, &t, leaf_of(&t, 1), 1);
}

#[test]
#[should_panic(expected = "This leaf has already been claimed")]
fn direct_claim_after_a_relayed_claim_fails() {
    let (mut c, t) = active("claim-demo");
    relayed(&mut c, RELAYER, &t, leaf_of(&t, 1), 1);
    claim_near_leaf(&mut c, &t, 1, near_ft("ben.test.near"));
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn relayed_claim_while_paused_fails() {
    let (mut c, t) = active("claim-demo");
    ctx(OWNER);
    c.set_paused(true);
    relayed(&mut c, RELAYER, &t, leaf_of(&t, 1), 1);
}

#[test]
#[should_panic(expected = "Claim deadline has passed")]
fn relayed_claim_after_deadline_fails() {
    let (mut c, t) = active("claim-demo");
    ctx_at(RELAYER, DEADLINE + 1);
    c.claim_near_relayed(
        s(&t["run_key"]).to_string(),
        leaf_of(&t, 1),
        proof_of(&t, 1),
    )
    .detach();
}

#[test]
#[should_panic(expected = "Run is not Active")]
fn relayed_claim_before_funding_fails() {
    let mut c = new_contract();
    let t = tree("claim-demo");
    create(&mut c, &t);
    approve_both(&mut c, s(&t["run_key"]));
    relayed(&mut c, RELAYER, &t, leaf_of(&t, 1), 1);
}

#[test]
#[should_panic(expected = "Only oneclick payouts can be reopened")]
fn relayed_claim_cannot_be_reopened() {
    let (mut c, t) = active("claim-demo");
    let key = s(&t["run_key"]).to_string();
    let leaf_hash = s(&t["leaf_hashes"][1]).to_string();
    relayed(&mut c, RELAYER, &t, leaf_of(&t, 1), 1);
    ctx_callback(PromiseResult::Successful(vec![]), NOW);
    c.on_payout(key.clone(), leaf_hash.clone(), "near_ft".into());
    ctx(A1);
    c.reopen_claim(key, leaf_hash);
}

#[test]
fn failed_relayed_payout_releases_the_leaf() {
    let (mut c, t) = active("claim-demo");
    let key = s(&t["run_key"]).to_string();
    let leaf_hash = s(&t["leaf_hashes"][1]).to_string();
    relayed(&mut c, RELAYER, &t, leaf_of(&t, 1), 1);
    ctx_callback(PromiseResult::Failed, NOW);
    assert!(!c.on_payout(key.clone(), leaf_hash.clone(), "near_ft".into()));
    assert!(!c.is_claimed(key, leaf_hash));
    assert_eq!(run_of(&c, &t).claimed_amount.0, 0);
}

// ───────────── claim_evm (invariant 5) ─────────────

#[test]
fn evm_recipient_claims_near_ft_via_relayer() {
    let (mut c, _) = active("claim-demo");
    let e = evm_case(0);
    ctx(RELAYER);
    claim_evm_case(&mut c, &e);
    assert_paid("asha.test.near", 1_200_500_000);
    let r = run_of(&c, &e.tree);
    assert_eq!(r.claimed_amount.0, 1_200_500_000);
    assert_invariants(&r);
    assert!(c.is_claimed(
        s(&e.tree["run_key"]).to_string(),
        s(&e.tree["leaf_hashes"][0]).to_string()
    ));
}

#[test]
fn evm_recipient_claims_oneclick_and_anyone_may_submit() {
    let (mut c, _) = active("claim-demo");
    let e = evm_case(1);
    ctx(STRANGER);
    claim_evm_case(&mut c, &e);
    assert_paid(
        "3ccf686b516ede32e2936c25798378623c99a5fce5bcee411d2df4b4f5fea1e0",
        950_000_000,
    );
}

#[test]
#[should_panic(expected = "Signature does not match the leaf address")]
fn evm_claim_signed_by_another_key_fails() {
    let (mut c, _) = active("claim-demo");
    let mut e = evm_case(0);
    e.signature = e.wrong_signer_signature.clone();
    ctx(RELAYER);
    claim_evm_case(&mut c, &e);
}

#[test]
#[should_panic(expected = "Signature does not match the leaf address")]
fn relayer_cannot_redirect_payout_target() {
    let (mut c, _) = active("claim-demo");
    let mut e = evm_case(0);
    e.payout = near_ft(RELAYER);
    ctx(RELAYER);
    claim_evm_case(&mut c, &e);
}

#[test]
#[should_panic(expected = "Signature does not match the leaf address")]
fn relayer_cannot_change_payout_kind() {
    let (mut c, _) = active("claim-demo");
    let mut e = evm_case(0);
    e.payout = Payout::OneClick {
        deposit_address: acc("asha.test.near"),
    };
    ctx(RELAYER);
    claim_evm_case(&mut c, &e);
}

#[test]
#[should_panic(expected = "Signature does not match the leaf address")]
fn relayer_cannot_change_destination() {
    let (mut c, _) = active("claim-demo");
    let mut e = evm_case(1);
    e.destination_address = "0x000000000000000000000000000000000000dead".into();
    ctx(RELAYER);
    claim_evm_case(&mut c, &e);
}

#[test]
#[should_panic(expected = "Signature does not match the leaf address")]
fn relayer_cannot_extend_expiry() {
    let (mut c, _) = active("claim-demo");
    let mut e = evm_case(0);
    e.expires_at_ms += 1;
    ctx(RELAYER);
    claim_evm_case(&mut c, &e);
}

#[test]
#[should_panic(expected = "Signature does not match the leaf address")]
fn signature_for_another_contract_fails() {
    let (mut c, _) = active("claim-demo");
    let e = evm_case(0);
    let mut b = builder(RELAYER, NOW, NearToken::from_yoctonear(0));
    b.current_account_id(acc("blindroll-copy.test.near"));
    testing_env!(b.build());
    claim_evm_case(&mut c, &e);
}

#[test]
#[should_panic(expected = "Signature does not match the leaf address")]
fn signature_cannot_be_reused_for_another_leaf() {
    let (mut c, _) = active("claim-demo");
    let mut e = evm_case(0);
    e.index = 4; // another EVM leaf in the same run
    ctx(RELAYER);
    claim_evm_case(&mut c, &e);
}

#[test]
#[should_panic(expected = "Claim signature has expired")]
fn expired_evm_claim_fails() {
    let (mut c, _) = active("claim-demo");
    let mut e = evm_case(0);
    e.expires_at_ms = NOW - 1;
    ctx(RELAYER);
    claim_evm_case(&mut c, &e);
}

#[test]
#[should_panic(expected = "claim_evm requires an evm leaf")]
fn claim_evm_rejects_near_leaf() {
    let (mut c, _) = active("claim-demo");
    let mut e = evm_case(0);
    e.index = 1;
    ctx(RELAYER);
    claim_evm_case(&mut c, &e);
}

#[test]
#[should_panic(expected = "destination_address must be")]
fn claim_evm_rejects_newline_in_destination() {
    let (mut c, _) = active("claim-demo");
    let mut e = evm_case(0);
    e.destination_address = "asha.test.near\nexpires: 9999999999999".into();
    ctx(RELAYER);
    claim_evm_case(&mut c, &e);
}

#[test]
#[should_panic(expected = "destination_asset must be")]
fn claim_evm_rejects_pipe_in_destination_asset() {
    let (mut c, _) = active("claim-demo");
    let mut e = evm_case(0);
    e.destination_asset = "nep141|usdc".into();
    ctx(RELAYER);
    claim_evm_case(&mut c, &e);
}

#[test]
#[should_panic(expected = "Invalid signature")]
fn claim_evm_rejects_malformed_signature() {
    let (mut c, _) = active("claim-demo");
    let mut e = evm_case(0);
    e.signature = "0x1234".into();
    ctx(RELAYER);
    claim_evm_case(&mut c, &e);
}

#[test]
#[should_panic(expected = "This leaf has already been claimed")]
fn evm_signature_cannot_be_replayed() {
    let (mut c, _) = active("claim-demo");
    let e = evm_case(0);
    ctx(RELAYER);
    claim_evm_case(&mut c, &e);
    claim_evm_case(&mut c, &e);
}

// ───────────── Failed payout, reopen (invariant 2) ─────────────

#[test]
fn failed_payout_is_rolled_back_and_can_be_retried() {
    let (mut c, t) = active("claim-demo");
    let key = s(&t["run_key"]).to_string();
    let leaf_hash = s(&t["leaf_hashes"][1]).to_string();
    claim_near_leaf(&mut c, &t, 1, near_ft("ben.test.near"));

    ctx_callback(PromiseResult::Failed, NOW);
    assert!(!c.on_payout(key.clone(), leaf_hash.clone(), "near_ft".into()));
    assert_eq!(events()[0]["event"], "claim_failed");
    assert!(!c.is_claimed(key.clone(), leaf_hash.clone()));
    assert_eq!(run_of(&c, &t).claimed_amount.0, 0);

    claim_near_leaf(&mut c, &t, 1, near_ft("ben.test.near"));
    assert_paid("ben.test.near", 800_000_000);
    assert_eq!(run_of(&c, &t).claimed_amount.0, 800_000_000);
}

/// Claims a NEAR leaf through a `oneclick` payout and settles it with a successful callback.
fn claim_oneclick_settled(c: &mut Blindroll, t: &Value, i: usize) {
    claim_near_leaf(
        c,
        t,
        i,
        Payout::OneClick {
            deposit_address: acc(DEPOSIT),
        },
    );
    ctx_callback(PromiseResult::Successful(vec![]), NOW);
    assert!(c.on_payout(
        s(&t["run_key"]).to_string(),
        s(&t["leaf_hashes"][i]).to_string(),
        "oneclick".into()
    ));
}

#[test]
fn approver_reopens_refunded_claim_and_recipient_claims_again() {
    let (mut c, _) = active("claim-demo");
    let e = evm_case(1);
    let key = s(&e.tree["run_key"]).to_string();
    let leaf_hash = s(&e.tree["leaf_hashes"][2]).to_string();
    ctx(RELAYER);
    claim_evm_case(&mut c, &e);
    ctx_callback(PromiseResult::Successful(vec![]), NOW);
    c.on_payout(key.clone(), leaf_hash.clone(), "oneclick".into());

    ctx(A1);
    c.reopen_claim(key.clone(), leaf_hash.clone());
    let ev = events();
    assert_eq!(ev[0]["event"], "claim_reopened");
    assert_eq!(ev[0]["data"][0]["by"], A1);
    assert!(!c.is_claimed(key.clone(), leaf_hash.clone()));
    assert_eq!(run_of(&c, &e.tree).claimed_amount.0, 0);

    ctx(RELAYER);
    claim_evm_case(&mut c, &e);
    assert!(c.is_claimed(key, leaf_hash));
    assert_eq!(run_of(&c, &e.tree).claimed_amount.0, 950_000_000);
}

#[test]
fn reopen_restores_exactly_the_recorded_leaf_amount() {
    let (mut c, t) = active("claim-demo");
    let key = s(&t["run_key"]).to_string();
    claim_oneclick_settled(&mut c, &t, 1); // Ben, 800 USDC
    claim_oneclick_settled(&mut c, &t, 3); // Hiro, 1,050 USDC
    assert_eq!(run_of(&c, &t).claimed_amount.0, 1_850_000_000);

    ctx(A2);
    c.reopen_claim(key.clone(), s(&t["leaf_hashes"][1]).to_string());
    let r = run_of(&c, &t);
    assert_eq!(
        r.claimed_amount.0, 1_050_000_000,
        "only Ben's 800 USDC is released"
    );
    assert_invariants(&r);
    assert!(!c.is_claimed(key.clone(), s(&t["leaf_hashes"][1]).to_string()));
    assert!(c.is_claimed(key, s(&t["leaf_hashes"][3]).to_string()));
}

#[test]
#[should_panic(expected = "Only an approver")]
fn stranger_cannot_reopen_claim() {
    let (mut c, t) = active("claim-demo");
    claim_oneclick_settled(&mut c, &t, 1);
    ctx(STRANGER);
    c.reopen_claim(
        s(&t["run_key"]).to_string(),
        s(&t["leaf_hashes"][1]).to_string(),
    );
}

#[test]
#[should_panic(expected = "not marked as claimed")]
fn cannot_reopen_unclaimed_leaf() {
    let (mut c, t) = active("claim-demo");
    ctx(A1);
    c.reopen_claim(
        s(&t["run_key"]).to_string(),
        s(&t["leaf_hashes"][1]).to_string(),
    );
}

#[test]
#[should_panic(expected = "not marked as claimed")]
fn cannot_reopen_the_same_leaf_twice() {
    let (mut c, t) = active("claim-demo");
    claim_oneclick_settled(&mut c, &t, 1);
    ctx(A1);
    c.reopen_claim(
        s(&t["run_key"]).to_string(),
        s(&t["leaf_hashes"][1]).to_string(),
    );
    c.reopen_claim(
        s(&t["run_key"]).to_string(),
        s(&t["leaf_hashes"][1]).to_string(),
    );
}

#[test]
#[should_panic(expected = "still in flight")]
fn cannot_reopen_while_payout_is_in_flight() {
    let (mut c, t) = active("claim-demo");
    claim_near_leaf(
        &mut c,
        &t,
        1,
        Payout::OneClick {
            deposit_address: acc(DEPOSIT),
        },
    );
    ctx(A1);
    c.reopen_claim(
        s(&t["run_key"]).to_string(),
        s(&t["leaf_hashes"][1]).to_string(),
    );
}

#[test]
#[should_panic(expected = "Only oneclick payouts can be reopened")]
fn cannot_reopen_a_near_ft_payout() {
    let (mut c, t) = active("claim-demo");
    claim_near_leaf(&mut c, &t, 1, near_ft("ben.test.near"));
    ctx_callback(PromiseResult::Successful(vec![]), NOW);
    c.on_payout(
        s(&t["run_key"]).to_string(),
        s(&t["leaf_hashes"][1]).to_string(),
        "near_ft".into(),
    );
    ctx(A1);
    c.reopen_claim(
        s(&t["run_key"]).to_string(),
        s(&t["leaf_hashes"][1]).to_string(),
    );
}

#[test]
fn failed_payout_releases_the_recorded_amount_only_once() {
    let (mut c, t) = active("claim-demo");
    let key = s(&t["run_key"]).to_string();
    let leaf_hash = s(&t["leaf_hashes"][1]).to_string();
    claim_oneclick_settled(&mut c, &t, 3);
    claim_near_leaf(&mut c, &t, 1, near_ft("ben.test.near"));
    ctx_callback(PromiseResult::Failed, NOW);
    c.on_payout(key.clone(), leaf_hash.clone(), "near_ft".into());
    // A duplicated failure callback finds no record and changes nothing.
    ctx_callback(PromiseResult::Failed, NOW);
    c.on_payout(key, leaf_hash, "near_ft".into());
    assert_eq!(run_of(&c, &t).claimed_amount.0, 1_050_000_000);
}

/// Two funded runs that share the contract's single token balance.
fn two_active_runs() -> (Blindroll, Value, Value) {
    let mut c = new_contract();
    let (a, b) = (tree("claim-demo"), tree("sample-run"));
    for t in [&a, &b] {
        create(&mut c, t);
        approve_both(&mut c, s(&t["run_key"]));
        fund(&mut c, s(&t["run_key"]), total_of(t));
    }
    (c, a, b)
}

#[test]
fn reopen_then_reclaim_cannot_take_another_runs_funds() {
    // The old reopen_claim(amount) let an approver overstate the amount, shrink claimed_amount
    // and have reclaim_unclaimed send out more than the run still held, i.e. another run's USDC.
    let (mut c, a, b) = two_active_runs();
    let key = s(&a["run_key"]).to_string();
    claim_oneclick_settled(&mut c, &a, 1); // 800 USDC left the contract
    claim_oneclick_settled(&mut c, &a, 3); // 1,050 USDC left the contract
    ctx(A1);
    c.reopen_claim(key.clone(), s(&a["leaf_hashes"][1]).to_string()); // 800 USDC refunded by 1Click

    ctx_at(STRANGER, DEADLINE + 1);
    c.reclaim_unclaimed(key).unwrap().detach();
    // Exactly run A's own remainder: its total minus Hiro's settled 1,050 USDC.
    assert_paid(REFUND, total_of(&a) - 1_050_000_000);
    let ra = run_of(&c, &a);
    assert_eq!(
        ra.claimed_amount.0 + ra.reclaimed_amount.0,
        ra.funded_amount.0
    );
    let rb = run_of(&c, &b);
    assert_eq!((rb.claimed_amount.0, rb.reclaimed_amount.0), (0, 0));
    assert_eq!(rb.funded_amount.0, total_of(&b));
}

#[test]
#[should_panic(expected = "not marked as claimed")]
fn claim_in_one_run_cannot_be_reopened_through_another_run() {
    let (mut c, a, b) = two_active_runs();
    claim_oneclick_settled(&mut c, &a, 1);
    ctx(A1);
    c.reopen_claim(
        s(&b["run_key"]).to_string(),
        s(&a["leaf_hashes"][1]).to_string(),
    );
}

#[test]
fn a_run_never_pays_out_more_than_it_was_funded_even_with_reopens() {
    let (mut c, a, _) = two_active_runs();
    let key = s(&a["run_key"]).to_string();
    for round in 0..3 {
        claim_oneclick_settled(&mut c, &a, 1);
        let r = run_of(&c, &a);
        assert_eq!(r.claimed_amount.0, 800_000_000, "round {round}");
        assert_invariants(&r);
        ctx(A1);
        c.reopen_claim(key.clone(), s(&a["leaf_hashes"][1]).to_string());
        assert_eq!(run_of(&c, &a).claimed_amount.0, 0, "round {round}");
    }
}

// ───────────── Isolation between runs (invariant 3) ─────────────

#[test]
#[should_panic(expected = "Invalid Merkle proof")]
fn leaf_of_one_run_cannot_claim_from_another_run() {
    let mut c = new_contract();
    let (a, b) = (tree("claim-demo"), tree("sample-run"));
    for t in [&a, &b] {
        create(&mut c, t);
        approve_both(&mut c, s(&t["run_key"]));
        fund(&mut c, s(&t["run_key"]), total_of(t));
    }
    // Ben is in both runs; his claim-demo leaf and proof are used against sample-run.
    ctx("ben.test.near");
    c.claim_near(
        s(&b["run_key"]).to_string(),
        leaf_of(&a, 1),
        proof_of(&a, 1),
        near_ft("ben.test.near"),
    )
    .detach();
}

#[test]
fn runs_are_accounted_separately() {
    let mut c = new_contract();
    let (a, b) = (tree("claim-demo"), tree("sample-run"));
    for t in [&a, &b] {
        create(&mut c, t);
        approve_both(&mut c, s(&t["run_key"]));
        fund(&mut c, s(&t["run_key"]), total_of(t));
    }
    claim_near_leaf(&mut c, &a, 1, near_ft("ben.test.near"));
    claim_near_leaf(&mut c, &b, 5, near_ft("hiro.testnet"));
    assert_eq!(run_of(&c, &a).claimed_amount.0, 800_000_000);
    assert_eq!(run_of(&c, &b).claimed_amount.0, 1_050_000_000);
    // The same person's leaf in the other run is still claimable.
    assert!(!c.is_claimed(
        s(&b["run_key"]).to_string(),
        s(&b["leaf_hashes"][1]).to_string()
    ));
    assert_eq!(c.get_runs_by_approver(acc(A1), None, None).len(), 2);
    assert_eq!(c.get_runs_by_approver(acc(A1), Some(1), Some(5)).len(), 1);
}

#[test]
#[should_panic(expected = "Claim exceeds the run's remaining funds")]
fn claims_cannot_exceed_a_runs_own_funds() {
    // A run whose declared total is smaller than its tree: the second claim must fail
    // rather than spend another run's USDC.
    let mut c = new_contract();
    let t = tree("claim-demo");
    ctx_deposit(CREATOR, NearToken::from_near(1));
    c.create_run(
        s(&t["run_key"]).to_string(),
        vec![acc(A1)],
        1,
        s(&t["root"]).to_string(),
        HASH_AB.to_string(),
        5,
        U128(1_000_000_000),
        DEADLINE,
        acc(REFUND),
    );
    ctx(A1);
    c.approve_run(s(&t["run_key"]).to_string());
    fund(&mut c, s(&t["run_key"]), 1_000_000_000);
    claim_near_leaf(&mut c, &t, 1, near_ft("ben.test.near"));
    claim_near_leaf(&mut c, &t, 3, near_ft("hiro.testnet"));
}

// ───────────── reclaim_unclaimed (invariant 6) ─────────────

#[test]
#[should_panic(expected = "Claim deadline has not passed")]
fn cannot_reclaim_before_deadline() {
    let (mut c, t) = active("claim-demo");
    ctx_at(STRANGER, DEADLINE);
    let _ = c.reclaim_unclaimed(s(&t["run_key"]).to_string());
}

#[test]
fn reclaim_sends_unclaimed_funds_to_refund_account_and_closes() {
    let (mut c, t) = active("claim-demo");
    let key = s(&t["run_key"]).to_string();
    claim_near_leaf(&mut c, &t, 1, near_ft("ben.test.near"));
    let unclaimed = total_of(&t) - 800_000_000;

    ctx_at(STRANGER, DEADLINE + 1);
    c.reclaim_unclaimed(key.clone()).unwrap().detach();
    assert_paid(REFUND, unclaimed);
    let ev = events();
    assert_eq!(ev[0]["event"], "run_closed");
    assert_eq!(ev[0]["data"][0]["reclaimed_amount"], unclaimed.to_string());
    let r = run_of(&c, &t);
    assert_eq!(r.status, RunStatus::Closed);
    assert_eq!(r.reclaimed_amount.0, unclaimed);
    assert_eq!(r.claimed_amount.0 + r.reclaimed_amount.0, r.funded_amount.0);
    assert_invariants(&r);
}

#[test]
#[should_panic(expected = "Run is not Active")]
fn no_claims_after_close() {
    let (mut c, t) = active("claim-demo");
    ctx_at(STRANGER, DEADLINE + 1);
    c.reclaim_unclaimed(s(&t["run_key"]).to_string())
        .unwrap()
        .detach();
    claim_near_leaf(&mut c, &t, 1, near_ft("ben.test.near"));
}

#[test]
#[should_panic(expected = "Nothing to reclaim")]
fn cannot_reclaim_twice() {
    let (mut c, t) = active("claim-demo");
    ctx_at(STRANGER, DEADLINE + 1);
    c.reclaim_unclaimed(s(&t["run_key"]).to_string())
        .unwrap()
        .detach();
    let _ = c.reclaim_unclaimed(s(&t["run_key"]).to_string());
}

#[test]
fn failed_reclaim_transfer_can_be_retried() {
    let (mut c, t) = active("claim-demo");
    let key = s(&t["run_key"]).to_string();
    ctx_at(STRANGER, DEADLINE + 1);
    c.reclaim_unclaimed(key.clone()).unwrap().detach();
    ctx_callback(PromiseResult::Failed, DEADLINE + 2);
    assert!(!c.on_reclaim(key.clone(), U128(total_of(&t))));
    assert_eq!(run_of(&c, &t).reclaimed_amount.0, 0);
    ctx_at(STRANGER, DEADLINE + 3);
    c.reclaim_unclaimed(key).unwrap().detach();
    assert_paid(REFUND, total_of(&t));
}

#[test]
fn payout_that_fails_after_close_can_still_be_reclaimed() {
    let (mut c, t) = active("claim-demo");
    let key = s(&t["run_key"]).to_string();
    claim_near_leaf(&mut c, &t, 1, near_ft("ben.test.near")); // in flight
    ctx_at(STRANGER, DEADLINE + 1);
    c.reclaim_unclaimed(key.clone()).unwrap().detach();
    assert_paid(REFUND, total_of(&t) - 800_000_000);

    ctx_callback(PromiseResult::Failed, DEADLINE + 2);
    c.on_payout(
        key.clone(),
        s(&t["leaf_hashes"][1]).to_string(),
        "near_ft".into(),
    );
    ctx_at(STRANGER, DEADLINE + 3);
    c.reclaim_unclaimed(key).unwrap().detach();
    assert_paid(REFUND, 800_000_000);
    let r = run_of(&c, &t);
    assert_eq!(r.reclaimed_amount.0, r.funded_amount.0);
    assert_eq!(r.claimed_amount.0, 0);
}

#[test]
fn fully_claimed_run_closes_without_a_transfer() {
    let (mut c, t) = active("single");
    claim_near_leaf(&mut c, &t, 0, near_ft("hiro.testnet"));
    ctx_at(STRANGER, DEADLINE + 1);
    assert!(c.reclaim_unclaimed(s(&t["run_key"]).to_string()).is_none());
    assert!(token_calls().is_empty());
    assert_eq!(run_of(&c, &t).status, RunStatus::Closed);
}

#[test]
fn partially_funded_run_can_be_reclaimed_after_deadline() {
    let mut c = new_contract();
    let t = tree("pair");
    let key = s(&t["run_key"]);
    create(&mut c, &t);
    approve_both(&mut c, key);
    fund(&mut c, key, 300);
    ctx_at(STRANGER, DEADLINE + 1);
    c.reclaim_unclaimed(key.to_string()).unwrap().detach();
    assert_paid(REFUND, 300);
    assert_eq!(run_of(&c, &t).status, RunStatus::Closed);
}

#[test]
#[should_panic(expected = "Run has no funds to reclaim")]
fn draft_run_cannot_be_reclaimed() {
    let mut c = new_contract();
    let t = tree("pair");
    create(&mut c, &t);
    ctx_at(STRANGER, DEADLINE + 1);
    let _ = c.reclaim_unclaimed(s(&t["run_key"]).to_string());
}

// ───────────── JSON shapes ─────────────

#[test]
fn payout_json_shape() {
    let p: Payout =
        serde_json::from_str(r#"{"kind":"near_ft","receiver":"asha.test.near"}"#).unwrap();
    assert_eq!(
        (p.kind(), p.target().as_str()),
        ("near_ft", "asha.test.near")
    );
    let p: Payout =
        serde_json::from_str(r#"{"kind":"oneclick","deposit_address":"dep.test.near"}"#).unwrap();
    assert_eq!(
        (p.kind(), p.target().as_str()),
        ("oneclick", "dep.test.near")
    );
    assert!(serde_json::from_str::<Payout>(r#"{"kind":"wire","receiver":"a.test.near"}"#).is_err());
    assert!(
        serde_json::from_str::<Payout>(r#"{"kind":"near_ft","receiver":"Not Valid"}"#).is_err()
    );
}

// ───────────── Edge cases added after the external review (2026-11-12) ─────────────

/// A "claim-demo" run that was created and approved, then cancelled before any funding.
fn cancelled(name: &str) -> (Blindroll, Value) {
    let mut c = new_contract();
    let t = tree(name);
    create(&mut c, &t);
    approve_both(&mut c, s(&t["run_key"]));
    ctx(A1);
    c.cancel_run(s(&t["run_key"]).to_string());
    assert_eq!(run_of(&c, &t).status, RunStatus::Cancelled);
    (c, t)
}

/// A "claim-demo" run that is Approved and only partly funded (one base unit short).
fn partly_funded(name: &str) -> (Blindroll, Value) {
    let mut c = new_contract();
    let t = tree(name);
    create(&mut c, &t);
    approve_both(&mut c, s(&t["run_key"]));
    assert_eq!(fund(&mut c, s(&t["run_key"]), total_of(&t) - 1), 0);
    assert_eq!(run_of(&c, &t).status, RunStatus::Approved);
    (c, t)
}

#[test]
#[should_panic(expected = "Run is not Active")]
fn claim_near_on_cancelled_run_fails() {
    let (mut c, t) = cancelled("claim-demo");
    claim_near_leaf(&mut c, &t, 1, near_ft("ben.test.near"));
}

#[test]
#[should_panic(expected = "Run is not Active")]
fn claim_near_on_partly_funded_run_fails() {
    let (mut c, t) = partly_funded("claim-demo");
    claim_near_leaf(&mut c, &t, 1, near_ft("ben.test.near"));
}

#[test]
#[should_panic(expected = "This leaf has already been claimed")]
fn relayed_claim_cannot_be_made_twice() {
    let (mut c, t) = active("claim-demo");
    relayed(&mut c, RELAYER, &t, leaf_of(&t, 1), 1);
    relayed(&mut c, RELAYER, &t, leaf_of(&t, 1), 1);
}

#[test]
#[should_panic(expected = "Invalid Merkle proof")]
fn relayed_claim_with_wrong_proof_fails() {
    let (mut c, t) = active("claim-demo");
    relayed(&mut c, RELAYER, &t, leaf_of(&t, 1), 3);
}

#[test]
#[should_panic(expected = "Run is not Active")]
fn relayed_claim_on_cancelled_run_fails() {
    let (mut c, t) = cancelled("claim-demo");
    relayed(&mut c, RELAYER, &t, leaf_of(&t, 1), 1);
}

#[test]
#[should_panic(expected = "Run is not Active")]
fn relayed_claim_on_partly_funded_run_fails() {
    let (mut c, t) = partly_funded("claim-demo");
    relayed(&mut c, RELAYER, &t, leaf_of(&t, 1), 1);
}

#[test]
fn relayed_claim_pays_the_leaf_account_even_when_another_leaf_is_claimed_first() {
    // The relayer has no receiver argument: each relayed claim pays exactly its own leaf's account.
    let (mut c, t) = active("claim-demo");
    relayed(&mut c, RELAYER, &t, leaf_of(&t, 1), 1);
    assert_paid("ben.test.near", 800_000_000);
    relayed(&mut c, RELAYER, &t, leaf_of(&t, 3), 3);
    let calls = token_calls();
    let last = calls.last().unwrap();
    assert_eq!(last.0, "ft_transfer");
    assert_eq!(last.1["receiver_id"], leaf_of(&t, 3).address.as_str());
    assert_invariants(&run_of(&c, &t));
}

#[test]
#[should_panic(expected = "Run is not Active")]
fn claim_evm_on_cancelled_run_fails() {
    let e = evm_case(0);
    let (mut c, _) = cancelled("claim-demo");
    ctx(RELAYER);
    claim_evm_case(&mut c, &e);
}

#[test]
#[should_panic(expected = "Run is not Active")]
fn claim_evm_before_funding_fails() {
    let mut c = new_contract();
    let e = evm_case(0);
    create(&mut c, &e.tree);
    approve_both(&mut c, s(&e.tree["run_key"]));
    ctx(RELAYER);
    claim_evm_case(&mut c, &e);
}

#[test]
#[should_panic(expected = "Run is not Active")]
fn claim_evm_on_partly_funded_run_fails() {
    let (mut c, _) = partly_funded("claim-demo");
    let e = evm_case(0);
    ctx(RELAYER);
    claim_evm_case(&mut c, &e);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn claim_evm_while_paused_fails() {
    let (mut c, _) = active("claim-demo");
    ctx(OWNER);
    c.set_paused(true);
    let e = evm_case(0);
    ctx(RELAYER);
    claim_evm_case(&mut c, &e);
}

#[test]
#[should_panic(expected = "Claim deadline has passed")]
fn claim_evm_after_deadline_fails() {
    let (mut c, _) = active("claim-demo");
    let mut e = evm_case(0);
    // Even with a signature that has not expired, the run's deadline wins.
    e.expires_at_ms = DEADLINE + 10;
    ctx_at(RELAYER, DEADLINE + 1);
    claim_evm_case(&mut c, &e);
}

#[test]
#[should_panic(expected = "Invalid Merkle proof")]
fn claim_evm_with_wrong_proof_fails() {
    let (mut c, _) = active("claim-demo");
    let e = evm_case(0);
    ctx(RELAYER);
    c.claim_evm(
        s(&e.tree["run_key"]).to_string(),
        leaf_of(&e.tree, e.index),
        proof_of(&e.tree, (e.index + 1) % 4),
        e.payout.clone(),
        e.destination_asset.clone(),
        e.destination_address.clone(),
        e.expires_at_ms,
        e.signature.clone(),
    )
    .detach();
}

#[test]
#[should_panic(expected = "This leaf has already been claimed")]
fn claim_evm_cannot_be_made_twice() {
    let (mut c, _) = active("claim-demo");
    let e = evm_case(0);
    ctx(RELAYER);
    claim_evm_case(&mut c, &e);
    claim_evm_case(&mut c, &e);
}

#[test]
#[should_panic(expected = "Only an approver")]
fn relayer_cannot_reopen_claim() {
    let (mut c, t) = active("claim-demo");
    claim_oneclick_settled(&mut c, &t, 1);
    ctx(RELAYER);
    c.reopen_claim(
        s(&t["run_key"]).to_string(),
        s(&t["leaf_hashes"][1]).to_string(),
    );
}

#[test]
#[should_panic(expected = "Only an approver")]
fn recipient_cannot_reopen_own_claim() {
    let (mut c, t) = active("claim-demo");
    claim_oneclick_settled(&mut c, &t, 1);
    ctx("ben.test.near");
    c.reopen_claim(
        s(&t["run_key"]).to_string(),
        s(&t["leaf_hashes"][1]).to_string(),
    );
}

#[test]
#[should_panic(expected = "Only an approver")]
fn contract_owner_cannot_reopen_claim() {
    let (mut c, t) = active("claim-demo");
    claim_oneclick_settled(&mut c, &t, 1);
    ctx(OWNER);
    c.reopen_claim(
        s(&t["run_key"]).to_string(),
        s(&t["leaf_hashes"][1]).to_string(),
    );
}

#[test]
#[should_panic(expected = "leaf_hash_hex must be 64 lowercase hex chars")]
fn reopen_with_malformed_leaf_hash_fails() {
    let (mut c, t) = active("claim-demo");
    claim_oneclick_settled(&mut c, &t, 1);
    ctx(A1);
    c.reopen_claim(
        s(&t["run_key"]).to_string(),
        s(&t["leaf_hashes"][1]).to_uppercase(),
    );
}

#[test]
#[should_panic(expected = "not marked as claimed")]
fn reopen_of_another_leaf_than_the_claimed_one_fails() {
    // reopen_claim takes no amount: it can only release the amount stored for a claimed leaf.
    // Naming a different (unclaimed) leaf, e.g. one with a larger amount, is refused.
    let (mut c, t) = active("claim-demo");
    claim_oneclick_settled(&mut c, &t, 1); // Ben, 800 USDC
    ctx(A1);
    c.reopen_claim(
        s(&t["run_key"]).to_string(),
        s(&t["leaf_hashes"][3]).to_string(),
    );
}

#[test]
#[should_panic(expected = "Run not found")]
fn reopen_on_unknown_run_fails() {
    let (mut c, t) = active("claim-demo");
    claim_oneclick_settled(&mut c, &t, 1);
    ctx(A1);
    c.reopen_claim("no-such-run".into(), s(&t["leaf_hashes"][1]).to_string());
}
