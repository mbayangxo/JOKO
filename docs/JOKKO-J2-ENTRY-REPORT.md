# Jokko: J2 (Money Kernel) entry report

| | |
|---|---|
| Date | 2026-10-03 |
| Branch | `claude/jokko-forensic-audit-rprqia`, pushed. Vercel deployments for this branch stay **disabled** (`vercel.json` → `git.deploymentEnabled`). |
| HEAD | `7230d3e` |
| Scope | Local, disposable Postgres only. Nothing was deployed. Production and Preview were not called, read or mutated. The Kebu Supabase project was not touched. |
| J2 | **Not started.** This report is the entry gate. |

---

## Verdict

| Gate | Status |
|---|---|
| **J2 code entry** (start designing and building the Money Kernel on this branch) | **PASS**: every J1/J0 safety item fixable in code is fixed or contained, regression-tested, and the full gate is green on a fresh DB (below). |
| **Production deploy of this branch** | **BLOCKED**. Needs production read-only access and three decisions. See §D. |
| **J0 audit Phases 6–23** | Complete locally. See the phase matrix in `JOKKO-FORENSIC-EVIDENCE-REPORT.md` (run 4). |

Recommendation:
- Enter J2 **design** now.
- Keep **deploy** blocked until §D items 1–5 are done.
- J2 itself requires replacing `prisma db push` with reviewed migrations, so the deploy path will be rebuilt anyway (§E.6).

---

## Exact gate status (fresh database `joko_j2_gate`, HEAD `7230d3e`)

| Check | Command | Result |
|---|---|---|
| Schema + DB invariants on an empty DB | `npm run test:db:setup` | **PASS** (exit 0) |
| Canonical suite (unit, integration, security, adversarial HTTP in `NODE_ENV=production`) | `npm test` | **330 / 330 pass**, 0 fail, 0 skipped (59 test files) |
| Concurrency / load | `npm run test:load` | **3 / 3 pass** (1 000 concurrent senders, overdraft races) |
| Data-exposure + horizontal-authz sweep (every authenticated GET route; every admin route) | `npm run test:sweep` | **2 / 2 pass**: 106 user GET routes × other people's ids, plus every admin route with a user token; no leak, no 2xx on others' private resources, no 5xx, scrubber never fired |
| Provider failure injection (fake Julaya: pending/completed/failed/400/500/timeout, duplicate/out-of-order webhooks, amount mismatch; SMS/email/KYC unavailable) | inside `npm test` (`tests/http/*`) | PASS (part of the above) |
| Legacy-thread migration dry run | `node scripts/migrations/mbolo-message-requests.mjs` | exit 0: `toRequested: 0` remaining, because the suite's legacy-migration test had already executed it on this DB (idempotency confirmed). The conversion itself is tested in `message-requests` › "legacy migration". |
| Web build | `npx expo export --platform web` | **exit 0** (main bundle 4 MB) |
| TypeScript | `npx tsc --noEmit` | exit 2: the **same 5 pre-existing errors**, all in `supabase/functions/cron-proxy` (Deno code, not part of the app/API build); 0 errors elsewhere |
| Dependency scan | `npm audit --omit=dev` | 42 advisories: 29 high, 13 moderate, 0 critical (see A6) |
| Secret scan (tracked files: live/test Stripe keys, AWS, Resend, GitHub, Slack tokens, private keys, credentialed Postgres URLs, JWTs) | grep patterns | **0 hits**; only `.env*.example` files are tracked |
| Exposure pack on the **pre-deploy production schema** (DB built from `0_baseline`) and on the current schema | `psql -v ON_ERROR_STOP=1 -f scripts/forensics/production-exposure.sql` | **exit 0 on both** |
| Deploy guard against the production-shaped DB | `node scripts/db-sync-deploy.mjs` | **exit 1 (refuses)**: lists 9 tables and 17 columns it would drop; nothing changed |
| Lint | — | NOT CONFIGURED (ESLint 10 installed, no config) |
| Browser E2E | — | NOT PRESENT |

---

## A. Safety debt (open items; all code-fixable P0/P1s are done)

