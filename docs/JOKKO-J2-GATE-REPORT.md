# Jokko J2 gate report: Money Kernel (local)

Branch `claude/jokko-forensic-audit-rprqia`, from `ce18b31`.

**Scope and limits.** Everything here was built and proven locally. No deployment was made to Production or Preview, and no production database, user, credential or message row was read or changed. `scripts/db-migrate-deploy.mjs` is inert unless `MIGRATION_DEPLOY_ACTIVATED=true` and has **not** been activated anywhere except local rehearsal databases. Production exposure and topology remain BLOCKED pending legitimate read-only access.

Companion documents:
- [`JOKKO-J2-DESIGN.md`](JOKKO-J2-DESIGN.md): full technical design (sections referenced as §n below).
- [`JOKKO-LEGACY-SCHEMA.md`](JOKKO-LEGACY-SCHEMA.md): preserved legacy tables and columns.

**Verdict: the J2 gate is met locally.** §15 lists the conditions that stay open before any production use, and none of them is a P0. Fresh-DB gate results are in §12–§13.

---

## 1. Architecture

```
HTTP (api/index.js → lib/api-router.js)
  │  J1 Idempotency-Key, auth, TOTP for admin money routes
  ▼
Domain services (lib/*-service.js)          ← business rules, no balance writes
  │  call ONLY:
  ▼
Money Kernel (lib/money-kernel/)
  ├─ flows.js          posting recipes per flow (move, cashIn*, cashOut*, agent*, reward, …)
  ├─ ledger.js         post() / reverse(): advisory lock on reference, sorted FOR UPDATE,
  │                    funds check, customer-debit authorization, replay/conflict
  ├─ accounts.js       account taxonomy, lazy opening balances from legacy projections
  ├─ external-ops.js   ExternalOperation state machine (+ ledger effect per transition)
  ├─ providers.js      adapter boundary (julaya, stripe); production ⇒ live or refuse
  ├─ reconciliation.js owed / backing / named differences; statement import
  ├─ invariants.js     continuous checker (I1–I19, W1)
  ├─ backfill.js       opening-balance migration with legacy comparison
  └─ admin.js          dual-authorized adjustments, money position
  ▼
Postgres (prisma/sql/money-kernel.sql: triggers are the backstop)
  LedgerAccount ─< Posting >─ JournalEntry ── ExternalOperation ─< ExternalOperationEvent
  projections (Wallet.koriBalance, BusinessWallet.balance, PaymentFund.balanceKori,
  MerchantVoucher.balanceKori, AgentProfile.floatBalance, TontineGroup.potBalance)
  are written ONLY by the posting trigger.
```

**Authority.**
- The ledger (`Posting` → `LedgerAccount.balance`) is the single source of truth.
- Legacy `LedgerEntry` and `KoriTransaction` rows are still written in the same transaction, as the user-facing statement read model. They have no authority.
- `KoriReserve` is a derived snapshot.

---

## 2. Account taxonomy

Full table: §2 of the design. In summary:
- **Liabilities (credit-normal):**
  - `customer:{u}:available`, `customer:{u}:held`
  - `business:{b}:wallet`
  - `voucher:{id}`, `fund:{id}`
  - `tontine:{g}:pot`, `escrow:delivery:{t}`
  - `agent:{a}:float` (XOF)
  - `incentives:funded`, `platform:refunds`
  - `revenue:*`
- **Assets and bridges (debit-normal):**
  - `provider:{p}:{CUR}:clearing_in`, `provider:{p}:{CUR}:settlement`
  - `cash:{office}:{CUR}`
  - `conversion:KRI:{CUR}`
  - `suspense:reconciliation`
  - `migration:opening:{CUR}`
  - `test:faucet:KRI` (refused in production)
- **Credit-normal transit and bridge:** `provider:{p}:{CUR}:clearing_out` and `conversion:{CUR}`.

The B-rules of the brief, as built:
- **Rewards come only from the funded account.** `reward()` debits `incentives:funded`. When that account is empty, the reward is 0 (tested).
- **A tontine uses its pot.** Contributions go member → `tontine:{g}:pot`, and payouts and refunds go pot → member.
- **Escrow is real accounting state.** `escrow:delivery:{task}` holds the courier fee, and invariant I13 reconciles it against `DeliveryEscrow`.

