# Sample CSVs

`payroll-messy.csv` is the demo input. All names, emails and addresses are fictional.

Expected results after mapping, normalization and rules:

| Row | Contributor | Expected finding |
|---|---|---|
| 4 | (blank) | Dropped as an empty row |
| 6 | Asha Rao (second time) | `R004_duplicate_address` — error |
| 7 | Elif Kaya, 9,500 | `R006_outlier_vs_run` — warning (> 5 × median) |
| 8 | Farid Haddad, EUR | `R002_unknown_currency` — error |
| 9 | Grace Lim, `0x123` | `R001_invalid_address` — error |

Expected AI mapping: `name=Contributor`, `email=E-mail`, `address=Wallet Addr`, `amount=Amt (USD)`, `currency=currency`, `role=Role`, `memo=Notes`, `chain=null` (inferred from address format).

The run median (all non-empty rows) is 1,050, so 9,500 is above 5 × median.

After removing rows 6, 8 and 9 and overriding row 7, the clean table has 6 recipients: 4 EVM (Asha, Chen, Dana, Elif) and 2 NEAR (Ben, Hiro). Amounts in USDC base units: Asha `1200500000`, Ben `800000000`, Chen `950000000`, Dana `1100000000`, Elif `9500000000`, Hiro `1050000000`. Total `14600500000` (14,600.50 USDC).

## `payroll-sandbox.csv` (judge sandbox)

The same header and the same five mistakes as `payroll-messy.csv`, with amounts small enough for the judge sandbox's limits (at most 10 rows and 1,000 USDC per run; docs/09 "Judge sandbox"). The upload screen links a copy served from `apps/web/public/samples/` (a test checks both files are identical). It is a different file, so its first live upload costs one AI call; later uploads reuse the cached mapping.

| Row | Contributor | Expected finding |
|---|---|---|
| 4 | (blank) | Dropped as an empty row |
| 6 | Asha Rao (second time) | `R004_duplicate_address`: error |
| 7 | Elif Kaya, 475 | `R006_outlier_vs_run`: warning (> 5 × median) |
| 8 | Farid Haddad, EUR | `R002_unknown_currency`: error |
| 9 | Grace Lim, `0x123` | `R001_invalid_address`: error |

After removing rows 6, 8 and 9 and overriding row 7: 6 recipients, total `730500000` base units (730.50 USDC). The people are fictional, so nobody can claim from it; to try a claim, add yourself as a payee by hand.
