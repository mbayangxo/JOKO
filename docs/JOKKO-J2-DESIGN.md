# Jokko J2: Money Kernel technical design

| | |
|---|---|
| Status | Design (2026-10-03), implemented incrementally on `claude/jokko-forensic-audit-rprqia` |
| Deploy | **Not deployed.** Production and Preview stay blocked. |
| Inputs | `JOKKO-J2-ENTRY-REPORT.md`, `JOKKO-FORENSIC-EVIDENCE-REPORT.md` (money-mutation map), `JOKKO-LEGACY-SCHEMA.md`, current `schema.prisma` and code |

## 0. Principles

1. **One source of truth.** Value exists only as postings in one append-only, double-entry journal. Every other balance column is a *projection* written by the database from postings.
2. **The database enforces it.** Application code can't mutate a balance column at all: a trigger rejects any change that doesn't come from the posting trigger chain. "No bypass" is a database property, not a code convention.
3. **Integers only.** `BIGINT` minor units. Every account and posting carries an explicit `currency` (`KRI` = Kori/₭ internal unit; `XOF`, `GHS`, … external). An entry balances **per currency**.
4. **Nothing from nothing.** Every credit has a debit on a named account. Value enters only through:
   - external settlement accounts (provider-confirmed);
   - an attested cash office (admin + TOTP);
   - an explicit, visible migration/suspense account.
5. **Append-only.** No UPDATE or DELETE on journal tables. Corrections are reversal or adjustment entries linked to the original.
6. **Exactly-once outcomes over at-least-once transport.** Unique business references, idempotency hashes, row locks, conditional state transitions and DB constraints, each layered so one failing doesn't double-move money.
7. **Fail closed.** No provider key in production means *unavailable*, never mock.
8. **Additive migrations only** (legacy schema decision). No drops, no narrowing.

## 1. Ledger schema

```
LedgerAccount
  id            text pk
  code          text unique      -- e.g. 'customer:<userId>:available'
  type          text             -- see taxonomy (§2)
  currency      text             -- 'KRI' | 'XOF' | …
  normalSide    text             -- 'credit' (liabilities, revenue, equity-like) | 'debit' (assets)
  allowNegative bool             -- only a few system accounts
  balance       bigint           -- materialized, normal-side; written ONLY by the posting trigger
  ownerType     text?            -- 'user' | 'business' | 'agent' | 'tontine' | 'delivery' | 'voucher' | 'fund' | 'provider' | 'platform'
  ownerId       text?
  projTable     text?            -- legacy projection: 'Wallet' | 'BusinessWallet' | 'PaymentFund' | 'MerchantVoucher' | 'AgentProfile' | 'TontineGroup'
  projId        text?
  status        text             -- 'active' | 'frozen' | 'closed'
  createdAt, updatedAt
  CHECK (allowNegative OR balance >= 0)
  CHECK (normalSide IN ('debit','credit'))

JournalEntry                     -- one financial event
  id            text pk
  reference     text unique      -- business reference: exactly-once anchor
  kind          text             -- 'p2p_transfer', 'cash_in_confirmed', 'escrow_hold', 'reversal', 'opening_balance', …
  payloadHash   text             -- sha256 of canonical postings; same reference + different hash = conflict
  reversesId    text? unique fk  -- at most one reversal per entry
  externalOperationId text? fk
  actorType     text             -- 'user' | 'system' | 'admin' | 'provider' | 'migration' | 'job'
  actorId       text?
  reason        text?
  metadata      jsonb?           -- non-PII context (ids, references)
  createdAt
  (immutable: UPDATE/DELETE rejected by trigger)

Posting
  id            bigserial pk
  entryId       text fk → JournalEntry (RESTRICT)
  accountId     text fk → LedgerAccount (RESTRICT)
  side          text             -- 'debit' | 'credit'
  amount        bigint CHECK (amount > 0)
  currency      text             -- must equal account.currency (trigger)
  (immutable)
```

### Database triggers (`prisma/sql/money-kernel.sql`, idempotent)

