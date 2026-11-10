# 14 — Resources

✓ = opened and read while writing these docs (Nov 2026). Others are standard references; confirm before relying on details.

## NEAR Intents / 1Click
| Resource | Link |
|---|---|
| ✓ 1Click API overview | https://docs.near-intents.org/integration/distribution-channels/1click-api |
| ✓ 1Click quickstart (no testnet; JWT avoids 0.25% fee) | https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart |
| ✓ Making a request (endpoints, quote fields, statuses) | https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request.md |
| ✓ Authentication (partner JWT, User-Session token) | https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication.md |
| ✓ Confidential Intents | https://docs.near-intents.org/integration/market-makers/confidential-intents |
| Full docs index for LLMs | https://docs.near-intents.org/llms.txt |
| Partner dashboard (get JWT) | https://partners.near-intents.org |
| Intents explorer | https://explorer.near-intents.org |
| API base URL | `https://1click.chaindefuser.com/v0` |

## NEAR AI Cloud
| Resource | Link |
|---|---|
| ✓ Quickstart (base URL, auth, OpenAI-compatible) | https://docs.near.ai/cloud/quickstart |
| Models list | https://docs.near.ai/cloud/models.md |
| ✓ Verification overview | https://docs.near.ai/cloud/verification |
| ✓ Response signatures | https://docs.near.ai/cloud/verification/cloud-api/response-signatures.md |
| Gateway attestation | https://docs.near.ai/cloud/verification/cloud-api/gateway-attestation.md |
| Model attestations | https://docs.near.ai/cloud/verification/cloud-api/model-attestations.md |
| Quote, nonce and signer bindings | https://docs.near.ai/cloud/verification/reference/quote-nonce-signer.md |
| Verification Center (no-code) | https://cloud.near.ai/verify |
| Free $10 credits: join NEAR Builders, then claim in the builder dashboard (separate API key with a $10 balance, not added to a cloud.near.ai account) | https://nearbuilders.org/join → https://nearbuilders.org/dashboard |
| Paid credits (crypto or card) and API keys | https://cloud.near.ai |
| Verification example repo | https://github.com/near-examples/nearai-cloud-verification-example |
| Official verifier | https://github.com/nearai/nearai-cloud-verifier |

## NEAR core
| Resource | Link |
|---|---|
| NEAR docs | https://docs.near.org |
| `near-sdk` (Rust) API, incl. `env::ecrecover`, `env::ed25519_verify` | https://docs.rs/near-sdk |
| cargo-near | https://github.com/near/cargo-near |
| near-workspaces (Rust) | https://github.com/near/near-workspaces-rs |
| near-api-js | https://github.com/near/near-api-js |
| Wallet Selector | https://github.com/near/wallet-selector |
| Meta-transactions guide | https://docs.near.org/chain-abstraction/meta-transactions |
| NEP-141 fungible token | https://github.com/near/NEPs/blob/master/neps/nep-0141.md |
| NEP-145 storage management | https://github.com/near/NEPs/blob/master/neps/nep-0145.md |
| NEP-297 events | https://github.com/near/NEPs/blob/master/neps/nep-0297.md |
| NEP-366 meta-transactions | https://github.com/near/NEPs/blob/master/neps/nep-0366.md |
| NEP-413 signed messages | https://github.com/near/NEPs/blob/master/neps/nep-0413.md |
| Testnet explorer | https://testnet.nearblocks.io |
| Mainnet explorer | https://nearblocks.io |
| Testnet faucet / account creation | via https://docs.near.org (testnet wallet links) |
| Native USDC contract ID on NEAR | Confirm from Circle's USDC contract addresses page or NEAR docs before use |

## Other standards
| Resource | Link |
|---|---|
| EIP-191 signed data | https://eips.ethereum.org/EIPS/eip-191 |
| RFC 8785 JSON canonicalization | https://www.rfc-editor.org/rfc/rfc8785 |
| viem `verifyMessage` | https://viem.sh/docs/utilities/verifyMessage |

## Reference hackathon repos (read for patterns, don't copy blindly)
| Repo | Useful for |
|---|---|
| ✓ https://github.com/chipsforbeer/near-supply-mcp | Confidential Intents payouts via 1Click (`payment-mcp/src/rails/`), human-approved payments |
| ✓ https://github.com/Nassami1/privatepay-agent | NEAR AI Cloud TEE calls, attestation + signature checks, policy contract with caps and duplicate refusal |
| ✓ https://github.com/tmdry4530/tee-receipts | Anchoring NEAR AI signatures on-chain; verifying in the contract |
| ✓ https://github.com/khrisdidukh/veridom-pay | Contract verifying an enclave ed25519 signature over `<model>:<req hash>:<resp hash>` |
| ✓ https://github.com/ace-coderr/penstock | 1Click quotes, deposit/status handling, CSV export, real vs simulated labelling |
| ✓ https://github.com/Don-Vicks/aftercall | Agent wallet with caps; contractor payouts in USDC |
| ✓ https://github.com/GOSUN-CAPITAL/omniyield-protocol | NEP-366 relayer route |
| ✓ https://github.com/DataBlock-Labs/intents-desk-public | 1Click failure modes (refunds, `QUOTE_EXPIRED`) |
| ✓ https://github.com/nftkingiii/jurat | Reading confidential balances in a TEE |
| Hackathon site | https://nearhackathon.com |
