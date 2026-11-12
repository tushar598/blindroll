//! Blindroll: claim-based payroll on NEAR.
//!
//! Spec: `docs/04-smart-contract-spec.md` (state, methods, events, invariants) and
//! `docs/07-wallet-verification-and-claims.md` (claim message). If this file must differ
//! from the spec, change the spec in the same commit.

pub mod merkle;
pub mod sig;

#[cfg(test)]
mod tests;

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env, near,
    require,
};

use merkle::{from_hex, is_valid_run_key, to_hex};

/// Storage deposit attached to `storage_deposit(registration_only: true)` on the token for every
/// payout target. NEP-145 tokens refund it when the account is already registered.
pub const TOKEN_STORAGE_DEPOSIT: NearToken =
    NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
/// Bytes of contract storage reserved per recipient for the `claimed` record (about 91 used).
pub const CLAIM_STORAGE_BYTES: u64 = 100;
/// Claims are refused if paying the token storage deposit would leave less than this spare balance.
pub const MIN_RESERVE: NearToken = NearToken::from_millinear(100);

pub const GAS_FOR_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
pub const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(15);
pub const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(10);

pub const MAX_APPROVERS: usize = 10;
pub const MAX_VIEW_LIMIT: u32 = 50;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Runs,
    Claimed,
    RunsByApprover,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunStatus {
    Draft,
    Approved,
    Active,
    Closed,
    Cancelled,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Run {
    pub run_key: String,
    pub creator: AccountId,
    pub approvers: Vec<AccountId>,
    pub threshold: u8,
    pub approvals: Vec<AccountId>,
    pub merkle_root: [u8; 32],
    pub report_hash: [u8; 32],
    pub recipient_count: u32,
    /// USDC base units (6 decimals).
    pub total_amount: u128,
    pub funded_amount: u128,
    /// Includes in-flight transfers.
    pub claimed_amount: u128,
    /// Sent to `refund_account` by `reclaim_unclaimed` (includes in-flight transfers).
    pub reclaimed_amount: u128,
    pub claim_deadline_ms: u64,
    pub refund_account: AccountId,
    pub status: RunStatus,
}

/// What was paid for one claimed leaf. Written when the claim is made, so later accounting
/// (failed payout, reopen) never depends on an amount supplied by a caller.
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct ClaimRecord {
    /// USDC base units taken from the run for this leaf.
    pub amount: u128,
    /// True for a `oneclick` payout (the only kind that can be refunded and reopened).
    pub oneclick: bool,
    /// False while the token transfer is in flight; true once `on_payout` saw it succeed.
    pub settled: bool,
}

/// JSON view of a run: hashes as lowercase hex, amounts as decimal strings.
#[near(serializers = [json])]
pub struct RunView {
    pub run_key: String,
    pub creator: AccountId,
    pub approvers: Vec<AccountId>,
    pub threshold: u8,
    pub approvals: Vec<AccountId>,
    pub merkle_root: String,
    pub report_hash: String,
    pub recipient_count: u32,
    pub total_amount: U128,
    pub funded_amount: U128,
    pub claimed_amount: U128,
    pub reclaimed_amount: U128,
    pub claim_deadline_ms: u64,
    pub refund_account: AccountId,
    pub status: RunStatus,
}

impl From<&Run> for RunView {
    fn from(r: &Run) -> Self {
        Self {
            run_key: r.run_key.clone(),
            creator: r.creator.clone(),
            approvers: r.approvers.clone(),
            threshold: r.threshold,
            approvals: r.approvals.clone(),
            merkle_root: to_hex(&r.merkle_root),
            report_hash: to_hex(&r.report_hash),
            recipient_count: r.recipient_count,
            total_amount: U128(r.total_amount),
            funded_amount: U128(r.funded_amount),
            claimed_amount: U128(r.claimed_amount),
            reclaimed_amount: U128(r.reclaimed_amount),
            claim_deadline_ms: r.claim_deadline_ms,
            refund_account: r.refund_account.clone(),
            status: r.status,
        }
    }
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub owner: AccountId,
    pub token_id: AccountId,
    pub relayer: AccountId,
    pub paused: bool,
}

/// One recipient row. `run_key` comes from the method argument, never from the leaf.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct Leaf {
    /// `near`, `evm` or `solana`.
    pub chain: String,
    pub address: String,
    /// Canonical decimal string of USDC base units.
    pub amount: String,
    /// 32 lowercase hex chars.
    pub salt_hex: String,
}