| Trigger | Rule |
|---|---|
| `posting_apply` (AFTER INSERT on Posting) | Checks `currency` = account currency and account is `active`. Updates `LedgerAccount.balance` (+amount on the normal side, −amount on the other), then writes the legacy projection column (`Wallet.koriBalance`, …) to the new balance. `CHECK (balance ≥ 0)` fires here: an overdraft is impossible even if app checks are wrong. |
| `journal_balanced` (CONSTRAINT TRIGGER, DEFERRABLE INITIALLY DEFERRED, on Posting) | At commit, Σdebits = Σcredits per currency for the entry, and the entry has ≥ 2 postings. Unbalanced → the whole transaction aborts. |
| Immutability (`JournalEntry`, `Posting`) | BEFORE UPDATE/DELETE → exception |
| `ledger_account_guard` | BEFORE UPDATE on LedgerAccount: a `balance` change is allowed only at `pg_trigger_depth() > 1` (i.e. from `posting_apply`). Currency/normalSide immutable once postings exist. |
| `projection_guard` | On Wallet (`koriBalance`, `balance`), BusinessWallet.balance, PaymentFund.balanceKori, MerchantVoucher.balanceKori, AgentProfile.floatBalance, TontineGroup.potBalance: BEFORE UPDATE allows a change only from the posting chain; BEFORE INSERT allows only 0. **This proves no legacy handler can bypass the kernel.** |

Prisma models are added for LedgerAccount, JournalEntry, Posting (BigInt fields). The kernel converts BigInt to Number with a safe-integer check.

## 2. Account taxonomy

All `KRI` unless noted. Side: C = credit-normal (we owe / income), D = debit-normal (we own).

| Type | Code pattern | Side | Neg? | Projection | Meaning |
|---|---|---|---|---|---|
| `customer_available` | `customer:{userId}:available` | C | no | `Wallet.koriBalance` | Spendable customer funds |
| `customer_held` | `customer:{userId}:held` | C | no | — | Customer funds reserved (pending cash-out, held review). **Not spendable.** |
| `business_wallet` | `business:{businessId}:wallet` | C | no | `BusinessWallet.balance` | Business/merchant operating wallet (merchant wallet = business wallet) |
| `merchant_settlement` | `merchant:{businessId}:settlement` | C | no | — | Merchant proceeds awaiting release (marketplace escrow; future) |
| `agent_float` | `agent:{agentId}:float` | C | no | `AgentProfile.floatBalance` | **XOF.** What Jokko owes the agent for cash pre-paid |
| `agent_commission` | `agent:{agentId}:commission` | C | no | — | Accrued agent commission (liability, not minted) |
| `escrow_delivery` | `escrow:delivery:{taskId}` | C | no | — | Courier fee held for a delivery |
| `escrow_order` | `escrow:order:{orderId}` | C | no | — | (future) order amount held |
| `tontine_pot` | `tontine:{groupId}:pot` | C | no | `TontineGroup.potBalance` | Dedicated tontine pot |
| `voucher` | `voucher:{voucherId}` | C | no | `MerchantVoucher.balanceKori` | Merchant-restricted funds |
| `payment_fund` | `fund:{fundId}` | C | no | `PaymentFund.balanceKori` | Savings pot |
| `ext_clearing_in` | `provider:{p}:{CUR}:clearing_in` | D | no | — | **Cash-in transit**: provider confirmed collection, not yet settled to our account |
| `ext_clearing_out` | `provider:{p}:{CUR}:clearing_out` | C | no | — | **Cash-out transit**: provider paid out for us, not yet deducted from settlement |
| `ext_settlement` | `provider:{p}:{CUR}:settlement` | D | **yes**¹ | — | **External settlement/reserve**: funds at the provider per reconciled statements |
| `cash_office` | `cash:{office}:{CUR}` | D | no | — | Physical cash received (agent float purchases), attested |
| `conversion` | `conversion:{CUR}` (CUR side) and `conversion:KRI` | C / D | yes | — | Fixed-peg bridge between external currency and ₭. **Invariant:** `conversion:{CUR}` = peg × `conversion:KRI` |
| `fees` | `revenue:{product}:{CUR}` | C | no | — | Fees/revenue (incl. `revenue:rounding:{CUR}` for sub-unit residues) |
| `incentives_funded` | `incentives:funded` | C | **no** | — | Reward budget. Rewards debit it; it is credited only by real funding. **Rewards can't exceed it.** |
| `refunds` | `platform:refunds` | C | no | — | Budget for support refunds/goodwill (funded like incentives) |
| `treasury` | `platform:treasury:{CUR}` | D | yes | — | Owner funding (capital injection) counterpart |
| `suspense` | `suspense:reconciliation` | D | yes | — | Unexplained differences found by reconciliation, pending investigation |
| `migration` | `migration:opening:KRI` / `migration:opening:{CUR}` | D | yes | — | Counterpart of opening balances from the legacy system. **Its balance = legacy value of unproven provenance.** |
| `test_faucet` | `test:faucet:KRI` | D | yes | — | **Non-production only**; the kernel refuses it when `NODE_ENV=production` |

