//! Sandbox smoke test: builds both contracts to wasm, deploys them to a local NEAR sandbox and
//! runs create → approve → fund → claim (NEAR and EVM) with real cross-contract calls.
//! It uses the same shared vectors as the unit tests and the TypeScript tests.
//!
//! Run with: `cargo test -p blindroll --test sandbox -- --nocapture`

use std::path::{Path, PathBuf};
use std::process::Command;

use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};

const MERKLE_JSON: &str = include_str!("../../../packages/core/test-vectors/merkle.json");
const CLAIM_JSON: &str = include_str!("../../../packages/core/test-vectors/claim-message.json");
const HASH_AB: &str = "abababababababababababababababababababababababababababababababab";

type TestResult = Result<(), Box<dyn std::error::Error>>;

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

async fn sub(
    root: &Account,
    name: &str,
    near: u128,
) -> Result<Account, Box<dyn std::error::Error>> {
    Ok(root
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

async fn balance(usdc: &Contract, account: &str) -> Result<u128, Box<dyn std::error::Error>> {
    let v: String = usdc
        .view("ft_balance_of")
        .args_json(json!({ "account_id": account }))
        .await?
        .json()?;
    Ok(v.parse()?)
}

async fn run(blindroll: &Contract, run_key: &str) -> Result<Value, Box<dyn std::error::Error>> {
    Ok(blindroll
        .view("get_run")
        .args_json(json!({ "run_key": run_key }))
        .await?
        .json()?)
}

fn evm_args(case: &Value, tree: &Value) -> Value {
    let i = case["leaf_index"].as_u64().unwrap() as usize;
    let target = case["payout_target"].as_str().unwrap();
    let payout = match case["payout_kind"].as_str().unwrap() {
        "near_ft" => json!({ "kind": "near_ft", "receiver": target }),
        _ => json!({ "kind": "oneclick", "deposit_address": target }),
    };
    json!({
        "run_key": tree["run_key"],
        "leaf": tree["leaves"][i],
        "proof": tree["proofs"][i],
        "payout": payout,
        "destination_asset": case["destination_asset"],
        "destination_address": case["destination_address"],
        "expires_at_ms": case["expires_at_ms"].as_str().unwrap().parse::<u64>().unwrap(),
        "signature_hex": case["signature"],
    })
}

#[tokio::test]
async fn create_approve_fund_and_claim_in_sandbox() -> TestResult {
    let blindroll_wasm = build_wasm("blindroll", "blindroll");
    let usdc_wasm = build_wasm("mock-usdc", "mock_usdc");

    let merkle: Value = serde_json::from_str(MERKLE_JSON)?;
    let claims: Value = serde_json::from_str(CLAIM_JSON)?;
    let tree = merkle["trees"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "claim-demo")
        .unwrap();
    let run_key = tree["run_key"].as_str().unwrap();
    let total: u128 = tree["total_amount"].as_str().unwrap().parse()?;

    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?; // test.near
    let owner = sub(&root, "owner", 5).await?;
    let relayer = sub(&root, "relayer", 5).await?;
    let creator = sub(&root, "creator", 5).await?;
    let approver1 = sub(&root, "approver1", 5).await?;
    let approver2 = sub(&root, "approver2", 5).await?;
    let ben = sub(&root, "ben", 5).await?;
    let stranger = sub(&root, "stranger", 5).await?;

    // The claim vectors are signed for the contract ID `blindroll.test.near`.
    let usdc = sub(&root, "usdc", 10)
        .await?
        .deploy(&usdc_wasm)
        .await?
        .into_result()?;
    let blindroll = sub(&root, "blindroll", 10)
        .await?
        .deploy(&blindroll_wasm)
        .await?
        .into_result()?;
    assert_eq!(
        blindroll.id().as_str(),
        claims["cases"][0]["contract_id"].as_str().unwrap()
    );

    usdc.call("new").transact().await?.into_result()?;
    blindroll
        .call("new")
        .args_json(json!({ "owner": owner.id(), "token_id": usdc.id(), "relayer": relayer.id() }))
        .transact()
        .await?
        .into_result()?;
    let cfg: Value = blindroll.view("get_config").await?.json()?;
    assert_eq!(cfg["token_id"], usdc.id().as_str());
    assert_eq!(cfg["paused"], false);

    // Mint test USDC to the creator and register the Blindroll contract on the token.
    creator
        .call(usdc.id(), "mint")
        .args_json(json!({ "account_id": creator.id(), "amount": "10000000000" }))
        .transact()
        .await?
        .into_result()?;
    creator
        .call(usdc.id(), "storage_deposit")
        .args_json(json!({ "account_id": blindroll.id(), "registration_only": true }))
        .deposit(NearToken::from_yoctonear(1_250_000_000_000_000_000_000))
        .transact()
        .await?
        .into_result()?;

    let now_ms = worker.view_block().await?.timestamp() / 1_000_000;
    let contract_before = blindroll.view_account().await?;
    creator
        .call(blindroll.id(), "create_run")
        .args_json(json!({
            "run_key": run_key,
            "approvers": [approver1.id(), approver2.id()],
            "threshold": 2,
            "merkle_root_hex": tree["root"],
            "report_hash_hex": HASH_AB,
            "recipient_count": 5,
            "total_amount": total.to_string(),
            "claim_deadline_ms": now_ms + 3_600_000,
            "refund_account": creator.id(),
        }))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    // The creator is charged exactly: run storage + 5 × (claim record storage + token registration).
    let contract_after = blindroll.view_account().await?;
    let gained = contract_after
        .balance
        .saturating_sub(contract_before.balance)
        .as_yoctonear();
    let run_bytes = (contract_after.storage_usage - contract_before.storage_usage) as u128;
    let byte_cost = 10_000_000_000_000_000_000u128;
    let per_recipient = 100 * byte_cost + 1_250_000_000_000_000_000_000;
    println!("create_run: {run_bytes} bytes of run storage, creator charged {gained} yoctoNEAR");
    assert_eq!(gained, run_bytes * byte_cost + 5 * per_recipient);

    // Funding before approval is returned in full.
    let fund = |amount: u128| {
        creator
            .call(usdc.id(), "ft_transfer_call")
            .args_json(json!({
                "receiver_id": blindroll.id(),
                "amount": amount.to_string(),
                "msg": json!({ "fund_run": run_key }).to_string(),
            }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(100))
            .transact()
    };
    fund(total).await?.into_result()?;
    assert_eq!(balance(&usdc, blindroll.id().as_str()).await?, 0);
    assert_eq!(run(&blindroll, run_key).await?["status"], "Draft");

    for a in [&approver1, &approver2] {
        a.call(blindroll.id(), "approve_run")
            .args_json(json!({ "run_key": run_key }))
            .transact()
            .await?
            .into_result()?;
    }
    assert_eq!(run(&blindroll, run_key).await?["status"], "Approved");

    // Overfund by 1 USDC: the excess comes back.
    fund(total + 1_000_000).await?.into_result()?;
    assert_eq!(balance(&usdc, blindroll.id().as_str()).await?, total);
    assert_eq!(
        balance(&usdc, creator.id().as_str()).await?,
        10_000_000_000 - total
    );
    let r = run(&blindroll, run_key).await?;
    assert_eq!(r["status"], "Active");
    assert_eq!(r["funded_amount"], total.to_string());

    let near_balance_before = blindroll.view_account().await?.balance;

    // NEAR recipient (leaf 1 = ben.test.near) claims to their own, not yet registered, account.
    assert_eq!(tree["leaves"][1]["address"], ben.id().as_str());
    let near_claim = json!({
        "run_key": run_key,
        "leaf": tree["leaves"][1],
        "proof": tree["proofs"][1],
        "payout": { "kind": "near_ft", "receiver": ben.id() },
    });
    // Someone else cannot claim Ben's leaf.
    let res = stranger
        .call(blindroll.id(), "claim_near")
        .args_json(&near_claim)
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(
        format!("{:?}", res.into_result().unwrap_err())
            .contains("Only the recipient account can claim this leaf")
    );
    let res = ben
        .call(blindroll.id(), "claim_near")
        .args_json(&near_claim)
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    println!("claim_near gas burnt: {}", res.total_gas_burnt);
    assert!(
        res.logs()
            .iter()
            .any(|l| l.contains(r#""event":"claimed""#)),
        "logs: {:?}",
        res.logs()
    );
    res.into_result()?;
    assert_eq!(balance(&usdc, ben.id().as_str()).await?, 800_000_000);

    // EVM recipient #0: relayer submits the signed claim, USDC goes to the signed NEAR receiver.
    let case0 = &claims["cases"][0];
    // A relayer that swaps the payout target is rejected by the on-chain signature check.
    let mut redirected = evm_args(case0, tree);
    redirected["payout"] = json!({ "kind": "near_ft", "receiver": relayer.id() });
    let res = relayer
        .call(blindroll.id(), "claim_evm")
        .args_json(&redirected)
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(
        format!("{:?}", res.into_result().unwrap_err())
            .contains("Signature does not match the leaf address")
    );
    // A signature from another key is rejected.
    let mut forged = evm_args(case0, tree);
    forged["signature_hex"] = case0["wrong_signer_signature"].clone();
    let res = relayer
        .call(blindroll.id(), "claim_evm")
        .args_json(&forged)
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(
        format!("{:?}", res.into_result().unwrap_err())
            .contains("Signature does not match the leaf address")
    );

    let res = relayer
        .call(blindroll.id(), "claim_evm")
        .args_json(evm_args(case0, tree))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    println!("claim_evm (near_ft) gas burnt: {}", res.total_gas_burnt);
    res.into_result()?;
    assert_eq!(
        balance(&usdc, case0["payout_target"].as_str().unwrap()).await?,
        1_200_500_000
    );

    // Replay of the same signed claim fails.
    let res = stranger
        .call(blindroll.id(), "claim_evm")
        .args_json(evm_args(case0, tree))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(format!("{:?}", res.into_result().unwrap_err()).contains("already been claimed"));

    // EVM recipient #1: oneclick payout to a deposit address (an implicit NEAR account).
    let case1 = &claims["cases"][1];
    let res = stranger
        .call(blindroll.id(), "claim_evm")
        .args_json(evm_args(case1, tree))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    println!("claim_evm (oneclick) gas burnt: {}", res.total_gas_burnt);
    res.into_result()?;
    assert_eq!(
        balance(&usdc, case1["payout_target"].as_str().unwrap()).await?,
        950_000_000
    );

    // Callbacks are private.
    let res = stranger
        .call(blindroll.id(), "on_payout")
        .args_json(json!({ "run_key": run_key, "leaf_hash_hex": tree["leaf_hashes"][3], "amount": "1", "payout_kind": "near_ft" }))
        .transact()
        .await?;
    assert!(res.is_failure());

    // Accounting on-chain matches the token balances.
    let claimed = 800_000_000 + 1_200_500_000 + 950_000_000u128;
    let r = run(&blindroll, run_key).await?;
    assert_eq!(r["claimed_amount"], claimed.to_string());
    assert_eq!(
        balance(&usdc, blindroll.id().as_str()).await?,
        total - claimed
    );
    for (i, expected) in [(0, true), (1, true), (2, true), (3, false), (4, false)] {
        let c: bool = blindroll
            .view("is_claimed")
            .args_json(json!({ "run_key": run_key, "leaf_hash_hex": tree["leaf_hashes"][i] }))
            .await?
            .json()?;
        assert_eq!(c, expected, "leaf {i}");
    }

    // Three token registrations (0.00125 NEAR each) were paid from the creator's prepayment.
    let near_balance_after = blindroll.view_account().await?.balance;
    let spent = near_balance_before.saturating_sub(near_balance_after);
    println!(
        "contract NEAR spent on 3 claims: {} yoctoNEAR",
        spent.as_yoctonear()
    );
    assert!(
        spent < NearToken::from_millinear(5),
        "contract spent {spent}"
    );

    // The mock token refuses to exist outside test networks: see mock-usdc unit tests.
    Ok(())
}