---

## 3. State machines

**ExternalOperation** (§4): a DB trigger enforces the transition table and makes the financial identity immutable. Transitions:
- `created → authorized | failed | cancelled`
- `authorized → submitted | confirmed | failed | cancelled | expired`
- `submitted → confirmed | failed | expired`
- `expired → confirmed | failed | cancelled` (review queue: a late provider outcome can still be applied)
- `confirmed → settled | reversed | refunded`

Terminal states are final.

| Transition | Ledger effect (same transaction) |
|---|---|
| → authorized (cash-out) | `cash_out_hold`: available → held |
| → submitted | **none** (acceptance is not settlement) |
| → confirmed (in) | `cash_in_confirmed`: clearing_in → conversion → customer |
| → confirmed (out) | `cash_out_confirmed`: held → conversion → clearing_out |
| → settled | `*_settled`: clearing ↔ settlement |
| → failed / cancelled (out, if held) | `cash_out_release` (once, by unique reference) |
| → expired | **none**; goes to review (a timeout is not confirmation) |
| → reversed / refunded | inverse entry; a spent shortfall goes to `suspense` plus a `ReconciliationException` |

The deferred trigger `j2_external_op_ledger` refuses to COMMIT any state whose required entry is missing, for example `confirmed` without a confirmation entry, or `authorized` without a hold.

The entity lifecycles that sit on top of this (rail, payout, partner payment, Stripe deposit, escrow, tontine cycle) keep their own status columns for display. Their money effects all go through kernel recipes.

---

## 4. Provider adapter design

`lib/money-kernel/providers.js` (§5):
- **`julaya`:** mode comes from `julayaConfig()` (live / sandbox / mock / unavailable). In production, anything but `live` is refused.
- **`stripe`:** `sk_live_` means live, anything else is test.
- **Fail-closed rules:**
  - In production, `getProvider()` and `createOperation()` require `providerMode: 'live'`.
  - Nothing is silently mocked.
  - Beta deposits are booked under provider `beta`. They are reported as **non-real backing** (`differences.nonRealProvider`), together with `partner_sandbox` and `mock`.
- **Webhooks and status polling:**
  - A confirmation needs either a signature-verified webhook or a server-side status lookup.
  - The amount and currency must match.
  - The provider reference is unique per provider: a second operation claiming the same reference raises a `ReconciliationException` and is not credited.
- **Statements:** `parseStatement()` → `importStatement()` matches lines on `(provider, providerReference, amount)`.
  - A matched line settles its operation. Re-importing is a no-op.
  - An unmatched line, a mismatch, or a statement arriving before confirmation becomes an exception.

---

## 5. Old → new flow map

Every flow that is meant to operate today, with the kernel recipe it now uses.

**How bypass is prevented (proof):**
- `j2_projection_guard` rejects any INSERT with a non-zero balance and any UPDATE of a projected balance column that does not come from the posting trigger.
- `j2_ledger_account_guard` does the same for `LedgerAccount.balance`.
- Proof in the tests:
  - the torture test "journal is append-only";
  - `kernel-guards.test.js`;
  - the security test;
  - the rehearsal step "direct balance write refused".

**Code search:** `grep` over `lib/` and `api/` for writes to `koriBalance`, `balance`, `balanceKori`, `floatBalance` and `potBalance` outside `lib/money-kernel/`. The only write found is the rehearsal's own probe, which is meant to be refused.