¹ Settlement can go negative only when a reconciled statement says so (an overdrawn provider account). That shows up as an exception in reconciliation.

## 3. Posting recipes (every current flow)

`A → B (n)` means debit A, credit B, n ₭. For credit-normal accounts a debit decreases.

| Flow | Entry kind | Postings |
|---|---|---|
| P2P send | `p2p_transfer` | `customer:S:available → customer:R:available` |
| P2P undo (≤60 s) | `reversal` (reversesId) | Inverse of the original. Requires the recipient's available ≥ amount. |
| Money request accept | `money_request_payment` | payer avail → requester avail |
| Merchant pay (wallet) | `merchant_payment` | payer avail → merchant owner avail (legacy behaviour; business wallet when J3 routes it) |
| Merchant pay (voucher) | `voucher_spend` | `voucher:{id} → merchant owner avail` |
| Voucher fund | `voucher_fund` | customer avail → `voucher:{id}` |
| Marketplace (b2c pay-now) | `marketplace_purchase` | buyer avail → merchant (+ affiliate split as extra credit lines) |
| Events ticket, jekkal, school fee, payroll, cooperative payout, trade invoice, business transfers | specific kinds | Between the corresponding `customer_available` / `business_wallet` accounts |
| Delivery escrow hold | `escrow_hold` | buyer avail → `escrow:delivery:{id}` |
| Delivery release | `escrow_release` | `escrow:delivery:{id}` → rider avail |
| Delivery refund | `escrow_refund` | `escrow:delivery:{id}` → buyer avail |
| Tontine contribution | `tontine_contribution` | member avail → `tontine:{g}:pot` |
| Tontine payout | `tontine_payout` | pot → recipient avail |
| Tontine cancel refund | `tontine_refund` | pot → each contributor |
| Savings fund deposit/withdraw | `fund_deposit` / `fund_withdraw` | avail ↔ `fund:{id}` |
| **Cash-in confirmed** | `cash_in_confirmed` | XOF: `provider:julaya:XOF:clearing_in → conversion:XOF (10k)`, residue `→ revenue:rounding:XOF`. KRI: `conversion:KRI → customer avail (k)` |
| Cash-in settled | `cash_in_settled` | XOF: `provider:…:settlement → provider:…:clearing_in` |
| **Cash-out authorized** | `cash_out_hold` | `customer avail → customer held (k)` |
| Cash-out confirmed | `cash_out_confirmed` | KRI: `customer held → conversion:KRI`. XOF: `conversion:XOF → provider:…:clearing_out (net)` (+ fee `→ revenue:cash_out:XOF`) |
| Cash-out failed (before confirmation) | `cash_out_release` | `customer held → customer avail` (once: unique reference) |
| Cash-out settled | `cash_out_settled` | XOF: `clearing_out → settlement` |
| Provider reversal after confirmation | `reversal` | Inverse entries linked to the confirmation |
| Stripe deposit | as cash-in, provider `stripe`, currency per session | |
| Partner collection | `partner_collection` | Cash-in to the partner's settlement customer wallet (provider `partner:{id}`) |
| Partner payout | as cash-out from the partner settlement wallet | |
| Agent cash-in (user gives agent cash) | `agent_cash_in` | XOF: `agent:{a}:float → conversion:XOF` (+residue). KRI: `conversion:KRI → customer avail` |
| Agent cash-out | `agent_cash_out` | KRI: `customer avail → conversion:KRI`. XOF: `conversion:XOF → agent float` |
| Agent float top-up (attested cash) | `agent_float_topup` | XOF: `cash:office:XOF → agent:{a}:float` (admin + TOTP; idempotent) |
| Agent commission accrual | `agent_commission_accrual` | `revenue:… → agent:{a}:commission` (only from real revenue; otherwise not accrued) |
| Rewards (earn) | `reward` | `incentives:funded → customer avail`. If the budget is insufficient, **no reward** (0). |
| Incentive funding | `incentive_funding` | `platform:treasury:{CUR}` / conversion legs → `incentives:funded` (admin, dual-auth) |
| Admin refund / support credit | `support_refund` | `platform:refunds → customer avail` (budget-limited, dual-auth above threshold) |
| Admin adjustment | `adjustment` | Any account pair, with reason + actor + `reversesId`/`metadata.originalReference`; dual authorization required |
| Opening balance (migration) | `opening_balance` | `migration:opening:KRI → projection account (legacy value)` |
| Kori convert | — | Stays **disabled** (410). Cash-out is the only exit. |
| Legacy Kebu investments / redemptions / Ñu Lekk | — | **No postings** until production rows are inspected (legacy decision) |
| Payroll / gig settlement (future) | business wallet → worker avail, gig escrow per `JOKKO-PRODUCT-GAPS.md` | |

