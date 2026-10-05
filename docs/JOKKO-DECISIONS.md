# Jokko: recorded decisions

This is the owner's decision log. Each entry is binding on later work until it is explicitly revised. **None of these decisions authorizes a production write.**

## D-J2: Production and migration (recorded at J2 acceptance, 2026-10-03)

The J2 Money Kernel was accepted **locally**. It has not been deployed: production is untouched and branch deployments stay disabled.

| # | Decision | Applies to |
|---|---|---|
| D1 | Production investigation is **read-only first**. | Every production access |
| D2 | Do **not** baseline production migration history yet (`db:resolve-baseline` is not run). | `_prisma_migrations` in production |
| D3 | Keep the new database deployment step **disabled** (`MIGRATION_DEPLOY_ACTIVATED` unset; `db-migrate-deploy.mjs` exits 3). | `vercel-build` |
| D4 | Do not drop or transform unknown legacy data. | All legacy tables and columns (`JOKKO-LEGACY-SCHEMA.md`) |
| D5 | Do not classify unknown historical backing as either backed or deficient. It is modelled as **legacy / unverified** until reconciled (`migration:opening:*`, `differences.migrationOpening`). | Reserve and reconciliation |
| D6 | A **genuine post-migration reconciliation deficit** may trigger financial containment. Unknown legacy provenance on its own is surfaced and risk-managed **separately**: it is not a deficit and does not freeze. | `reconcileFromLedger`, coverage policy |
| D7 | Preserve the old XOF balances, KebuInvestment, KoriRedemption, Ñu Lekk and MerchantPromo until their meaning, data and dependencies are established. | Legacy value |
| D8 | Agent commissions must be **funded liabilities**, never fabricated wallet value. | `agent_commission`, payouts |
| D9 | Submitted partner payouts require provider reconciliation or admin review. | `partner-payouts-service` |
| D10 | Financial adjustments use **risk-based maker/checker**. High-risk or high-value operations need dual authorization. Tightly limited lower-risk adjustments may use a single authorized operator, with immutable audit history. | `money-kernel/admin.js`, J3 admin duties |

How these apply to the current code:
- **D5/D6:** `ledgerPosition()` already separates `migrationOpening` (legacy / unverified) from `suspense` and the real reconciliation exceptions. The integrity freeze applies only to genuine invariant or reconciliation failures. Coverage below 100 % caused by legacy openings is reported, not frozen.
- **D10:** J3 implements this as a policy table in `lib/money-kernel/admin.js`. A single operator holding the `finance.adjust.low` permission is allowed only below a low cap and only on non-customer accounts. Everything else goes through dual authorization. Every adjustment is append-only audited.

## D-J3: Identity, trust & permissions (recorded at J3 acceptance, 2026-10-05)

The J3 gate was accepted **locally**. Not deployed. Production untouched; branch deployments, production baselining and the deploy step stay disabled. Read-only production verification remains a parallel, BLOCKED workstream.

| # | Decision | How it applies |
|---|---|---|
| D11 | Do **not** assign production operator roles yet. First inventory existing production operators read-only. `--break-glass` is emergency/bootstrap only, never ordinary administration. Preserve separation of duties: avoid routinely giving one human support + risk/compliance + finance + approver/sysadmin authority. | `scripts/admin-roles.mjs` is not run against production; SoD conflicts stay enforced. |
| D12 | Pre-J3 sessions are **not** trusted for outbound financial authority. Re-authentication / PIN confirmation under the J3 trust model; no grandfathering. | Session-less tokens are untrusted in production (`requestTrust`). |
| D13 | Keep the **24 h new-device cash-out hold** and the **60-day** maximum session lifetime, with rotation, device trust, revocation and risk-triggered step-up. A 60-day session alone is never sufficient evidence for a high-risk financial operation. | Cash-out always needs step-up in the session, plus the risk guard. |
| D14 | **Tier 0 is receive-only for money.** Email-only users may use non-financial features and receive value, but cannot send or withdraw until the required verification is done. | `TIER_LIMITS[0]`. |
| D15 | Initial maker-checker thresholds: **5 000 ₭** platform adjustment, **10 000 ₭** refund, **500 000 XOF** agent float. They are conservative, configurable defaults, not permanent policy, and their usage is instrumented for later calibration. | `LIMITS` in `lib/authz/catalog.js`; usage reported by `GET admin/money/limits-usage` (J4). |
| D16 | Diaspora/local status may affect product routing, country context, rails, currency, UX or services, but must **not** inherently change authentication trust, fraud score, identity confidence or security permissions. Never use ethnicity, nationality, language, name, neighbourhood or diaspora identity as a proxy for trustworthiness. | J4: the pre-J3 device-login flag ("foreign IP unless diaspora") is replaced by an account-relative "new login country for this account" signal. Regression tests cover it (`tests/unit/fraud-rules.test.js`). |
| D17 | Passkeys and KYC re-verification stay recorded as **future security work**. They are not faked to make a gate green. | Listed as open in the gate reports. |
