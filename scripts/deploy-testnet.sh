#!/usr/bin/env bash
# Deploys mock USDC and Blindroll to NEAR TESTNET under a parent account whose key is in the
# macOS keychain (NEAR CLI). Sends real testnet transactions; run it only on purpose.
#
#   PARENT=blindroll-dev.testnet RELAYER=relayer.blindroll-dev.testnet ./scripts/deploy-testnet.sh
#
# Creates  usdc.$PARENT       (mock USDC, test only)   funded with $USDC_NEAR
#          blindroll.$PARENT  (Blindroll contract)     funded with $BLINDROLL_NEAR
# then initializes both, registers Blindroll on the token and mints test USDC to $PARENT.
set -euo pipefail

PARENT="${PARENT:?set PARENT, e.g. blindroll-dev.testnet}"
RELAYER="${RELAYER:?set RELAYER, e.g. relayer.blindroll-dev.testnet}"
OWNER="${OWNER:-$PARENT}"
USDC_NEAR="${USDC_NEAR:-2}"            # 148 KB of code locks about 1.5 NEAR
BLINDROLL_NEAR="${BLINDROLL_NEAR:-3.2}" # 240 KB of code locks about 2.4 NEAR, plus a spare reserve
MINT_AMOUNT="${MINT_AMOUNT:-100000000000}" # 100,000 mUSDC (6 decimals)

# Mainnet guard: this script deploys the open-mint mock token, so it only accepts *.testnet.
for id in "$PARENT" "$RELAYER" "$OWNER"; do
  case "$id" in
    *.testnet) ;;
    *) echo "refusing: $id is not a *.testnet account (this script is testnet-only)" >&2; exit 1 ;;
  esac
done
NET=(network-config testnet)
USDC="usdc.$PARENT"
BLINDROLL="blindroll.$PARENT"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== tests first (AGENTS.md rule 9)"
(cd "$ROOT" && pnpm -r test)
(cd "$ROOT/contracts" && cargo test)

echo "== build"
(cd "$ROOT/contracts/mock-usdc" && cargo near build non-reproducible-wasm)
(cd "$ROOT/contracts/blindroll" && cargo near build non-reproducible-wasm)
USDC_WASM="$ROOT/contracts/target/near/mock_usdc/mock_usdc.wasm"
BLINDROLL_WASM="$ROOT/contracts/target/near/blindroll/blindroll.wasm"

echo "== create accounts"
near account create-account fund-myself "$USDC" "$USDC_NEAR NEAR" autogenerate-new-keypair save-to-keychain \
  sign-as "$PARENT" "${NET[@]}" sign-with-keychain send
near account create-account fund-myself "$BLINDROLL" "$BLINDROLL_NEAR NEAR" autogenerate-new-keypair save-to-keychain \
  sign-as "$PARENT" "${NET[@]}" sign-with-keychain send

echo "== deploy + init"
near contract deploy "$USDC" use-file "$USDC_WASM" with-init-call new json-args '{}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' "${NET[@]}" sign-with-keychain send
near contract deploy "$BLINDROLL" use-file "$BLINDROLL_WASM" with-init-call new \
  json-args "{\"owner\":\"$OWNER\",\"token_id\":\"$USDC\",\"relayer\":\"$RELAYER\"}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' "${NET[@]}" sign-with-keychain send

echo "== register Blindroll on the token, mint test USDC to $PARENT"
near contract call-function as-transaction "$USDC" storage_deposit \
  json-args "{\"account_id\":\"$BLINDROLL\",\"registration_only\":true}" \
  prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as "$PARENT" "${NET[@]}" sign-with-keychain send
near contract call-function as-transaction "$USDC" mint \
  json-args "{\"account_id\":\"$PARENT\",\"amount\":\"$MINT_AMOUNT\"}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$PARENT" "${NET[@]}" sign-with-keychain send

echo "== verify"
near contract call-function as-read-only "$BLINDROLL" get_config json-args '{}' "${NET[@]}" now
near contract call-function as-read-only "$USDC" ft_balance_of json-args "{\"account_id\":\"$PARENT\"}" "${NET[@]}" now

cat <<MSG

Deployed. Put these in .env.local at the repo root ($ROOT/.env.local), then run: pnpm env:check
  NEAR_NETWORK=testnet
  BLINDROLL_CONTRACT_ID=$BLINDROLL
  USDC_TOKEN_ID=$USDC
  RELAYER_ACCOUNT_ID=$RELAYER
Explorer: https://testnet.nearblocks.io/address/$BLINDROLL
MSG