## 4. External operation state machine

Table `ExternalOperation` is the single authoritative state for money crossing the boundary (Julaya cash-in/out, Stripe deposits, partner collections/payouts). Legacy rows (`RailTransaction`, `StripeDeposit`, `PartnerPayment`, `PartnerPayout`) keep display and business data and link to it.

```
created ──► authorized ──► submitted ──► confirmed ──► settled
   │            │              │             │
   │            │              │             └──► reversed   (provider reversal after confirmation)
   ├──► cancelled│             ├──► failed    (explicit provider failure)
   │            ├──► failed    └──► expired   (deadline passed with no provider outcome → review queue, NOT failed, NOT confirmed)
   │            └──► cancelled
   └──► failed
confirmed ──► refunded (cash-in returned to payer through the provider, future)
```

| State | Meaning | Ledger effect |
|---|---|---|
| `created` | Row exists; nothing promised | none |
| `authorized` | Jokko accepted the operation; **cash-out funds held** | cash-out: `cash_out_hold` |
| `submitted` | The provider accepted the request. **Not settlement.** | none |
| `confirmed` | Provider-confirmed outcome: signed webhook, or server-side status lookup with **amount + currency match** | cash-in credit / cash-out burn |
| `settled` | Reconciled against a provider settlement statement line | clearing → settlement |
| `failed` | Explicit provider failure | cash-out: release the hold (once) |
| `cancelled` | Abandoned before submission | release the hold if any |
| `expired` | Deadline passed without an outcome | **none**: goes to review; a timeout is not confirmation |
| `reversed` | Provider reversed a confirmed operation | Reversal entry |
| `refunded` | Confirmed cash-in returned to the payer | Reversal-style entry |

**Enforcement:**
- **Transition table in SQL:** a trigger on `ExternalOperation.state` rejects invalid transitions, and terminal states are final.
- **App call path:** every transition goes through `transitionExternalOperation(tx, id, to, { source, evidence })`, which:
  1. locks the row;
  2. checks the transition;
  3. writes an append-only `ExternalOperationEvent` (source: api / webhook / status_poll / admin / job / reconciliation; evidence hash; signature-verified flag);
  4. posts the ledger entry for that transition in the **same** transaction.
- **Uniqueness:**
  - `(provider, providerReference)` UNIQUE: two operations can't claim the same provider transaction;
  - `reference` UNIQUE;
  - `idempotencyKey` UNIQUE.
- **Duplicates and ordering:**
  - Duplicate or out-of-order signals are no-ops: a confirmed op ignores "pending"; a settled op ignores "confirmed".
  - Amount/currency mismatch → `expired`-style review flag (`reviewReason`), never credited.

## 5. Provider adapter boundary (`lib/money-kernel/providers/`)

```js
{
  name,                       // 'julaya' | 'stripe' | 'partner'
  currencies,                 // ['XOF']
  mode(),                     // 'live' | 'sandbox' | 'mock' | 'unavailable' — production never 'mock'/'sandbox'-without-key
  initiate(op)          → { accepted, providerReference?, status: 'submitted'|'failed'|'ambiguous', raw }
  lookupStatus(op)      → { status: 'pending'|'confirmed'|'failed'|'reversed', amountMinor, currency, providerReference }
  verifyWebhook(req)    → { ok, event: { providerReference, reference?, status, amountMinor, currency } }
  timeoutPolicy         → { submitTimeoutMs, outcomeDeadlineMs }   // deadline → 'expired' (review), never confirm
  parseStatement(input) → [{ providerReference, amountMinor, currency, direction, settledAt }]
}
```

