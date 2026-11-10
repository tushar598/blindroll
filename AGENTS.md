# AGENTS.md — rules for anyone building Blindroll

Blindroll is claim-based payroll on NEAR for the NEAR Hackathon (Real-World Money + Privacy & Private AI).

## Read first
1. `docs/README.md` (index and key decisions)
2. `docs/12-build-plan.md` (what to build, in what order)
3. The spec for the part you're working on (`docs/04` contract, `docs/05` AI, `docs/06` rails, `docs/07` claims, `docs/09` API)

## Non-negotiable rules
1. **Specs are the source of truth.** If code must differ from a spec, update the spec in the same change and say why.
2. **The leaf format, Merkle rules and claim message must match byte for byte** between `packages/core` and the contract. Shared test vectors prove it.
3. **The AI never decides payments.** It only returns a schema-validated column mapping and optional explanations.
4. **Money is integers.** `bigint` / `u128` base units. No floats anywhere near amounts.
5. **Never overclaim privacy.** Use only the wording allowed in `docs/08-privacy-model.md`.
6. **Label simulated things.** `simulated: true` in API responses, a "Simulated" badge in the UI, and a row in the README's real-vs-simulated table.
7. **No secrets in git.** Only `.env.example`. Never log private keys, JWTs, API keys or decrypted rows.
8. **Verify external APIs against the live docs** (`docs/14-resources.md`) before relying on a field name. If a response differs from the docs, update `docs/06` and the types.
9. **Tests before deploy.** `cargo test`, `vitest`, and the sandbox integration test must pass.
10. **Stay in MVP scope.** Items in the cut list (`docs/12`) wait until the MVP works end to end.
11. **Don't waste NEAR AI Cloud credits.** One mapping call per run, a small model, recorded fixtures for all tests, live calls only behind `NEAR_AI_LIVE=1`, cache by CSV hash. Full rules: `docs/05-ai-pipeline-and-attestation.md` → "Avoid wasting NEAR AI Cloud credits".

## Commands
```
pnpm install
pnpm -r test                                  # vitest (packages/core)
pnpm -r typecheck
pnpm vectors                                  # regenerate packages/core/test-vectors/*.json after a format change
pnpm --filter web dev
cd contracts && cargo test                    # unit tests + sandbox test (needs cargo-near; builds the wasm files)
cd contracts && cargo test --lib              # unit tests only (fast)
cd contracts/blindroll && cargo near build non-reproducible-wasm
```
