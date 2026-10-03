# Jokko — production exposure investigation & environment topology

Status as of 2026-10-03 (run 4). Production access is still unavailable, so every item below is still BLOCKED.

| Item | Status | Reason |
|---|---|---|
| Production exposure investigation | **BLOCKED** | No read access to production. The Vercel API returns 403 for scope `mbayangxos-projects`; the only visible Supabase project is the paused **Kebu** project (out of scope, not touched). |
| Preview vs Production topology | **BLOCKED** | Same 403. Project env vars and deployments can't be listed. |
| Calling the production API "read-only" | **Refused** | Every request, including `GET /api/health`, writes an `ApiAuditLog` row (`lib/api-audit.js`). It is a production write, not a read. |
| Deployments of `claude/jokko-forensic-audit-rprqia` | **Disabled** | `vercel.json` → `git.deploymentEnabled`. Stays in place until topology is proven. |
| Deploy-time schema sync | **Fail-closed** (run 4) | `scripts/db-sync-deploy.mjs` refuses destructive diffs and failed syncs. The 2026-08-17 baseline shape has 9 tables and 17 columns `schema.prisma` no longer defines (§17). |

## 1. How to run the exposure check (read-only)

1. Give the investigator a **read-only** Postgres role, or a read replica, for the production database.
   Example (run by the DB owner):
   ```sql
   CREATE ROLE jokko_forensics LOGIN PASSWORD '…' NOSUPERUSER NOCREATEDB NOCREATEROLE;
   GRANT CONNECT ON DATABASE postgres TO jokko_forensics;
   GRANT USAGE ON SCHEMA public TO jokko_forensics;
   GRANT SELECT ON ALL TABLES IN SCHEMA public TO jokko_forensics;
   ALTER ROLE jokko_forensics SET default_transaction_read_only = on;
   ```
2. Run:
   ```bash
   psql "$PRODUCTION_READONLY_URL" -v ON_ERROR_STOP=1 \
     -f scripts/forensics/production-exposure.sql > exposure-$(date +%F).txt
   ```
   The script runs in `BEGIN TRANSACTION READ ONLY … ROLLBACK`. It outputs internal ids, references and amounts only.
3. Validated against the QA database: it detected the reproduced tontine drain (1 run, 60 000 ₭ from others), the `kori/convert` burn (500 ₭) and the KYC sandbox approvals.
4. **Schema-tolerant** (run 4): it runs on the **current production schema, before this branch deploys**. Validated with `ON_ERROR_STOP=1`, exit 0, on a database built from `prisma/migrations/0_baseline` (the 2026-08-17 shape) and on the current schema.

### What each section answers

| § | Question | Finding it maps to |
|---|---|---|
| 0 | Do custody totals match the reserve? | Reserve bookkeeping |
| 1 | Were cash-ins settled by the mock Julaya rail (`sandbox-*`)? | P0-2 |
| 2 | Which `cash_in` ledger rows have no authoritative settlement (completed non-sandbox rail, completed Stripe deposit, confirmed agent deposit)? Split by `DEP-`/`BETA-`/`CIN-` | P0-1, P0-2 |
| 3 | How much ₭ was minted as "earn" rewards, and by whom (possible farming)? | P0-6 |
| 4 | Self-transfers, and same-day A↔B round trips | P0-6 |
| 5 | Agent payouts credited, and the 10× unit error | P0-11 |
| 6 | Legacy delivery escrows: fee debited as ₭ (10×), rider reward minted | P0-12 |
| 7 | Partner payouts that burned funds and failed without refund; double burns; partner payments completed without a provider rail | P0-13, P0-3 |
| 8 | Cash-outs pending or completed while the wallet was never debited (spendable funds) | P0-4 |
| 9 | Duplicate external ids, refunds or Stripe sessions | Exactly-once settlement |
| 10 | Old tontine auto-collections: who was debited, how much went to creators' personal wallets | P0-15 |
| 11 | `kori/convert` burns with no destination | P1-23 |
| 12 | Phone accounts with an email marked verified (typed at profile or attached by recover); OTPs in the SMS log | P0-9, P1-16, P0-7 |
| 13 | Seeded demo alerts and culture items in the DB | P2-19 |
| 14 | Any negative balance (must be zero rows) | Invariant |
| 15 | Who read thread lists that leaked other members' PIN/password hashes and PII; how many users' hashes were exposed | P0 (run 3) |
| 16 | Credential exposure classes A/B/C, with ids for `remediate-credentials.mjs` | P0 (run 3) → remediation |
| 17 | Schema drift: row counts of tables, and non-null counts of columns, that `schema.prisma` no longer defines | Deploy blocker (run 4) |
| 18 | Legacy Mboolo members the message-request migration would convert (count) | Messaging consent (run 4) |
| 19 | KYC sandbox approvals in production; Tier 3 accounts without a provider-backed CNI job | **P0 (run 4)** |

