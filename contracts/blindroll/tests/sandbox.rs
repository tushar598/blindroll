//! Sandbox integration tests: build both contracts to wasm, deploy them to a local NEAR sandbox
//! and run the run lifecycle with real cross-contract calls. They use the same shared vectors
//! as the unit tests and the TypeScript tests.
//!
//! Run with: `cargo test -p blindroll --test sandbox -- --nocapture`

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{Value, json};

const MERKLE_JSON: &str = include_str!("../../../packages/core/test-vectors/merkle.json");
const CLAIM_JSON: &str = include_str!("../../../packages/core/test-vectors/claim-message.json");
const HASH_AB: &str = "abababababababababababababababababababababababababababababababab";
/// A NEAR implicit account standing in for a 1Click deposit address.
const DEPOSIT: &str = "3ccf686b516ede32e2936c25798378623c99a5fce5bcee411d2df4b4f5fea1e0";
const TOKEN_STORAGE_DEPOSIT: u128 = 1_250_000_000_000_000_000_000;
const CLAIM_GAS: Gas = Gas::from_tgas(100);

type Res<T> = Result<T, Box<dyn std::error::Error>>;

/// Builds a contract crate with `cargo near build` and returns the wasm bytes.
fn build_wasm(crate_dir: &str, name: &str) -> Vec<u8> {
    let contracts = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let status = Command::new("cargo")
        .args(["near", "build", "non-reproducible-wasm", "--no-abi"])
        .current_dir(contracts.join(crate_dir))
        .env_remove("RUSTFLAGS")
        .env_remove("CARGO_ENCODED_RUSTFLAGS")
        .status()
        .expect("cargo-near must be installed (https://github.com/near/cargo-near)");
    assert!(status.success(), "cargo near build failed for {crate_dir}");
    let wasm: PathBuf = contracts
        .join("target/near")
        .join(name)
        .join(format!("{name}.wasm"));
    std::fs::read(&wasm).unwrap_or_else(|e| panic!("cannot read {}: {e}", wasm.display()))
}

/// Both wasm files, built once per test binary.
fn wasms() -> &'static (Vec<u8>, Vec<u8>) {
    static WASMS: OnceLock<(Vec<u8>, Vec<u8>)> = OnceLock::new();
    WASMS.get_or_init(|| {
        (
            build_wasm("blindroll", "blindroll"),
            build_wasm("mock-usdc", "mock_usdc"),
        )
    })
}

struct Env {
    worker: Worker<Sandbox>,
    usdc: Contract,
    blindroll: Contract,
    owner: Account,
    relayer: Account,
    creator: Account,
    approver1: Account,
    approver2: Account,
    ben: Account,
    hiro: Account,
    stranger: Account,
    tree: Value,
    claims: Value,
    run_key: String,
    total: u128,
}