| Flow | Before (legacy) | Now | Code |
|---|---|---|---|
| P2P send (₭) | `wallet.update increment/decrement` | `move` customer → customer | `kori-service.sendKoriTransfer` |
| P2P undo (60 s) | reverse update | `transferNational(…, reversesReference, authorization 'p2p_undo_window')` | `transfer-undo-service` |
| Money request accept | wallet updates | `sendKoriTransfer` / `transferNational` | `money-request-service` |
| Merchant pay | wallet updates | `spendKoriAtMerchant` → `move` | `kori-service`, `marketplace-service` |
| Voucher fund / spend | `balanceKori` increment with no debit | `move` customer → voucher → merchant | `merchant-voucher-service` |
| Marketplace purchase + affiliate | separate updates; the affiliate share could vanish | single balanced `post`; the affiliate share falls back to the merchant | `affiliate-service` |
| Business wallet transfers, B2B trade | `BusinessWallet.balance` updates | `bizMove` / `move` | `business-wallet-service`, `trade-service` |
| Payroll, school fees, Jekkal | wallet updates | `transferNational` (kernel adapter) | `cron/payroll-processor`, `school-service`, `jekkal-service` |
| Scheduled payments / savings funds | `balanceKori` updates | `debitNational` / `creditNational` with an explicit counter-account `fund:{id}` | `scheduled-payment-service` |
| Delivery escrow hold / release / refund | `wallet` updates + escrow row | `escrow:delivery:{t}` account moves | `delivery-service` |
| Tontine contribute / payout / cancel | `potBalance` updates | `tontine:{g}:pot` moves | `tontine-service` |
| Cash-in (Julaya) | `mintKori` on webhook; a timeout was marked **failed** | ExternalOperation → `cashInConfirmed` on verified confirmation; a timeout is **expired / review** | `rail-service`, `kori-service.mintKoriFromNationalDeposit` |
| Cash-out (Julaya) | burn plus refund on failure | `authorized` hold → `confirmed` burn → `failed` release (once) | `rail-service.executeRailOperation` / `settleRailFromWebhook` |
| Legacy in-flight cash-outs (pre-J2 rails) | refund by wallet update | `legacyCashOutRefund` (explicit lines from `migration:opening`) | `rail-service` |
| Stripe deposit | booked to the Julaya clearing account | ExternalOperation provider `stripe` → `cashInConfirmed` | `stripe-service` |
| Partner collections / payouts | `PartnerPayment` / `PartnerPayout` + wallet updates | ExternalOperation (`createOperation` / `transition`) | `partner-payments-service`, `partner-payouts-service` |
| Agent cash-in / cash-out | `floatBalance` updates (a withdrawal could gain up to 9 XOF) | `agentCashIn` / `agentCashOut` (peg bridge, multiples of 10); `AgentFloatEntry` written inside the flow | `agent-service` |
| Agent float top-up | `floatBalance` update | `agentFloatTopUp` from `cash:office:XOF` | `agent-service` |
| Agent commission payout | not funded (J1) | **still not paid**; a record only, until a funded revenue source exists | `agent-payout-service` |
| Rewards / earn | minted from nothing | `reward` from `incentives:funded` (0 when unfunded) | `kori-service.creditKoriEarn` |
| Signup / complete-profile bonus | minted from nothing | **removed** | `handlers.js` |
| Admin refund | wallet credit | `move` from `platform:refunds` (409 `refund_budget_insufficient`) | `admin-actions-service.issueAdminRefund` |
| Admin "set balance" / adjustment | n/a | **no set-balance**; dual-authorized `adjustment` | `money-kernel/admin.js` |
| Kori convert | disabled (410) | stays disabled | — |
| `scripts/migrate-kori-primary.mjs` | direct writes | **retired** (exits 2) | — |
| `/server` Express (legacy) | direct writes | superseded; any direct write is refused by the DB guards | — |
| Kebu investments, redemptions, Ñu Lekk, merchant promos | legacy tables | **no postings**; preserved and reported by the backfill (decision pending) | `JOKKO-LEGACY-SCHEMA.md` |
| `Wallet.balance` (legacy XOF) | legacy column | not migrated; invariant W1 reports it | — |

---

## 6. Schema and migrations

- **`prisma/schema.prisma`:**
  - J2 models: `LedgerAccount`, `JournalEntry`, `Posting`, `ExternalOperation`, `ExternalOperationEvent`, `ProviderStatementLine`, `ReconciliationException`, `MoneyAdjustmentRequest`. The existing `TontinePotEntry` and `AgentFloatEntry` histories are now written inside kernel flows.
  - Legacy models and columns preserved.
- **`prisma/migrations/20261003000000_j2_money_kernel/migration.sql`:**
  - Reviewed and additive only: CREATE TABLE, ADD COLUMN, CREATE INDEX, ADD FK.
  - No DROP, no type change, no SET NOT NULL on existing columns.
  - `prisma migrate diff --from-migrations --to-schema-datamodel --exit-code` gives exit 0, so migrations equal the schema.