/// Where the USDC goes. Both variants resolve to an `ft_transfer` to a NEAR account.
#[near(serializers = [json])]
#[derive(Clone)]
#[serde(tag = "kind")]
pub enum Payout {
    /// USDC on NEAR, straight to `receiver`.
    #[serde(rename = "near_ft")]
    NearFt { receiver: AccountId },
    /// A 1Click deposit address on NEAR; 1Click then delivers the destination asset.
    #[serde(rename = "oneclick")]
    OneClick { deposit_address: AccountId },
}

impl Payout {
    pub fn kind(&self) -> &'static str {
        match self {
            Payout::NearFt { .. } => "near_ft",
            Payout::OneClick { .. } => "oneclick",
        }
    }

    pub fn target(&self) -> &AccountId {
        match self {
            Payout::NearFt { receiver } => receiver,
            Payout::OneClick { deposit_address } => deposit_address,
        }
    }
}

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
struct FundMsg {
    fund_run: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Blindroll {
    owner: AccountId,
    token_id: AccountId,
    relayer: AccountId,
    paused: bool,
    runs: LookupMap<String, Run>,
    /// Keyed by `sha256(run_key || leaf_hash)`.
    claimed: LookupMap<[u8; 32], ClaimRecord>,
    runs_by_approver: LookupMap<AccountId, Vec<String>>,
}

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "blindroll", "version": "1.0.0", "event": event, "data": [data] })
    ));
}

fn claimed_key(run_key: &str, leaf_hash: &[u8; 32]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(run_key.len() + 32);
    buf.extend_from_slice(run_key.as_bytes());
    buf.extend_from_slice(leaf_hash);
    env::sha256_array(&buf[..])
}

fn parse_hash(hex: &str, what: &str) -> [u8; 32] {
    from_hex::<32>(hex)
        .unwrap_or_else(|| env::panic_str(&format!("{what} must be 64 lowercase hex chars")))
}

fn callback_succeeded() -> bool {
    // The token calls return no data; a bounded read keeps the callback's gas use fixed.
    env::promise_results_count() == 1
        && matches!(
            env::promise_result_checked(0, 64),
            Ok(_) | Err(PromiseError::TooLong(_))
        )
}

#[near]
impl Blindroll {
    // ───────────── Admin ─────────────

    #[init]
    pub fn new(owner: AccountId, token_id: AccountId, relayer: AccountId) -> Self {
        Self {
            owner,
            token_id,
            relayer,
            paused: false,
            runs: LookupMap::new(StorageKey::Runs),
            claimed: LookupMap::new(StorageKey::Claimed),
            runs_by_approver: LookupMap::new(StorageKey::RunsByApprover),
        }
    }