| # | Sev | Item | State |
|---|---|---|---|
| A1 | **P0 (unknown scope)** | Production may already contain the consequences of the J1/J0 P0s: <br>• mock-settled cash-ins and beta credits;<br>• minted earn rewards;<br>• the tontine drain;<br>• **Mboolo credential/PII exposure**;<br>• **KYC sandbox approvals (Tier 2/3 without verification)**, new in run 4. | Measurable only with read-only production access → §D1. The exposure pack has a section for each (§0–§19). |
| A2 | **P0 (deploy)** | **Schema drift.** The committed baseline (captured from Postgres on 2026-08-17) has 9 tables and 17 columns that `schema.prisma` no longer defines: `KebuInvestment*`, `KoriRedemption*`, `MerchantPromo*`, `NuLekk*`, `Order.promoId/discountKori/subtotalKori/promoCode`, `DeliveryTask.proof*`, `TontineContribution.cycleKey`, `User.afriClass`, … <br>On that shape the old deploy script's `db push` fails, and the script then **deployed anyway**. This branch reads `User.sessionsRevokedAt` on every authenticated request, so that would mean a full outage. On an emptier DB it would silently drop the tables. | **Contained**: `db-sync-deploy.mjs` now refuses destructive diffs and failed syncs (`740208d`). **Decision needed** (§D3): restore the models, or approve the drop after backup and §17 row counts. |
| A3 | P1 | Credential remediation (forced PIN/password reset, session revocation) is **built but not executed**. Notifications are **prepared, not sent**. | Waits for §D1 classification (A/B/C). Runbook: `JOKKO-CREDENTIAL-REMEDIATION.md`. |
| A4 | P1 | Legacy Mboolo threads opened without consent stay active until the one-time migration runs. | Script ready (dry run by default; `--confirm-production <host>`). Pack §18 counts the rows. Not run anywhere shared. |
| A5 | P1 | KYC-sandbox-approved production accounts, if any, keep their tier. | Pack §19 lists them (ids only). Demotion/re-verification is a decision for after §D1. |
| A6 | P2 | 29 high / 13 moderate npm advisories (production deps). Nearly all are in build tooling (Metro, Expo CLI, xmldom, node-forge, braces). npm's suggested "fixes" are major **downgrades**. | Triage on an Expo SDK bump. `undici` (HTTP client) and `nanoid` should be checked for runtime reachability first. |
| A7 | P2 | Jekkal campaigns can name **any** user as beneficiary without their consent. Funds go to that user, but the name can be used for impersonation. | Open (product decision: beneficiary accept step). |
| A8 | P2 | Partner (Kebu) API can message any Jokko user by phone through system threads. | Documented partner-trust decision. Partner threads are outside the message-request model. |
| A9 | P2 | Admin refunds come from a platform float wallet with no order link. The platform absorbs every refund; the merchant is never debited. | Superseded by the J2 refund design (`JOKKO-PRODUCT-GAPS.md` §1). |
| A10 | P2 | Accessibility: only a handful of `accessibilityLabel`s; large-text and low-data modes are partial. | Open (UI work) |
| A11 | P3 | Standalone courier fee uncapped. Admin-refund ledger `counterpartyName` falls back to the recipient's phone. | Open |
| A12 | P3 | Calls (LiveKit), video (Vercel Blob), KYC, SMS, email, music and geo search depend on providers. Without a provider each fails closed (503/502), as tested; none is verified live. | Provider onboarding |

**Fixed in run 4.** All are regression-tested. Five were also shown to fail on the previous code:
- offline sync (3/3 tests failed);
- attachment re-parenting (201 before the fix);
- KYC auto-approval (202/200 before the fix);
- open-delivery visibility (sweep finding before the fix);
- deploy drift (the old `db push` failed on the baseline shape).

The others are new capabilities, so there is no "before" to fail:

| Fix | Commit |
|---|---|
| Credential remediation capability | `a9bf1be` |
| Message requests | `03b8cd0` |
| Route-wide exposure sweep | `bf0bce3` |
| Log/Sentry redaction; catch-alls no longer echo DB errors | `bf0bce3` |
| Open deliveries visible to couriers only | `bf0bce3` |
| Offline-sync hijack / cross-business read / phone disclosure / 500 | `bf0bce3` |
| Refresh-token fork and reuse detection; `logout` / `logout-all` | `bf0bce3` |
| Mboolo attachment re-parenting | `0290668` |
| Deploy guard | `740208d` |
| Schema-tolerant exposure pack | `646086e` |
| **KYC auto-approval in production (P0)** | `7230d3e` |

---

## B. Architecture debt

1. **No single source of truth for money.** There are two parallel histories (`LedgerEntry`, `KoriTransaction`) plus the mutable `Wallet.koriBalance` and a legacy `Wallet.balance` column. Balances are not derived from or checked against a ledger.
2. **Side-table balances outside any ledger:**
   - `BusinessWallet.balance`, `PaymentFund.balanceKori`, `MerchantVoucher.balanceKori`;
   - `TontineGroup.potBalance` (+ `TontinePotEntry`), `DeliveryEscrow`;
   - `AgentProfile.floatBalance` (+ `AgentFloatEntry`).

   `custodyKoriTotals` stitches them together for reconciliation.