- **`prisma/sql/money-kernel.sql`:** idempotent triggers (§1 of the design). It is applied by `test:db:setup`, `db-sync-deploy.mjs` and `db-migrate-deploy.mjs`.
- **`scripts/db-migrate-deploy.mjs`:** replaces `db push` in `vercel-build` (L). It is inert (exit 3) unless activated. When activated, these steps run in order, and each one fails closed:
  1. Require `0_baseline` to be applied.
  2. Destructive guard on the DB → schema diff and on pending migration files.
  3. Run `migrate deploy`.
  4. Post-check: zero drift.
  5. Apply the guards.

  With deploy inert, a Vercel build of this branch would stop at schema delivery. That is intended: deployments for this branch stay disabled.

---

## 7. Invariant definitions

Defined in §9 of the design and implemented in `lib/money-kernel/invariants.js`; the database enforces them where marked.

| ID | Check | DB-enforced |
|---|---|---|
| I1 / I1b / I1c | every entry balances per currency, has ≥ 2 postings, and posting currency = account currency | ✔ deferred trigger |
| I2 | no negative balance on non-negative accounts | ✔ CHECK |
| I4 / I4b | one confirmation / release per operation; state ↔ entries consistent | ✔ unique reference + deferred trigger |
| I6 | rewards only from `incentives:funded` | ✔ non-negative |
| I7 / I19 | no mock or test-faucet money in production | ✔ kernel |
| I10 | no customer debit without owner actor or authorization | kernel |
| I11 / I11b | projections = ledger; no unmigrated non-zero row | ✔ guard trigger |
| I12 | materialized balance = Σ postings | ✔ guard trigger |
| I13 | escrow account = held `DeliveryEscrow` | — |
| I14 | pot = opening + `TontinePotEntry` history | — |
| I15 | agent float = opening + `AgentFloatEntry` history | — |
| I17 | `conversion:{CUR}` = peg × `conversion:KRI:{CUR}` | — |
| I18 | no reversal of a reversal; at most one reversal per entry | ✔ unique |
| W1 | legacy `Wallet.balance` XOF reported (warning) | — |

Also enforced in the database:
- append-only journal: no UPDATE, DELETE or TRUNCATE;
- ExternalOperation immutability.

`npm run money:check` runs the checker inside `BEGIN READ ONLY` and exits non-zero on any violation.

---

## 8. Checker results

- **Every torture scenario:** `assertInvariants` runs in `afterEach`, and all 27 scenarios end with zero violations.
- **Fresh-DB full suite:** `money:check` after the full suite and again after load + sweep. Results in §12.
- **Rehearsal:** the checker runs after the backfill and again after live kernel flows on migrated data, with **0 violations** both times (§14).

---

## 9. Reconciliation model

`ledgerPosition()` (`GET /admin/money/position`, TOTP admin) answers the three questions in the brief.

- **What is owed:** Σ customer available + held, business, voucher, fund, pot, escrow and agent-commission accounts (₭), plus agent float (XOF).
- **What backs it:** for each currency, settlement + clearing_in − clearing_out + cash, converted at the peg to `realBackingKori`.
- **What explains the difference** (each part is named):
  - `migrationOpening`: legacy value of unproven provenance;
  - `suspense`;
  - `testFaucet`;
  - `nonRealProvider`: beta, sandbox, mock;
  - `platformOwned`: revenue and budgets.

  This yields `uncoveredKori` and `coverageRatio`.

**Other components:**
- `reconcileFromLedger()` writes the `KoriReserve` snapshot and freezes on any integrity failure.
- **Statement import** (`POST /admin/money/statements`) settles matched operations and records every other line as a `ReconciliationException` (`GET /admin/money/exceptions`).
- **Policy currently:** only an integrity failure freezes. Coverage below 100 % is reported, not frozen. See §15.

---

## 10. Backfill evidence

`scripts/money-backfill.mjs` (`npm run money:backfill`) does a dry run by default; `--execute` performs the backfill. For every non-zero legacy projection row it:
- opens an account and posts `opening_balance` from `migration:opening:{CUR}`, with `metadata.legacy = {table, id, value}`;
- compares the legacy value with the ledger balance and stops on any mismatch;
- reports, without migrating, the legacy XOF `Wallet.balance` and the legacy value tables.

Accounts the batch has not reached are opened lazily by the account resolver, in the same transaction and with the same opening rule.

**Rehearsal output** (production-shaped DB, §14):