    pub fn set_relayer(&mut self, relayer: AccountId) {
        self.assert_owner();
        self.relayer = relayer;
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    // ───────────── Run lifecycle ─────────────

    /// Creates a run in `Draft`. The attached deposit pays for the run's storage plus
    /// `recipient_count × (claim-record storage + token storage deposit)`; the rest is refunded.
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn create_run(
        &mut self,
        run_key: String,
        approvers: Vec<AccountId>,
        threshold: u8,
        merkle_root_hex: String,
        report_hash_hex: String,
        recipient_count: u32,
        total_amount: U128,
        claim_deadline_ms: u64,
        refund_account: AccountId,
    ) {
        self.assert_not_paused();
        require!(
            is_valid_run_key(&run_key),
            "run_key must match [A-Za-z0-9_-]{1,64}"
        );
        require!(!self.runs.contains_key(&run_key), "run_key already exists");
        require!(
            (1..=MAX_APPROVERS).contains(&approvers.len()),
            "approvers must contain 1 to 10 accounts"
        );
        for (i, a) in approvers.iter().enumerate() {
            require!(!approvers[..i].contains(a), "approvers must be unique");
        }
        require!(
            threshold >= 1 && threshold as usize <= approvers.len(),
            "threshold must be between 1 and the number of approvers"
        );
        let merkle_root = parse_hash(&merkle_root_hex, "merkle_root_hex");
        let report_hash = parse_hash(&report_hash_hex, "report_hash_hex");
        require!(recipient_count >= 1, "recipient_count must be at least 1");
        require!(total_amount.0 > 0, "total_amount must be greater than 0");
        require!(
            claim_deadline_ms > env::block_timestamp_ms(),
            "claim_deadline_ms must be in the future"
        );

        let creator = env::predecessor_account_id();
        let storage_before = env::storage_usage();

        for a in &approvers {
            let mut keys = self.runs_by_approver.get(a).cloned().unwrap_or_default();
            keys.push(run_key.clone());
            self.runs_by_approver.insert(a.clone(), keys);
        }
        let run = Run {
            run_key: run_key.clone(),
            creator: creator.clone(),
            approvers,
            threshold,
            approvals: Vec::new(),
            merkle_root,
            report_hash,
            recipient_count,
            total_amount: total_amount.0,
            funded_amount: 0,
            claimed_amount: 0,
            reclaimed_amount: 0,
            claim_deadline_ms,
            refund_account,
            status: RunStatus::Draft,
        };
        self.runs.insert(run_key.clone(), run);
        // Write through to storage now so storage_usage() reflects this run.
        self.runs.flush();
        self.runs_by_approver.flush();

        let run_bytes = env::storage_usage().saturating_sub(storage_before);
        let per_recipient = env::storage_byte_cost()
            .saturating_mul(CLAIM_STORAGE_BYTES as u128)
            .saturating_add(TOKEN_STORAGE_DEPOSIT);
        let cost = env::storage_byte_cost()
            .saturating_mul(run_bytes as u128)
            .saturating_add(per_recipient.saturating_mul(recipient_count as u128));
        let attached = env::attached_deposit();
        require!(
            attached >= cost,
            format!(
                "Attach at least {} yoctoNEAR for storage",
                cost.as_yoctonear()
            )
        );
        let refund = attached.saturating_sub(cost);
        if !refund.is_zero() {
            Promise::new(creator.clone()).transfer(refund).detach();
        }

        emit(
            "run_created",
            json!({
                "run_key": run_key,
                "creator": creator,
                "merkle_root": merkle_root_hex,
                "report_hash": report_hash_hex,
                "total_amount": total_amount,
                "recipient_count": recipient_count,
                "claim_deadline_ms": claim_deadline_ms,
            }),
        );
    }

    pub fn approve_run(&mut self, run_key: String) {
        let mut run = self.expect_run(&run_key);
        let approver = env::predecessor_account_id();
        require!(
            run.approvers.contains(&approver),
            "Only an approver of this run can approve it"
        );
        require!(run.status == RunStatus::Draft, "Run is not in Draft");
        require!(
            !run.approvals.contains(&approver),
            "Already approved by this account"
        );
        run.approvals.push(approver.clone());
        if run.approvals.len() >= run.threshold as usize {
            run.status = RunStatus::Approved;
        }
        emit(
            "run_approved",
            json!({
                "run_key": run_key,
                "approver": approver,
                "approvals": run.approvals.len(),
                "status": run.status,
            }),
        );
        self.runs.insert(run_key, run);
    }

    pub fn cancel_run(&mut self, run_key: String) {
        let mut run = self.expect_run(&run_key);
        let approver = env::predecessor_account_id();
        require!(
            run.approvers.contains(&approver),
            "Only an approver of this run can cancel it"
        );
        require!(
            matches!(run.status, RunStatus::Draft | RunStatus::Approved),
            "Only Draft or Approved runs can be cancelled"
        );
        require!(
            run.funded_amount == 0,
            "Run already has funds; it cannot be cancelled"
        );
        run.status = RunStatus::Cancelled;
        emit(
            "run_cancelled",
            json!({ "run_key": run_key, "by": approver }),
        );
        self.runs.insert(run_key, run);
    }

    /// NEP-141 receiver. `msg` = `{"fund_run":"<run_key>"}`. Returns the unused amount.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        require!(
            env::predecessor_account_id() == self.token_id,
            "Only the configured token can fund runs"
        );
        let _ = sender_id;
        if self.paused {
            return amount;
        }
        let Ok(FundMsg { fund_run: run_key }) = serde_json::from_str::<FundMsg>(&msg) else {
            return amount;
        };
        let Some(mut run) = self.runs.get(&run_key).cloned() else {
            return amount;
        };
        if run.status != RunStatus::Approved || env::block_timestamp_ms() > run.claim_deadline_ms {
            return amount;
        }
        let accepted = amount.0.min(run.total_amount - run.funded_amount);
        if accepted == 0 {
            return amount;
        }
        run.funded_amount += accepted;
        if run.funded_amount == run.total_amount {
            run.status = RunStatus::Active;
        }
        emit(
            "run_funded",
            json!({
                "run_key": run_key,
                "amount": U128(accepted),
                "funded_amount": U128(run.funded_amount),
                "status": run.status,
            }),
        );
        self.runs.insert(run_key, run);
        U128(amount.0 - accepted)
    }

    /// After the deadline, sends everything that is neither claimed nor already reclaimed to
    /// `refund_account` and closes the run. Callable again if a later failed payout or a
    /// reopened claim frees more funds.
    pub fn reclaim_unclaimed(&mut self, run_key: String) -> Option<Promise> {
        let mut run = self.expect_run(&run_key);
        require!(
            matches!(
                run.status,
                RunStatus::Approved | RunStatus::Active | RunStatus::Closed
            ),
            "Run has no funds to reclaim"
        );
        require!(
            env::block_timestamp_ms() > run.claim_deadline_ms,
            "Claim deadline has not passed"
        );
        let amount = run.funded_amount - run.claimed_amount - run.reclaimed_amount;
        require!(
            amount > 0 || run.status != RunStatus::Closed,
            "Nothing to reclaim"
        );
        run.status = RunStatus::Closed;
        run.reclaimed_amount += amount;
        let refund_account = run.refund_account.clone();
        self.runs.insert(run_key.clone(), run);
        emit(
            "run_closed",
            json!({ "run_key": run_key, "reclaimed_amount": U128(amount) }),
        );
        if amount == 0 {
            return None;
        }
        self.assert_reserve();
        Some(
            self.token_payment(&refund_account, amount).then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_CALLBACK)
                    .on_reclaim(run_key, U128(amount)),
            ),
        )
    }

    #[private]
    pub fn on_reclaim(&mut self, run_key: String, amount: U128) -> bool {
        let ok = callback_succeeded();
        if !ok {
            let mut run = self.expect_run(&run_key);
            run.reclaimed_amount = run.reclaimed_amount.saturating_sub(amount.0);
            self.runs.insert(run_key.clone(), run);
            emit(
                "reclaim_failed",
                json!({ "run_key": run_key, "amount": amount }),
            );
        }
        ok
    }

    // ───────────── Claims ─────────────

    /// Claim by a NEAR recipient. The caller must be the leaf's address (directly, or through a
    /// NEP-366 meta-transaction where the predecessor is still the recipient).
    pub fn claim_near(
        &mut self,
        run_key: String,
        leaf: Leaf,
        proof: Vec<String>,
        payout: Payout,
    ) -> Promise {
        let (run, leaf_hash, amount) = self.check_claim(&run_key, &leaf, &proof);
        require!(leaf.chain == "near", "claim_near requires a near leaf");
        require!(
            env::predecessor_account_id().as_str() == leaf.address,
            "Only the recipient account can claim this leaf"
        );
        self.pay_claim(run, leaf_hash, amount, payout)
    }

    /// Gas-free claim for a NEAR recipient: the relayer submits it and pays the gas.
    /// There is no payout argument and no recipient signature, because the relayer has no
    /// choice to make: the USDC can only go, as USDC on NEAR, to the leaf's own account.
    /// Only the configured relayer may call this, so a stranger cannot decide when a
    /// recipient's payout is triggered. Any other payout (another receiver, 1Click) still
    /// needs the recipient's own call to `claim_near`.
    pub fn claim_near_relayed(
        &mut self,
        run_key: String,
        leaf: Leaf,
        proof: Vec<String>,
    ) -> Promise {
        require!(
            env::predecessor_account_id() == self.relayer,
            "Only the relayer can call this"
        );
        let (run, leaf_hash, amount) = self.check_claim(&run_key, &leaf, &proof);
        require!(
            leaf.chain == "near",
            "claim_near_relayed requires a near leaf"
        );
        let receiver: AccountId = leaf
            .address
            .parse()
            .unwrap_or_else(|_| env::panic_str("The leaf address is not a NEAR account ID"));
        self.pay_claim(run, leaf_hash, amount, Payout::NearFt { receiver })
    }

    /// Claim by an EVM recipient. Anyone (normally the relayer) may submit; the recipient's
    /// personal_sign signature over the claim message authorizes this exact payout.
    #[allow(clippy::too_many_arguments)]
    pub fn claim_evm(
        &mut self,
        run_key: String,
        leaf: Leaf,
        proof: Vec<String>,
        payout: Payout,
        destination_asset: String,
        destination_address: String,
        expires_at_ms: u64,
        signature_hex: String,
    ) -> Promise {
        let (run, leaf_hash, amount) = self.check_claim(&run_key, &leaf, &proof);
        require!(leaf.chain == "evm", "claim_evm requires an evm leaf");
        require!(
            env::block_timestamp_ms() <= expires_at_ms,
            "Claim signature has expired"
        );
        let message = sig::build_claim_message(
            &env::current_account_id(),
            &run_key,
            &to_hex(&leaf_hash),
            payout.kind(),
            payout.target(),
            &destination_asset,
            &destination_address,
            expires_at_ms,
        )
        .unwrap_or_else(|e| env::panic_str(e));
        let signer = sig::recover_evm_address(&message, &signature_hex)
            .unwrap_or_else(|| env::panic_str("Invalid signature"));
        require!(
            signer == leaf.address,
            "Signature does not match the leaf address"
        );
        self.pay_claim(run, leaf_hash, amount, payout)
    }

    #[private]
    pub fn on_payout(
        &mut self,
        run_key: String,
        leaf_hash_hex: String,
        payout_kind: String,
    ) -> bool {
        let ok = callback_succeeded();
        let key = claimed_key(&run_key, &parse_hash(&leaf_hash_hex, "leaf_hash_hex"));
        if ok {
            if let Some(record) = self.claimed.get_mut(&key) {
                record.settled = true;
            }
            emit(
                "claimed",
                json!({ "run_key": run_key, "leaf_hash": leaf_hash_hex, "payout_kind": payout_kind }),
            );
        } else {
            // Release exactly what was recorded when the claim was made.
            if let Some(record) = self.claimed.remove(&key) {
                let mut run = self.expect_run(&run_key);
                run.claimed_amount -= record.amount;
                self.runs.insert(run_key.clone(), run);
            }
            emit(
                "claim_failed",
                json!({ "run_key": run_key, "leaf_hash": leaf_hash_hex }),
            );
        }
        ok
    }

    // ───────────── Refunds ─────────────

    /// For a 1Click payout that was refunded to this contract: lets the recipient claim again.
    /// Releases exactly the amount recorded when the leaf was claimed; the caller supplies none.
    pub fn reopen_claim(&mut self, run_key: String, leaf_hash_hex: String) {
        let mut run = self.expect_run(&run_key);
        let approver = env::predecessor_account_id();
        require!(
            run.approvers.contains(&approver),
            "Only an approver of this run can reopen a claim"
        );
        let key = claimed_key(&run_key, &parse_hash(&leaf_hash_hex, "leaf_hash_hex"));
        let record = self
            .claimed
            .get(&key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("This leaf is not marked as claimed"));
        require!(
            record.settled,
            "The payout for this leaf is still in flight"
        );
        require!(record.oneclick, "Only oneclick payouts can be reopened");
        self.claimed.remove(&key);
        run.claimed_amount -= record.amount;
        self.runs.insert(run_key.clone(), run);
        emit(
            "claim_reopened",
            json!({ "run_key": run_key, "leaf_hash": leaf_hash_hex, "by": approver }),
        );
    }

    // ───────────── Views ─────────────

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            token_id: self.token_id.clone(),
            relayer: self.relayer.clone(),
            paused: self.paused,
        }
    }

    pub fn get_run(&self, run_key: String) -> Option<RunView> {
        self.runs.get(&run_key).map(RunView::from)
    }

    pub fn is_claimed(&self, run_key: String, leaf_hash_hex: String) -> bool {
        from_hex::<32>(&leaf_hash_hex)
            .is_some_and(|h| self.claimed.contains_key(&claimed_key(&run_key, &h)))
    }

    pub fn get_runs_by_approver(
        &self,
        account_id: AccountId,
        from: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<RunView> {
        let Some(keys) = self.runs_by_approver.get(&account_id) else {
            return Vec::new();
        };
        keys.iter()
            .skip(from.unwrap_or(0) as usize)
            .take(limit.unwrap_or(MAX_VIEW_LIMIT).min(MAX_VIEW_LIMIT) as usize)
            .filter_map(|k| self.runs.get(k).map(RunView::from))
            .collect()
    }
}