## 2. Proposed reconciliation / remediation procedure (NOT executed)

Nothing in production has been or will be repaired until the exposure report has been reviewed.

1. **Freeze first, decide second.** Deploy the J1 code (it fails closed), then run §0–§14 on a fresh read-only snapshot. Record the snapshot time.
2. **Classify every flagged movement:**
   - **A** — test/beta value in a non-real account: void.
   - **B** — real user received unfunded value (mock cash-in, beta credit, earn, 10× payout, minted rider reward).
   - **C** — real user lost value (tontine debits without consent, convert burns, burned failed partner payouts, 10× delivery fees).
   - **D** — platform lost value (paid-out cash-outs that were never debited).
3. **Never edit or delete history.** Every correction is a new, referenced, append-only adjustment:
   - It needs a reason code and the id of the original movement.
   - It runs through one audited admin procedure (to be built in J2: `adjustment` entries against a named system account).
   - It never runs as ad-hoc `UPDATE … SET koriBalance`.
4. **Ordering:**
   - (C) make victims whole first: refund tontine victims, convert burns, failed-payout burns, over-charged delivery fees;
   - then (A) void test value;
   - then (B) recover unfunded value only where policy allows. Clawing back from real users is a product/legal decision; propose a policy before acting;
   - (D) is platform loss: book it to a loss account and do not debit users retroactively without a decision.
5. **Verify:** after each batch, rerun §0 and §14. The reserve must equal custody totals, and no balance may be negative.
6. **Sign-off:** two-person review on every adjustment batch. Keep the snapshot outputs with the report.

## 3. Preview / Production topology — what must be established

| Question | How to establish it (needs Vercel access) | Status |
|---|---|---|
| Which database does Production use? | Vercel → joko → Settings → Environment Variables: is `DATABASE_URL` / `DIRECT_DATABASE_URL` targeted at **Production**? Compare **host + database name only**, never values in chat. | BLOCKED |
| Which database does Preview use? | Same, target **Preview** (and any branch-specific overrides). | BLOCKED |
| Physically / logically separate? | Different host, or same host but a different database **and** a different role. A shared role is not separation. | BLOCKED |
| Does Preview have production payment/provider credentials? | Check `JULAYA_API_KEY`, `JULAYA_WEBHOOK_SECRET`, `STRIPE_*`, `JOKO_API_KEY(S)`, `PARTNER_*`, `RESEND_API_KEY`, `AFRICASTALKING_*`/`TWILIO_*` for Preview targeting. | BLOCKED |
| Can Preview mutate production data? | Yes if Preview's `DATABASE_URL` points at the production DB. Every preview build also runs `prisma db push` (`scripts/db-sync-deploy.mjs`). | BLOCKED: assume **yes** |
| Could Preview webhooks affect production? | Provider callback URLs (`JULAYA_CALLBACK_URL`, Stripe endpoint, partner webhook URL) must point only at the production domain; Preview must not share webhook secrets. | BLOCKED |

**Rule until proven:** Preview is unsafe. Branch deployments of the forensic branch stay disabled.

## 4. Roadmap: stop `prisma db push` on deploy

Today `npm run vercel-build` runs `prisma db push` against whatever `DATABASE_URL` the build sees, and it never fails the build. That is an unreviewed production migration on every deploy, including Preview builds.

Target:
1. Every schema change is a reviewed migration in `prisma/migrations/`. A baseline (`0_baseline`) and the J1 migration already exist.
2. Deploy runs `prisma migrate deploy` only, against a **migration role**, and fails the build if a migration fails.
3. Migration rehearsal: restore a recent production snapshot into a staging DB, run `migrate deploy`, run the test gate and `production-exposure.sql`, record the timings.
4. Rollback/recovery: each migration ships a written down/recovery plan (most J1 changes are additive; FK RESTRICT and CHECK NOT VALID are reversible). Take a point-in-time recovery snapshot before every production migration.
5. Preview uses its own database and its own credentials, or Preview deploys stay disabled.
6. `prisma/sql/financial-invariants.sql` becomes a regular migration once `migrate deploy` is in place.