| | Legacy total | Ledger after backfill |
|---|---|---|
| Wallets (₭) | 21 000 | 21 000 |
| Business wallets | 7 000 | 7 000 |
| Savings funds | 1 500 | 1 500 |
| Vouchers | 400 | 400 |
| Tontine pots | 1 000 | 1 000 |
| Delivery escrow | 1 500 | 1 500 |
| Agent float (XOF) | 120 000 | 120 000 |
| `migration:opening:KRI` | — | 32 400 (= Σ ₭ above) |

- 12 rows were opened, with 0 mismatches.
- Re-running is a no-op.
- Reported but not migrated:
  - legacy XOF wallet, 25 000;
  - `KebuInvestment` (1 row, 2 500), preserved.

---

## 11. Concurrency and destruction results

`tests/money/torture.test.js` has 27 scenarios, each followed by the invariant checker:

1. **Concurrent spends against one balance:** 100 simultaneous spends; exactly the affordable ones succeed.
2. **Uneven-amount race:** total debited ≤ balance.
3. **Duplicate P2P with the same reference:** one entry (replay).
4. **Same reference with a different payload:** `LedgerConflictError`.
5. **Duplicate cash-in webhook ×10 concurrent:** credited once.
6. **Duplicate cash-out callback, concurrent:** ₭ retired once.
7. **Out-of-order callbacks:** a late "pending" after "completed" is a no-op.
8. **Provider timeout:** expired / review, never confirmed or failed; a late confirmation is still applied once.
9. **Provider accepted (`submitted`):** credits nothing.
10. **Failure after authorization:** hold released once, even with concurrent failure signals.
11. **Different keys for the same provider transaction:** the second is refused, with an exception.
12. **DB failure between postings:** nothing persists; a one-sided posting is refused at COMMIT.
13. **Resolver + expiry worker run concurrently:** one outcome.
14. **Restart during a pending payout:** state survives, and resolution happens once.
15. **Provider reversal after confirmation:** inverse entry; a spent shortfall goes to suspense with an exception.
16. **Escrow refund raced by two rulings:** refunded once.
17. **Escrow release raced:** rider paid once.
18. **Refund concurrent with cash-out:** no double spend.
19. **Undo concurrent with the recipient spending:** exactly one wins.
20. **Tontine collection concurrent with the member spending:** one wins.
21. **Agent cash-out concurrent with an ordinary cash-out:** only one is funded.
22. **Rewards:** unfunded gives 0; funded rewards come from the budget only.
23. **Stripe webhook replayed 5× concurrently:** one operation, one credit.
24. **Statement import:** settled once; re-import is a no-op; mismatches become exceptions.
25. **Admin adjustment:** one admin alone cannot post; dual approval posts once; the legacy key is refused.
26. **Cross-user debit without authorization:** refused.
27. **Journal tampering:** UPDATE, DELETE and TRUNCATE are refused.

`tests/money/kernel-guards.test.js` adds 7 DB-level guard tests:
- invalid transitions and immutability;
- a confirmed state without an entry is refused at COMMIT;
- an authorized state without a hold is refused;
- accounts and projections open at 0;
- the test faucet is refused in production;
- posting currency must match the account currency;
- the invariants hold afterwards.

---

## 12. Full test results (fresh DB `joko_j2_gate`, commit `f8106eb`)

Run with `bash gate.sh` on a fresh database: a full reset, then `npm run test:db:setup`, then every step below.

| Step | Result |
|---|---|
| `npm run test:db:setup` (db push + `financial-invariants.sql` + `money-kernel.sql`) | exit 0 |
| `npm test` (unit, integration, security, http, **money**) | **364 / 364 pass**, 0 fail |
| └ `tests/money/torture.test.js` | 27 / 27 (invariants checked after each) |
| └ `tests/money/kernel-guards.test.js` | 7 / 7 |
| `npm run money:check` after the suite | **OK**: 437 entries, 923 postings, 306 accounts, 0 violations |
| `npm run test:load` | 2 / 3 in the gate run; **3 / 3 in 9 further runs** (see below) |
| `npm run test:sweep` | 2 / 2 |
| `npm run money:check` after load + sweep | **OK**: 2 452 entries, 4 955 postings, 1 313 accounts, 0 violations |
| `prisma migrate diff --from-migrations --to-schema-datamodel --exit-code` | exit 0: "No difference detected" |
| messaging migration dry run (local) | exit 0 |
| `npm run money:rehearse` | **14 / 14 steps OK** (§14) |
| `db-migrate-deploy.mjs` without activation | refused, exit 3 (as intended) |
| `expo export --platform web` | exit 0 |
| `tsc --noEmit` | exit 2: the same 5 pre-existing errors, all in the Deno-only `supabase/functions/cron-proxy/index.ts` (unchanged since J0) |
| `npm audit --omit=dev` | 42 advisories (29 high, 13 moderate, 0 critical): **identical to the J1 baseline**. J2 adds no dependencies. |