- **Registry:** `getProvider(name)` throws `RailUnavailableError` in production when not configured. A mock adapter is only registered when `!isProduction()`.
- **Confirmation:** cash-in confirmation requires `lookupStatus` or a verified webhook with an exact amount and currency match.

## 6. Idempotency and concurrency (layers)

1. **HTTP:** the J1 `Idempotency-Key` on sensitive routes (replay / 409 in-flight / 422 different payload) stays as-is.
2. **Kernel:**
   - `JournalEntry.reference` UNIQUE + `payloadHash`. Same reference and same postings → return the existing entry (replay). Same reference with different postings → `LedgerConflictError`.
   - Every caller supplies a deterministic business reference (rail ref, `undo:{ref}`, `escrow_release:{taskId}`, `tontine_payout:{group}:{cycle}`, …).
3. **Locks:** the kernel `SELECT … FOR UPDATE`s every involved LedgerAccount in sorted id order (no deadlocks) before checking funds. The DB CHECK is the backstop.
4. **External ops:** `ExternalOperation` row lock and conditional transitions. Provider reference unique.
5. **Jobs/workers:** jobs transition ops with the same idempotent functions, so re-running a job is a no-op.
6. **Crash safety:** every entry plus its state transition is one DB transaction, so a crash means all or nothing. A pending op left mid-flight is resumed by the resolver from its persisted state.

## 7. Reversals and refunds

- `reverseEntry(tx, entryId, { reason, actor })` posts the exact inverse with `reversesId = entryId`. The unique `reversesId` allows at most one reversal; a reversal of a reversal is refused.
- Refunds are new entries (`kind: '*_refund'`) carrying `metadata.originalReference` and a unique reference `refund:{original}`, so refunding twice is impossible.

## 8. Reserve and reconciliation (replaces KoriReserve as authority)

**Read-only report (`lib/money-kernel/reconciliation.js`):**

- **A. Owed to users (KRI):** Σ balance of customer avail + held, business wallets, vouchers, funds, tontine pots, escrows, agent commission.
- **B. Owed to agents (XOF):** Σ agent float.
- **C. Externally confirmed backing (per currency):**
  - Σ `provider:*:settlement` (reconciled with statements);
  - Σ `clearing_in` (confirmed, unsettled);
  - minus Σ `clearing_out` (paid out, not yet deducted);
  - plus Σ `cash:*` (attested cash).
- **D. Peg check:** `conversion:{CUR}` = peg × `conversion:KRI` (exact).
- **E. Differences, each named:**
  - `migration:opening` (legacy value of unproven provenance);
  - `suspense:reconciliation`;
  - `revenue:*` (platform-owned);
  - `incentives:funded` / `platform:refunds` budgets;
  - unmatched statement lines;
  - expired/review ops.
- **Statement reconciliation:** `ProviderStatementLine` rows imported per provider are matched by `(provider, providerReference)` and amount.
  - Matched → op `settled`.
  - Line without op, or op without line past the window, or amount mismatch → an exception row (`ReconciliationException`), never silently absorbed.
- `KoriReserve` becomes a derived snapshot written by the job (kept for the dashboard), with **no authority**. Conversions freeze when the coverage check fails (A − platform-owned > C/peg + tolerance).

## 9. Invariants (DB + checker)

| # | Invariant | Enforced by |
|---|---|---|
| I1 | Every entry balances per currency | Deferred constraint trigger + checker |
| I2 | No unauthorized negative balance | `CHECK` + kernel lock check + checker |
| I3 | Held funds unspendable | Separate `customer_held` account; spends only debit `available` |
| I4 | No double settlement | Unique entry reference; unique `(provider, providerReference)`; state machine |
| I5 | No duplicate external reference | UNIQUE index |
| I6 | No unfunded reward | `incentives:funded` non-negative; rewards debit only it |
| I7 | No mock production settlement | Provider registry + runtime-safety; checker flags ops with `mode='mock'` in production |
| I8 | No silent deletion | Immutability triggers; FK RESTRICT |
| I9 | No balance mutation outside the kernel | `projection_guard` + `ledger_account_guard` |
| I10 | No cross-user debit without authorization | Kernel `debit` requires an authorization context (`actor` = owner, or a system flow with a consent record); checker samples entries |
| I11 | Projections equal ledger | Checker: `Wallet.koriBalance = account.balance` for every projected account |
| I12 | Materialized balance = Σ postings | Checker: recompute per account |
| I13 | Escrow reconciles | `escrow:delivery:*` balance = Σ `DeliveryEscrow` in held states |
| I14 | Tontine pot reconciles | Pot = Σ settled contributions − payouts − refunds of the cycle |
| I15 | Agent float reconciles | Float = Σ float postings (= `AgentFloatEntry` history) |
| I16 | Liabilities ↔ backing | Report D/E; the difference is fully attributed to named accounts |
| I17 | Peg | `conversion:{CUR}` = peg × `conversion:KRI` |
| I18 | Reversal unique | `reversesId` UNIQUE |
| I19 | Test faucet never used in production | Kernel guard + checker (zero `test:faucet` postings in production) |