impl Blindroll {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "Only the owner can call this"
        );
    }

    fn assert_not_paused(&self) {
        require!(!self.paused, "Contract is paused");
    }

    /// Refuses to spend the token storage deposit if that would eat into the reserve.
    fn assert_reserve(&self) {
        let locked = env::storage_byte_cost().saturating_mul(env::storage_usage() as u128);
        let spare = env::account_balance().saturating_sub(locked);
        require!(
            spare >= TOKEN_STORAGE_DEPOSIT.saturating_add(MIN_RESERVE),
            "Contract NEAR balance is below the reserve; top it up"
        );
    }

    fn expect_run(&self, run_key: &str) -> Run {
        self.runs
            .get(run_key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Run not found"))
    }

    /// Claim steps 1–3: run state, leaf hash, Merkle proof.
    fn check_claim(&self, run_key: &str, leaf: &Leaf, proof: &[String]) -> (Run, [u8; 32], u128) {
        self.assert_not_paused();
        let run = self.expect_run(run_key);
        require!(run.status == RunStatus::Active, "Run is not Active");
        require!(
            env::block_timestamp_ms() <= run.claim_deadline_ms,
            "Claim deadline has passed"
        );
        let amount = merkle::validate_leaf(
            run_key,
            &leaf.chain,
            &leaf.address,
            &leaf.amount,
            &leaf.salt_hex,
        )
        .unwrap_or_else(|e| env::panic_str(e));
        let leaf_hash = merkle::leaf_hash(
            run_key,
            &leaf.chain,
            &leaf.address,
            &leaf.amount,
            &leaf.salt_hex,
        )
        .unwrap_or_else(|e| env::panic_str(e));
        require!(
            merkle::verify_proof(&leaf_hash, proof, &run.merkle_root),
            "Invalid Merkle proof"
        );
        (run, leaf_hash, amount)
    }

    /// Claim steps 5–6: mark claimed, account for the amount, pay, and register the callback.
    fn pay_claim(
        &mut self,
        mut run: Run,
        leaf_hash: [u8; 32],
        amount: u128,
        payout: Payout,
    ) -> Promise {
        let run_key = run.run_key.clone();
        let key = claimed_key(&run_key, &leaf_hash);
        require!(
            !self.claimed.contains_key(&key),
            "This leaf has already been claimed"
        );
        self.claimed.insert(
            key,
            ClaimRecord {
                amount,
                oneclick: matches!(payout, Payout::OneClick { .. }),
                settled: false,
            },
        );
        let unspent = run.funded_amount - run.claimed_amount - run.reclaimed_amount;
        require!(amount <= unspent, "Claim exceeds the run's remaining funds");
        run.claimed_amount += amount;
        self.runs.insert(run_key.clone(), run);
        self.assert_reserve();

        self.token_payment(payout.target(), amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_CALLBACK)
                .on_payout(run_key, to_hex(&leaf_hash), payout.kind().to_string()),
        )
    }

    /// One receipt to the token: register the target (refunded if already registered), then
    /// transfer. The two actions are atomic: if either fails, both are reverted.
    fn token_payment(&self, target: &AccountId, amount: u128) -> Promise {
        Promise::new(self.token_id.clone())
            .function_call(
                "storage_deposit",
                json!({ "account_id": target, "registration_only": true })
                    .to_string()
                    .into_bytes(),
                TOKEN_STORAGE_DEPOSIT,
                GAS_FOR_STORAGE_DEPOSIT,
            )
            .function_call(
                "ft_transfer",
                json!({ "receiver_id": target, "amount": U128(amount) })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FOR_FT_TRANSFER,
            )
    }
}