**Load-test observation, not dismissed as a flake.**
- **What happened:** in the gate run, 1 of the 1 000 concurrent sends failed with an error whose message was empty.
- **Effect on money:** it rolled back atomically. The sender kept 1 000 ₭, there is no journal entry or legacy row for it, all other 999 senders hold exactly 750 ₭, and `money:check` passed afterwards. No money was lost or duplicated.
- **Reproduction:** the failure did not occur in 9 further runs (3 isolated, 6 full-suite) on the same database.
- **Follow-up:** the test now reports the error's name and code, so the next occurrence identifies it.

  The most likely cause is a connection or transaction error that the load test's narrow transient-retry classifier does not recognize. That is a test-harness classification issue, not a kernel defect. It stays open until it is identified (§15).

---

## 13. Fresh-database result

The database `joko_j2_gate` is dropped and recreated, then built only from `schema.prisma` plus the SQL guards. On that database:
- the full suite passes, 364 / 364;
- the invariant checker reports 0 violations, both after the suite and after load + sweep;
- the reviewed migrations reproduce the schema exactly (`migrate diff` reports no difference).

The earlier run on `6114df6` exposed two pre-J2 fixtures, both fixed in `f8106eb` without weakening any assertion:
- the load test created wallets with a non-zero balance, which the DB guard now refuses; they are now funded through the kernel;
- a security assertion assumed rewards are never paid, but they are, legitimately, when the incentive budget is funded; it now accepts only rewards drawn from `incentives:funded`.

---

## 14. Production-shaped migration rehearsal

`npm run money:rehearse` (`scripts/rehearse-migration.mjs`) runs locally only and refuses any non-local host.

**Setup:**
- The database is built from `prisma/migrations/0_baseline`, the production shape as of 2026-08-17, including the legacy tables.
- Legacy-shaped value is seeded in every balance column, plus legacy XOF, a pre-J1 escrow, legacy tontine contributions and a Kebu investment.

| Step | Result |
|---|---|
| DB → schema diff on production shape | 0 destructive statements |
| migrate-deploy without activation | refused, exit 3 |
| migrate-deploy before baselining | refused, exit 1 |
| baseline resolved → migrate deploy (J1 + J2) → guards | ✔ no drift afterwards |
| backfill dry run → execute | 12 rows, 0 mismatches (table in §10) |
| invariant checker after backfill | 0 violations |
| legacy totals == ledger balances (per balance type) | ✔ |
| real kernel flows on migrated data (P2P + refund of a pre-J1 escrow) | ✔ |
| invariant checker after flows | 0 violations |
| direct `UPDATE "Wallet" SET "koriBalance" …` | **refused** by the guard |
| read-only exposure pack | ran |

Rehearsal result: **14 / 14 steps OK** (re-run in the fresh-DB gate at `f8106eb`). Totals are in §10.

---

## 15. Remaining risks and blockers

None of these is a new P0.

1. **Production is BLOCKED.** There is no legitimate read-only access yet, so exposure, topology and the real legacy row counts are unknown. Before anything runs against production, the backfill dry run has to be executed there under read-only review.
2. **Baselining production (decision).** Production was built by `db push`. Running `db:resolve-baseline` (marking `0_baseline` applied) is a one-time write to `_prisma_migrations`. It needs approval and a backup.
3. **Activating `migrate deploy` (decision).** It is inert now, and `vercel-build` fails closed until it is activated. Deployments for this branch stay disabled.
4. **Coverage-freeze policy (financial decision).** Should cash-outs freeze when real coverage is below 100 %? Today only an integrity failure freezes. After migration, the legacy opening balances (`migration:opening`) are by definition not backed by reconciled provider statements, so freezing on coverage at launch would freeze everything. A decision is needed on:
   - a threshold;
   - a grace period;
   - or treasury funding of the migration difference.