3. **`KoriReserve` is bookkeeping, not a reserve.** Every mint adds ₭×10 "XOF held" without reference to a bank or mobile-money statement. Reconciliation proves internal consistency, not backing.
4. **Schema delivery:** `prisma db push` on every build, against whatever `DATABASE_URL` the build sees (Preview included). The baseline is stale (A2), and `financial-invariants.sql` is applied out of band.
5. **Authorization is application-level only** (no RLS). Safety rests on handler checks, explicit DTOs and the sweep test. The global secret scrubber is a backstop that now logs when it fires.
6. **Messaging realtime is polling.** Presence/typing are Postgres rows.
7. **Rate limits / idempotency** are Postgres tables. Correct across serverless instances, but they add write load per request (`ApiAuditLog` too).

---

## C. Product gaps (details in `JOKKO-PRODUCT-GAPS.md`)

| Area | Status |
|---|---|
| Commerce | **PARTIAL**: no cancel/refund/return/goods-dispute. b2c pays the merchant directly (no escrow). |
| Rides | **NOT IMPLEMENTED** |
| Gigs | **PARTIAL**: post/list only. Apply → accept → perform → confirm → dispute → pay → review NOT IMPLEMENTED. |
| Kori → cash conversion | **NOT IMPLEMENTED** (410) |
| Diaspora (LemFi) | **SHELL** (coming-soon flag) |
| Realtime messaging | NOT IMPLEMENTED (polling) |
| Wolof / full localisation | **PARTIAL**: French UI hard-coded, no i18n library |
| Events | Moved to a separate app. API routes remain, main-app UI removed. |

### Feature map (REAL / PARTIAL / HARDCODED / MOCKED / LOCAL-ONLY / SHELL / BROKEN / NOT IMPLEMENTED)

| Feature | Class | Notes |
|---|---|---|
| Wallet, P2P send/request/undo | REAL | Closed-loop stored value |
| Cash-in / cash-out (Julaya), Stripe deposit | REAL code, provider-dependent | Production without keys = `unavailable` (fail closed). Live provider NOT VERIFIED. |
| Agent cash-in/out, float | REAL | Tested over HTTP |
| Merchant pay, vouchers, affiliate split | REAL | |
| Marketplace | PARTIAL | No cancel/refund |
| Delivery (courier escrow), hub parcels | REAL | |
| Tontine (consent + escrow) | REAL | Production money **disabled** until `TONTINE_ESCROW_ENABLED=true` |
| Jekkal solidarity | REAL | Code-level money path; beneficiary consent missing (A7) |
| Payroll, school fees, cooperative, distribution/trade, scheduled payments, payment funds, student pass | REAL code | Horizontal read authz swept. Money paths not HTTP-adversarially tested. |
| Mboolo messaging, message requests, stories, media | REAL | Polling |
| Calls / video | SHELL without LiveKit / Blob | 503 |
| KYC (CNI, address) | REAL code, provider-dependent | Was **MOCKED in production** (P0, fixed) |
| SMS / email OTP | REAL code, provider-dependent | 503 when undeliverable |
| Emergency alerts / culture feed | HARDCODED (dev only) | Hidden in production |
| Music / geo search | REAL code, provider-dependent | 503/502 |
| Offline sync | REAL (farmer deliveries only) | |
| Kori convert | NOT IMPLEMENTED (410) | |
| Rides | NOT IMPLEMENTED | |
| Gigs | PARTIAL | |
| Partner API (Kebu) | REAL | |
| Admin console | REAL | TOTP |

---

## D. Production-blocked verification (cannot be done from this session)

1. **Read-only production DB access** (role and replica recipe in `JOKKO-PRODUCTION-EXPOSURE.md` §1). Then run `scripts/forensics/production-exposure.sql`. It is schema-tolerant and validated on the 2026-08-17 shape. It answers A1, A2 (§17), A3 (§15–16), A4 (§18) and A5 (§19).
2. **Vercel topology** (403 today):
   - Production and Preview DB host/database/role;
   - provider credentials scoped to Preview;
   - webhook URLs and secrets per environment;
   - whether Preview can mutate production.

   Until proven, Preview is unsafe and branch deploys stay disabled.
3. **Decision on schema drift (A2):** restore the 9 models / 17 columns in `schema.prisma`, or approve dropping them after a backup and §17 row counts. The deploy guard blocks the build until then.
4. **Decisions after the exposure report:**
   - credential remediation classes (A/B) and notification send;
   - legacy-thread migration run;
   - KYC re-verification of sandbox-approved accounts;
   - value corrections. These are append-only adjustments only (procedure in `JOKKO-PRODUCTION-EXPOSURE.md` §2), so they are best executed by the J2 kernel's adjustment API.
