//! TEST ONLY. Open-mint NEP-141 token with 6 decimals, standing in for USDC on NEAR testnet
//! and in the local sandbox. Anyone can mint any amount, so it is worthless by design.
//!
//! Mainnet guard: `new` and `mint` panic unless the contract's own account ID ends with
//! `.testnet`, `.test.near` or `.sandbox`. On mainnet, Blindroll must be configured with
//! native USDC instead (see `docs/06-payout-rails.md`).

use near_contract_standards::fungible_token::metadata::{
    FT_METADATA_SPEC, FungibleTokenMetadata, FungibleTokenMetadataProvider,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{
    AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue, env, near, require,
};

/// Account ID suffixes that only exist on test networks.
pub const TEST_NETWORK_SUFFIXES: [&str; 3] = [".testnet", ".test.near", ".sandbox"];

pub fn is_test_network_account(account_id: &str) -> bool {
    TEST_NETWORK_SUFFIXES
        .iter()
        .any(|s| account_id.ends_with(s))
}

fn assert_test_network() {
    require!(
        is_test_network_account(env::current_account_id().as_str()),
        "mock-usdc is test-only: it refuses to run on an account that is not *.testnet, *.test.near or *.sandbox"
    );
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Token,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockUsdc {
    token: FungibleToken,
}

#[near]
impl MockUsdc {
    #[init]
    pub fn new() -> Self {
        assert_test_network();
        Self {
            token: FungibleToken::new(StorageKey::Token),
        }
    }

    /// Open mint for tests: credits `amount` base units to `account_id`, registering it if needed.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        assert_test_network();
        require!(amount.0 > 0, "amount must be greater than 0");
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.0);
        near_contract_standards::fungible_token::events::FtMint {
            owner_id: &account_id,
            amount,
            memo: Some("mock-usdc test mint"),
        }
        .emit();
    }
}

#[near]
impl FungibleTokenCore for MockUsdc {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for MockUsdc {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, _burned) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for MockUsdc {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for MockUsdc {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Mock USDC (test only, no value)".to_string(),
            symbol: "mUSDC".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn ctx(current: &str) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(current.parse().unwrap())
            .predecessor_account_id("alice.testnet".parse().unwrap());
        testing_env!(b.build());
    }

    #[test]
    fn mints_with_six_decimals_on_test_accounts() {
        ctx("usdc.blindroll.testnet");
        let mut c = MockUsdc::new();
        c.mint("alice.testnet".parse().unwrap(), U128(1_000_000));
        c.mint("alice.testnet".parse().unwrap(), U128(500_000));
        assert_eq!(
            c.ft_balance_of("alice.testnet".parse().unwrap()).0,
            1_500_000
        );
        assert_eq!(c.ft_total_supply().0, 1_500_000);
        assert_eq!(c.ft_metadata().decimals, 6);
    }

    #[test]
    fn guard_recognizes_only_test_networks() {
        assert!(is_test_network_account("usdc.me.testnet"));
        assert!(is_test_network_account("usdc.test.near"));
        assert!(is_test_network_account("usdc.sandbox"));
        for id in [
            "usdc.near",
            "usdc.blindroll.near",
            "testnet",
            "testnet.near",
            "usdc.tg",
            "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
            "0x8ba1f109551bd432803012645ac136ddd64dba72",
        ] {
            assert!(!is_test_network_account(id), "{id} must be refused");
        }
    }

    #[test]
    #[should_panic(expected = "mock-usdc is test-only")]
    fn refuses_to_initialize_on_a_mainnet_account() {
        ctx("usdc.blindroll.near");
        MockUsdc::new();
    }

    #[test]
    #[should_panic(expected = "mock-usdc is test-only")]
    fn refuses_to_mint_on_a_mainnet_account() {
        ctx("usdc.test.near");
        let mut c = MockUsdc::new();
        ctx("usdc.blindroll.near");
        c.mint("alice.near".parse().unwrap(), U128(1));
    }

    #[test]
    #[should_panic(expected = "amount must be greater than 0")]
    fn refuses_zero_mint() {
        ctx("usdc.test.near");
        MockUsdc::new().mint("alice.testnet".parse().unwrap(), U128(0));
    }
}