5. **Legacy value tables are uninspected:** Kebu investments and payouts, Kori redemptions, Ñu Lekk shares and merchant promo uses. They are preserved and reported, not migrated. Their value is not in the ledger until a product and finance decision is made.
6. **Legacy XOF `Wallet.balance`:** it is not part of ₭ balances and is reported by W1. Production may hold value there, and that needs a decision: convert at the peg via the migration account, or leave it frozen.
7. **Partner payout `submitted` without completion:** when the partner API does not return `completed` synchronously, the operation stays `submitted` and later goes to expired / review. No dedicated partner-payout status resolver exists yet; resolution is by admin review.
8. **Agent commissions:** still unpaid, because no funded revenue account exists yet. The recipe exists (`revenue → agent commission`).
9. **Adjustment policy:** dual authorization applies to every amount. That is stricter than the original sketch; loosening it is a product decision.
10. **Intermittent load-test send failure** (§12): money-safe atomic rollback, 1 in 10 runs, cause not yet identified. Diagnostics are now in the test. Close it in J3.
11. **`npm audit`:** see §12. Nothing new comes from J2, which adds no dependencies.
12. **Carried from J0/J1:**
    - KYC stays fail-closed, with no production users reverified.
    - Credential remediation is ready but not executed.
    - The messaging migration has not run on production.
    - Jekkal consent is a known gap from J1.
13. **Product gaps (N), unchanged:**
    - Commerce: PARTIAL
    - Rides: NOT IMPLEMENTED
    - Gigs: PARTIAL
    - Mobile: PARTIAL
    - Locale: PARTIAL

    Details: `JOKKO-PRODUCT-GAPS.md`.

---

## 16. Exact commits (on `ce18b31`)

| Commit | Summary |
|---|---|
| `a5e5dd9` | Preserve legacy production schema: 9 tables, 17 columns, one FK (no drops) |
| `279e5f7` | J2 technical design: Money Kernel ledger, accounts, state machines, adapters, invariants |
| `ff26cf0` | J2 Money Kernel: double-entry ledger, DB-enforced balances, all flows migrated |
| `3490dd8` | Retire migrate-kori-primary (direct balance writes are refused under J2) |
| `d24897b` | J2: external operation state machine, provider adapters, ledger-derived reserve |
| `8c9ea9f` | J2: Stripe + partner flows as external operations, timeout→review, admin money controls |
| `85d31d4` | J2: reviewed migrate-deploy pipeline, opening-balance backfill, production-shaped rehearsal |
| `6114df6` | J2: torture suite (27 scenarios) and DB kernel-guard tests; provider-reference and I4b fixes |
| `f8106eb` | J2 gate fixes: load-test senders funded through the kernel; security assertion allows only funded rewards |
| (this commit) | J2 gate report; load-test error diagnostics |

All commits are pushed to `origin/claude/jokko-forensic-audit-rprqia`. No PR has been opened. Vercel deployments for this branch remain disabled.

---

## 17. J3 recommendation

**J3 can start, locally, on the kernel. Its order is set by risks 1–4 above.**

1. **Production read-only access first.** Run `money:backfill` as a dry run plus `money:check` read-only against a production snapshot (or a restored backup), so that the opening balances and legacy value are measured on real data. This was not possible in J2.
2. **Take the four decisions:**
   - baseline production;
   - activate `migrate deploy`;
   - set the coverage-freeze policy;
   - decide what to do with legacy XOF and the legacy value tables.
3. **Rehearse on a restored production backup:** full migrate → backfill → check → flow smoke. Only then consider a Preview deployment, with deployment re-enabled by an explicit decision.
4. **Build on the kernel:**
   - Provider status resolver for partner payouts.
   - Provider statement ingestion (scheduled).
   - A funded incentives / refunds budget process (treasury funding with dual authorization).
   - Agent commission accrual from real revenue.
5. **Product gaps**, each on kernel recipes:
   - commerce cancel / refund through `escrow_order` and merchant settlement;
   - gig escrow;
   - mobile and locale.
6. **Retire legacy statement rows as authority:** move `LedgerEntry` and `KoriTransaction` reads to `Posting`-based statements.