5. **Live provider verification** (Julaya, Stripe, SMS, Resend, KYC) in a non-production environment with sandbox credentials.

---

## E. J2 proposed architecture (design only; nothing implemented)

### E.1 One authoritative ledger

- An append-only, double-entry `JournalEntry(id, reference UNIQUE, kind, createdAt, actor, reason, reversesId?)` with ≥2 `Posting(entryId, accountId, amountKori BIGINT)` rows.
- **Invariant:** Σ amount per entry = 0, enforced by a deferred constraint trigger.
- DB triggers forbid UPDATE/DELETE on both tables (like today's `LedgerEntry`).
- Every money movement in the app becomes exactly one journal entry, written in the same transaction as the business state change: order paid, tontine contribution, payout, and so on.
- Balance = Σ postings per account. `Account.balance` is a **cache** updated in the same transaction and verified by a nightly job (`SUM(postings) = cached`). Any mismatch freezes the account and alerts.

### E.2 Account types (system and user)

| Type | Examples |
|---|---|
| `customer:{userId}` | Personal wallet (replaces `Wallet.koriBalance`) |
| `merchant:{businessId}` | Replaces `BusinessWallet.balance` |
| `agent_float:{agentId}` | Agent cash float |
| `external_settlement:{rail}` | `julaya`, `stripe`, `bank` …; mirror of money at the provider |
| `clearing:{rail}` | In-flight: initiated and not yet confirmed |
| `escrow:{kind}:{id}` | `order`, `delivery`, `gig`, `dispute` |
| `tontine_pot:{groupId}` | Replaces `potBalance` |
| `fees:{product}` | Platform revenue |
| `incentives:funded` | Rewards. Can only go negative by policy, if ever: rewards must be pre-funded from `fees` or `treasury`. |
| `refunds` / `reversals` | Refund and reversal flows |
| `voucher:{id}`, `payment_fund:{id}` | Replace the side-table balances |
| `platform:loss`, `platform:treasury`, `receivable:merchant:{id}` | Liabilities and assets |

### E.3 Flows (examples)

| Flow | Posting |
|---|---|
| Cash-in initiated | none |
| Cash-in confirmed | `external_settlement:julaya` → `customer` |
| Cash-out | `customer` → `clearing:julaya` at initiation; then `clearing` → `external_settlement` on confirmation, or `clearing` → `customer` on failure (once) |
| Order | `customer` → `escrow:order` → `merchant` (− `fees`) |
| Tontine | `customer` → `tontine_pot` → `customer:recipient` |
| Corrections | `adjustment` entries with a reason code and `reversesId` |

### E.4 Reserve from reconciled settlement

- `external_settlement:*` balances are reconciled daily against **provider statements** (imported files/API), not against app counters.
- The reserve figure = Σ reconciled external settlement + treasury cash. It must be ≥ Σ customer + merchant + agent + escrow + pot liabilities.
- Breach → cash-outs frozen (as today, but grounded in real statements).
- `KoriReserve` becomes a derived report, not a counter.

### E.5 Migration path (no big bang)

1. Create the ledger tables and accounts.
2. **Opening balances:** one `opening_balance` entry per account from current balances, against `platform:migration` (must net to the custody total). Run on a production snapshot first.
3. **Dual-write:** each existing money path posts journal entries alongside today's writes, behind a flag. A shadow verifier compares balances continuously.
4. Switch reads to the ledger, path by path. Then retire `KoriTransaction` and `Wallet.balance`. Keep `LedgerEntry` as a read model or migrate it.
5. Exposure corrections (§D4) are executed as `adjustment` entries.

### E.6 Schema delivery: `prisma migrate deploy`

1. Resolve the A2 drift.
2. Re-baseline from a production snapshot: `migrate diff --from-url <snapshot> --to-schema-datamodel` → reviewed `prisma/migrations/<ts>_reconcile`, then `migrate resolve --applied` on production for the baseline only.
3. Every change is a reviewed migration file. `financial-invariants.sql` becomes migrations.
4. Deploy runs `prisma migrate deploy` with a dedicated **migration role** and fails the build on error. The app role has no DDL rights.
5. Rehearse each migration on a restored snapshot. Take a PITR snapshot before each production migration and write a down/recovery note.
6. Preview gets its own database and credentials, or Preview deploys stay disabled.

### E.7 J2 acceptance criteria (proposed)

- Every money route posts exactly one balanced entry, enforced by the DB.
- The nightly cache verifier is clean.
- Property tests show random concurrent operations conserve Σ.
- The reserve is reconciled to statements.
- The exposure corrections are posted.
- The current HTTP adversarial suite, load tests and data-exposure sweep pass unchanged.