`npm run money:check` (`scripts/money-check.mjs`) runs the checker read-only (`BEGIN READ ONLY`) and exits non-zero on any violation. The torture suite calls it after every scenario.

## 10. Migration strategy (no flag day)

1. **Introduce** the ledger tables and triggers (additive).
2. **Opening balances:** for every legacy balance row (Wallet, BusinessWallet, PaymentFund, MerchantVoucher, AgentProfile float, TontineGroup pot, held DeliveryEscrow), create the account and post `opening_balance` from `migration:opening:{CUR}` with `actorType='migration'` and `metadata.legacy = {table, id, value, snapshotAt}`. **No invented history.**
   - Batch: `scripts/money-backfill.mjs` (dry-run default).
   - Lazy: the kernel's account resolver posts the opening balance automatically when it first meets an unmigrated non-zero projection row, in the same transaction.
3. **Compare:** the backfill reports `legacy value` vs `ledger balance` per row; any mismatch stops the batch.
4. **Writes:** every money path calls the kernel (this phase). Legacy `LedgerEntry`/`KoriTransaction` rows are still written in the same transaction as the **user-facing statement** read model.
5. **Reads:** balances come from the projection, which the DB guarantees equals the ledger. Statements keep reading `LedgerEntry`, a projection written in the same transaction.
6. **Disable legacy mutation:** `projection_guard` makes any non-kernel write fail.
7. **Retire** `KoriTransaction`/`LedgerEntry` as authority after evidence (J3+). They are already non-authoritative.

## 11. Deployment and migrations

- `prisma/migrations/<ts>_j2_money_kernel/` is generated with `prisma migrate diff` from the production-shaped baseline plus the J1 migration, reviewed, and additive only.
- `scripts/db-migrate-deploy.mjs` replaces `db-sync-deploy.mjs` in `vercel-build` **when activated** (not now):
  1. detect drift (`migrate diff --from-migrations … --to-url`);
  2. refuse destructive steps;
  3. `prisma migrate deploy`;
  4. apply idempotent SQL guards;
  5. fail the build on any error.
- **Rehearsal:** `scripts/rehearse-migration.mjs` (`npm run money:rehearse`) builds a DB from `0_baseline` (production shape), seeds legacy-shaped data, runs the migration, the backfill and the invariant checker, then reports.

## 12. Admin and support money controls

- No "set balance" anywhere.
- `requestAdjustment` / `approveAdjustment` (`lib/money-kernel/admin.js`) require:
  - a reason (≥ 10 characters);
  - a named admin session with TOTP (the legacy shared API key is refused);
  - an idempotency key (reuse with a different payload → 409);
  - a cap: `MONEY_ADJUSTMENT_MAX_KORI` (default 1 000 000);
  - **dual authorization for every amount**: a second, different admin approves (`MoneyAdjustmentRequest`: requested → posted | rejected). As built this is stricter than the single-admin ≤ 10 000 ₭ tier first sketched here; loosening it is a product decision.
- Each adjustment is posted as `adjustment` with `actorType='admin'`, linked to the request, plus an `AdminAuditLog` row.
- Support refunds draw from the funded `platform:refunds` budget.

## 13. Torture suite (`tests/money/`)

Every scenario the J2 brief lists, plus the invariant checker after each. See the gate report for results.

## 14. Out of scope (recorded, not built in J2)

| Area | Status |
|---|---|
| Commerce cancel/refund | PARTIAL |
| Rides | NOT IMPLEMENTED |
| Gigs | PARTIAL |
| Mobile/low-end | PARTIAL |
| Locale | PARTIAL |
| Legacy Kebu / redemption / Ñu Lekk value | Uninspected |