async fn sub(root: &Account, name: &str, near: u128) -> Res<Account> {
    Ok(root
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

fn failure_text(res: ExecutionFinalResult) -> String {
    format!(
        "{:?}",
        res.into_result().expect_err("the call should have failed")
    )
}

impl Env {
    /// Deploys both contracts as `usdc.test.near` and `blindroll.test.near` (the contract ID the
    /// claim vectors are signed for) and mints 10,000 test USDC to the creator.
    async fn deploy() -> Res<Env> {
        let (blindroll_wasm, usdc_wasm) = wasms();
        let merkle: Value = serde_json::from_str(MERKLE_JSON)?;
        let claims: Value = serde_json::from_str(CLAIM_JSON)?;
        let tree = merkle["trees"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "claim-demo")
            .unwrap()
            .clone();

        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?; // test.near
        let owner = sub(&root, "owner", 5).await?;
        let relayer = sub(&root, "relayer", 5).await?;
        let creator = sub(&root, "creator", 5).await?;
        let approver1 = sub(&root, "approver1", 5).await?;
        let approver2 = sub(&root, "approver2", 5).await?;
        let ben = sub(&root, "ben", 5).await?;
        let hiro = sub(&root, "hiro", 5).await?;
        let stranger = sub(&root, "stranger", 5).await?;
        let usdc = sub(&root, "usdc", 10)
            .await?
            .deploy(usdc_wasm)
            .await?
            .into_result()?;
        let blindroll = sub(&root, "blindroll", 10)
            .await?
            .deploy(blindroll_wasm)
            .await?
            .into_result()?;
        assert_eq!(
            blindroll.id().as_str(),
            claims["cases"][0]["contract_id"].as_str().unwrap()
        );
        assert_eq!(tree["leaves"][1]["address"], ben.id().as_str());
        assert_eq!(tree["leaves"][3]["address"], hiro.id().as_str());

        usdc.call("new").transact().await?.into_result()?;
        blindroll
            .call("new")
            .args_json(
                json!({ "owner": owner.id(), "token_id": usdc.id(), "relayer": relayer.id() }),
            )
            .transact()
            .await?
            .into_result()?;
        creator
            .call(usdc.id(), "mint")
            .args_json(json!({ "account_id": creator.id(), "amount": "10000000000" }))
            .transact()
            .await?
            .into_result()?;
        // The Blindroll contract must be registered on the token before it can be funded.
        creator
            .call(usdc.id(), "storage_deposit")
            .args_json(json!({ "account_id": blindroll.id(), "registration_only": true }))
            .deposit(NearToken::from_yoctonear(TOKEN_STORAGE_DEPOSIT))
            .transact()
            .await?
            .into_result()?;

        let run_key = tree["run_key"].as_str().unwrap().to_string();
        let total = tree["total_amount"].as_str().unwrap().parse()?;
        Ok(Env {
            worker,
            usdc,
            blindroll,
            owner,
            relayer,
            creator,
            approver1,
            approver2,
            ben,
            hiro,
            stranger,
            tree,
            claims,
            run_key,
            total,
        })
    }

    async fn now_ms(&self) -> Res<u64> {
        Ok(self.worker.view_block().await?.timestamp() / 1_000_000)
    }

    async fn create_run(&self, deadline_ms: u64) -> Res<ExecutionFinalResult> {
        Ok(self
            .creator
            .call(self.blindroll.id(), "create_run")
            .args_json(json!({
                "run_key": self.run_key,
                "approvers": [self.approver1.id(), self.approver2.id()],
                "threshold": 2,
                "merkle_root_hex": self.tree["root"],
                "report_hash_hex": HASH_AB,
                "recipient_count": 5,
                "total_amount": self.total.to_string(),
                "claim_deadline_ms": deadline_ms,
                "refund_account": self.creator.id(),
            }))
            .deposit(NearToken::from_near(1))
            .transact()
            .await?)
    }

    async fn approve_both(&self) -> Res<()> {
        for a in [&self.approver1, &self.approver2] {
            a.call(self.blindroll.id(), "approve_run")
                .args_json(json!({ "run_key": self.run_key }))
                .transact()
                .await?
                .into_result()?;
        }
        Ok(())
    }

    async fn fund(&self, amount: u128) -> Res<()> {
        self.creator
            .call(self.usdc.id(), "ft_transfer_call")
            .args_json(json!({
                "receiver_id": self.blindroll.id(),
                "amount": amount.to_string(),
                "msg": json!({ "fund_run": self.run_key }).to_string(),
            }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(CLAIM_GAS)
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    /// A funded, Active run with the given claim window.
    async fn active_run(window_ms: u64) -> Res<Env> {
        let env = Env::deploy().await?;
        env.create_run(env.now_ms().await? + window_ms)
            .await?
            .into_result()?;
        env.approve_both().await?;
        env.fund(env.total).await?;
        assert_eq!(env.run().await?["status"], "Active");
        Ok(env)
    }

    async fn usdc_of(&self, account: &str) -> Res<u128> {
        let v: String = self
            .usdc
            .view("ft_balance_of")
            .args_json(json!({ "account_id": account }))
            .await?
            .json()?;
        Ok(v.parse()?)
    }

    async fn run(&self) -> Res<Value> {
        Ok(self
            .blindroll
            .view("get_run")
            .args_json(json!({ "run_key": self.run_key }))
            .await?
            .json()?)
    }

    async fn is_claimed(&self, leaf_index: usize) -> Res<bool> {
        Ok(self
            .blindroll
            .view("is_claimed")
            .args_json(json!({ "run_key": self.run_key, "leaf_hash_hex": self.tree["leaf_hashes"][leaf_index] }))
            .await?
            .json()?)
    }

    async fn claim_near(
        &self,
        caller: &Account,
        leaf_index: usize,
        payout: Value,
    ) -> Res<ExecutionFinalResult> {
        Ok(caller
            .call(self.blindroll.id(), "claim_near")
            .args_json(json!({
                "run_key": self.run_key,
                "leaf": self.tree["leaves"][leaf_index],
                "proof": self.tree["proofs"][leaf_index],
                "payout": payout,
            }))
            .gas(CLAIM_GAS)
            .transact()
            .await?)
    }

    fn evm_args(&self, case_index: usize) -> Value {
        let case = &self.claims["cases"][case_index];
        let i = case["leaf_index"].as_u64().unwrap() as usize;
        let target = case["payout_target"].as_str().unwrap();
        let payout = match case["payout_kind"].as_str().unwrap() {
            "near_ft" => json!({ "kind": "near_ft", "receiver": target }),
            _ => json!({ "kind": "oneclick", "deposit_address": target }),
        };
        json!({
            "run_key": self.run_key,
            "leaf": self.tree["leaves"][i],
            "proof": self.tree["proofs"][i],
            "payout": payout,
            "destination_asset": case["destination_asset"],
            "destination_address": case["destination_address"],
            "expires_at_ms": case["expires_at_ms"].as_str().unwrap().parse::<u64>().unwrap(),
            "signature_hex": case["signature"],
        })
    }

    async fn claim_evm(&self, caller: &Account, args: &Value) -> Res<ExecutionFinalResult> {
        Ok(caller
            .call(self.blindroll.id(), "claim_evm")
            .args_json(args)
            .gas(CLAIM_GAS)
            .transact()
            .await?)
    }

    async fn call_run(
        &self,
        caller: &Account,
        method: &str,
        extra: Value,
    ) -> Res<ExecutionFinalResult> {
        let mut args = json!({ "run_key": self.run_key });
        if let Some(extra) = extra.as_object() {
            args.as_object_mut().unwrap().extend(extra.clone());
        }
        Ok(caller
            .call(self.blindroll.id(), method)
            .args_json(args)
            .gas(CLAIM_GAS)
            .transact()
            .await?)
    }
}

fn has_event(res: &ExecutionFinalResult, event: &str) -> bool {
    res.logs()
        .iter()
        .any(|l| l.contains(&format!(r#""event":"{event}""#)))
}

#[tokio::test]
async fn create_approve_fund_and_claim() -> Res<()> {
    let env = Env::deploy().await?;
    let (blindroll, usdc) = (&env.blindroll, &env.usdc);
    let cfg: Value = blindroll.view("get_config").await?.json()?;
    assert_eq!(cfg["token_id"], usdc.id().as_str());
    assert_eq!(cfg["paused"], false);

    // The creator is charged exactly: run storage + 5 × (claim record storage + token registration).
    let before = blindroll.view_account().await?;
    env.create_run(env.now_ms().await? + 3_600_000)
        .await?
        .into_result()?;
    let after = blindroll.view_account().await?;
    let gained = after.balance.saturating_sub(before.balance).as_yoctonear();
    let run_bytes = (after.storage_usage - before.storage_usage) as u128;
    let byte_cost = 10_000_000_000_000_000_000u128;
    println!("create_run: {run_bytes} bytes of run storage, creator charged {gained} yoctoNEAR");
    assert_eq!(
        gained,
        run_bytes * byte_cost + 5 * (100 * byte_cost + TOKEN_STORAGE_DEPOSIT)
    );

    // A second run with the same key is refused.
    assert!(
        failure_text(env.create_run(env.now_ms().await? + 3_600_000).await?)
            .contains("run_key already exists")
    );

    // Funding before approval is returned in full.
    env.fund(env.total).await?;
    assert_eq!(env.usdc_of(blindroll.id().as_str()).await?, 0);
    assert_eq!(env.run().await?["status"], "Draft");

    env.approve_both().await?;
    assert_eq!(env.run().await?["status"], "Approved");

    // Overfund by 1 USDC: the excess comes back.
    env.fund(env.total + 1_000_000).await?;
    assert_eq!(env.usdc_of(blindroll.id().as_str()).await?, env.total);
    assert_eq!(
        env.usdc_of(env.creator.id().as_str()).await?,
        10_000_000_000 - env.total
    );
    let r = env.run().await?;
    assert_eq!(r["status"], "Active");
    assert_eq!(r["funded_amount"], env.total.to_string());

    let near_before = blindroll.view_account().await?;

    // NEAR recipient (leaf 1 = ben.test.near) claims to their own, not yet registered, account.
    let to_ben = json!({ "kind": "near_ft", "receiver": env.ben.id() });
    assert!(
        failure_text(env.claim_near(&env.stranger, 1, to_ben.clone()).await?)
            .contains("Only the recipient account can claim this leaf")
    );
    let res = env.claim_near(&env.ben, 1, to_ben).await?;
    println!("claim_near gas burnt: {}", res.total_gas_burnt);
    assert!(has_event(&res, "claimed"), "logs: {:?}", res.logs());
    res.into_result()?;
    assert_eq!(env.usdc_of(env.ben.id().as_str()).await?, 800_000_000);
    let record_bytes = blindroll.view_account().await?.storage_usage - near_before.storage_usage;
    println!("claim record storage: {record_bytes} bytes");
    assert!(
        record_bytes <= 100,
        "claim record uses {record_bytes} bytes, more than the 100 prepaid"
    );

    // EVM recipient #0: the relayer submits the signed claim.
    let case0 = env.claims["cases"][0].clone();
    // A relayer that swaps the payout target is rejected by the on-chain signature check.
    let mut redirected = env.evm_args(0);
    redirected["payout"] = json!({ "kind": "near_ft", "receiver": env.relayer.id() });
    assert!(
        failure_text(env.claim_evm(&env.relayer, &redirected).await?)
            .contains("Signature does not match the leaf address")
    );
    // A signature from another key is rejected.
    let mut forged = env.evm_args(0);
    forged["signature_hex"] = case0["wrong_signer_signature"].clone();
    assert!(
        failure_text(env.claim_evm(&env.relayer, &forged).await?)
            .contains("Signature does not match the leaf address")
    );
    let res = env.claim_evm(&env.relayer, &env.evm_args(0)).await?;
    println!("claim_evm (near_ft) gas burnt: {}", res.total_gas_burnt);
    res.into_result()?;
    assert_eq!(
        env.usdc_of(case0["payout_target"].as_str().unwrap())
            .await?,
        1_200_500_000
    );
    // Replay of the same signed claim fails.
    assert!(
        failure_text(env.claim_evm(&env.stranger, &env.evm_args(0)).await?)
            .contains("already been claimed")
    );

    // EVM recipient #1: oneclick payout to a deposit address; anyone may submit.
    let res = env.claim_evm(&env.stranger, &env.evm_args(1)).await?;
    println!("claim_evm (oneclick) gas burnt: {}", res.total_gas_burnt);
    res.into_result()?;
    assert_eq!(env.usdc_of(DEPOSIT).await?, 950_000_000);

    // Callbacks are private.
    let res = env
        .call_run(
            &env.stranger,
            "on_payout",
            json!({ "leaf_hash_hex": env.tree["leaf_hashes"][3], "payout_kind": "near_ft" }),
        )
        .await?;
    assert!(res.is_failure());

    // On-chain accounting matches the token balances.
    let claimed = 800_000_000 + 1_200_500_000 + 950_000_000u128;
    assert_eq!(env.run().await?["claimed_amount"], claimed.to_string());
    assert_eq!(
        env.usdc_of(blindroll.id().as_str()).await?,
        env.total - claimed
    );
    for (i, expected) in [(0, true), (1, true), (2, true), (3, false), (4, false)] {
        assert_eq!(env.is_claimed(i).await?, expected, "leaf {i}");
    }

    // Three token registrations (0.00125 NEAR each) came out of the creator's prepayment.
    let spent = near_before
        .balance
        .saturating_sub(blindroll.view_account().await?.balance)
        .as_yoctonear();
    println!("contract NEAR spent on 3 claims: {spent} yoctoNEAR");
    assert!(spent <= 3 * TOKEN_STORAGE_DEPOSIT + 10);
    Ok(())
}

#[tokio::test]
async fn failed_payout_reopen_pause_and_reclaim() -> Res<()> {
    let env = Env::active_run(40_000).await?;
    let blindroll = &env.blindroll;
    let contract_id = blindroll.id().as_str();

    // ── Failed payout: the token rejects a transfer from the contract to itself, so the
    //    storage_deposit + ft_transfer receipt fails and on_payout rolls the claim back.
    let near_before = blindroll.view_account().await?.balance;
    let res = env
        .claim_near(
            &env.ben,
            1,
            json!({ "kind": "near_ft", "receiver": contract_id }),
        )
        .await?;
    assert!(has_event(&res, "claim_failed"), "logs: {:?}", res.logs());
    assert!(!has_event(&res, "claimed"));
    assert!(
        !res.receipt_failures().is_empty(),
        "the token receipt should have failed"
    );
    assert!(!env.is_claimed(1).await?);
    assert_eq!(env.run().await?["claimed_amount"], "0");
    assert_eq!(env.usdc_of(contract_id).await?, env.total);
    // The 0.00125 NEAR attached to the failed receipt came back.
    let near_after = blindroll.view_account().await?.balance;
    assert!(
        near_after >= near_before,
        "storage deposit not refunded: {near_before} -> {near_after}"
    );

    // ── The same recipient retries, this time with a oneclick payout.
    let to_deposit = json!({ "kind": "oneclick", "deposit_address": DEPOSIT });
    let res = env.claim_near(&env.ben, 1, to_deposit).await?;
    assert!(has_event(&res, "claimed"));
    res.into_result()?;
    assert_eq!(env.usdc_of(DEPOSIT).await?, 800_000_000);
    assert!(env.is_claimed(1).await?);

    // ── Refund → reopen → claim again.
    // Test scaffolding: 1Click would refund by sending the USDC from the deposit address back to
    // this contract. The test cannot sign for that address, so it mints the same amount instead.
    env.creator
        .call(env.usdc.id(), "mint")
        .args_json(json!({ "account_id": contract_id, "amount": "800000000" }))
        .transact()
        .await?
        .into_result()?;
    let leaf1 = json!({ "leaf_hash_hex": env.tree["leaf_hashes"][1] });
    assert!(
        failure_text(
            env.call_run(&env.stranger, "reopen_claim", leaf1.clone())
                .await?
        )
        .contains("Only an approver of this run can reopen a claim")
    );
    assert!(
        failure_text(
            env.call_run(
                &env.approver1,
                "reopen_claim",
                json!({ "leaf_hash_hex": env.tree["leaf_hashes"][3] })
            )
            .await?
        )
        .contains("This leaf is not marked as claimed")
    );
    let res = env
        .call_run(&env.approver1, "reopen_claim", leaf1.clone())
        .await?;
    assert!(has_event(&res, "claim_reopened"));
    res.into_result()?;
    assert!(!env.is_claimed(1).await?);
    assert_eq!(
        env.run().await?["claimed_amount"],
        "0",
        "exactly the recorded 800 USDC was released"
    );
    assert!(
        failure_text(env.call_run(&env.approver1, "reopen_claim", leaf1).await?)
            .contains("This leaf is not marked as claimed")
    );
    env.claim_near(
        &env.ben,
        1,
        json!({ "kind": "near_ft", "receiver": env.ben.id() }),
    )
    .await?
    .into_result()?;
    assert_eq!(env.usdc_of(env.ben.id().as_str()).await?, 800_000_000);
    assert_eq!(env.run().await?["claimed_amount"], "800000000");

    // ── A near_ft payout cannot be reopened.
    let res = env
        .call_run(
            &env.approver2,
            "reopen_claim",
            json!({ "leaf_hash_hex": env.tree["leaf_hashes"][1] }),
        )
        .await?;
    assert!(failure_text(res).contains("Only oneclick payouts can be reopened"));

    // ── Pause blocks claims; only the owner can pause.
    assert!(
        env.stranger
            .call(blindroll.id(), "set_paused")
            .args_json(json!({ "paused": true }))
            .transact()
            .await?
            .is_failure()
    );
    env.owner
        .call(blindroll.id(), "set_paused")
        .args_json(json!({ "paused": true }))
        .transact()
        .await?
        .into_result()?;
    let to_hiro = json!({ "kind": "near_ft", "receiver": env.hiro.id() });
    assert!(
        failure_text(env.claim_near(&env.hiro, 3, to_hiro.clone()).await?)
            .contains("Contract is paused")
    );
    env.owner
        .call(blindroll.id(), "set_paused")
        .args_json(json!({ "paused": false }))
        .transact()
        .await?
        .into_result()?;

    // ── Reclaim: refused before the deadline, then sends the remainder to the refund account.
    assert!(
        failure_text(
            env.call_run(&env.stranger, "reclaim_unclaimed", json!({}))
                .await?
        )
        .contains("Claim deadline has not passed")
    );
    let deadline = env.run().await?["claim_deadline_ms"].as_u64().unwrap();
    while env.now_ms().await? <= deadline {
        env.worker.fast_forward(50).await?;
    }
    assert!(
        failure_text(env.claim_near(&env.hiro, 3, to_hiro).await?)
            .contains("Claim deadline has passed")
    );

    let creator_before = env.usdc_of(env.creator.id().as_str()).await?;
    let res = env
        .call_run(&env.stranger, "reclaim_unclaimed", json!({}))
        .await?;
    assert!(has_event(&res, "run_closed"));
    res.into_result()?;
    let remainder = env.total - 800_000_000;
    assert_eq!(
        env.usdc_of(env.creator.id().as_str()).await?,
        creator_before + remainder
    );
    let r = env.run().await?;
    assert_eq!(r["status"], "Closed");
    assert_eq!(r["reclaimed_amount"], remainder.to_string());
    assert_eq!(r["claimed_amount"], "800000000");
    // Everything is accounted for: funding + the refund stand-in − two payouts − the reclaim.
    assert_eq!(env.usdc_of(contract_id).await?, 0);

    assert!(
        failure_text(
            env.call_run(&env.stranger, "reclaim_unclaimed", json!({}))
                .await?
        )
        .contains("Nothing to reclaim")
    );
    Ok(())
}
