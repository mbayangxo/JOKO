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
