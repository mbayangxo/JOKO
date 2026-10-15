# Jokko J15 handoff (to the next developer)

**Read this first.** It is the stable baseline at the end of J15. Everything here is **local engineering**: nothing on this branch is deployed, no production migration ran, no live money moved, and Kebu (including the Kebu Supabase project) was never accessed or changed.

## 1. Where things are

| Item | Value |
|---|---|
| Repository | `mbayangxo/JOKO` |
| Branch | `claude/jokko-forensic-audit-rprqia` |
| Final commit | see §14 (the last commit touching this file, plus the gate commit) |
| Production | `b0318b5` = `7d262de` + the P0-A containment (deployed 2026-10-10; **runtime verification incomplete**), **not** this branch. Open incidents in §8 |
| Agent instructions | `AGENTS.md` / `CLAUDE.md` (read the K21 docs listed there before touching money) |

## 2. Milestones completed

**J1–J15**, all local. One line each, with reports, in `docs/JOKKO-ROADMAP.md`. In short:
- **J2:** double-entry money kernel.
- **J3:** identity, authorization and the risk engine.
- **J4–J7:** consumer money, merchants, agents and commerce.
- **J8:** logistics.
- **J9:** work.
- **J10:** community.
- **J11:** collective money.
- **J12:** offline.
- **J13:** UX, honest payment states and recipient binding.
- **J14:** partner ecosystem.
- **J15:** the financial torture lab, the S4 approval screen, shared partner rate limits, the P0 reproductions and the final security review.

## 3. Architecture (actual repo)

- **App:** Expo / React Native (web build via `expo export`), `src/` (89 screens).
  - State and API contract: `src/state/AppState.js` and `src/lib/api-client.js`.
  - Money UX classification (what the user is told after a payment): `src/lib/money-ux.js`.
- **API:** one Vercel function, `api/index.js` → `api/_lib/http.js` → `lib/api-router.js` (route table, rate limits, idempotency, error mapping).
  - **Every route has a policy** in `lib/authz/route-policy.js`, enforced by `lib/authz/enforce.js`. A route without a policy is refused (`policy_missing`).
- **Database:** Postgres via Prisma (`prisma/schema.prisma`, 231 models, 29 migrations), plus guard triggers and invariants in `prisma/sql/financial-invariants.sql`.
- **Money kernel (J2):** `lib/money-kernel/`.
  - `post` / `move` / `reverse` write an append-only journal; materialized balances are protected by triggers.
  - `lockAndCheckFunds` gives row-locked balance checks; a DB CHECK forbids negative non-negative accounts.
  - `checkInvariants` (I1–I12) audits it all.
  - Every money flow goes through kernel recipes.
- **Idempotency and honest outcomes:**
  - `lib/api-idempotency.js`: client keys; responses are held until the outcome is final; stale keys converge after a lease (J15).
  - `GET money/intents/:key`: what the client is told after any uncertainty (F17).
- **Domains** (`lib/<domain>/`):
  - `agents/` (cash network), `commerce/`, `b2b/` (distribution);
  - `logistics/`, `work/`, `collective/`, `community/`;
  - `integrations/` (partner API, events, keys, debits, rate limits);
  - `risk/`, `identity/`, `money/` (read models).
- **Background jobs:** `lib/cron/*`, exposed as `cron/*` routes (CRON_SECRET bearer, constant-time compare). Only `cron/daily` and `cron/scheduled-payments` are scheduled in `vercel.json`.
- **Legacy:** `/server` (Express) is superseded; do not use it.

## 4. Feature flags and deployment status

Every new money capability ships **off**; `tests/j15/flags-default-off.test.js` enforces opt-in comparisons.

| Flag | Default | What it turns on |
|---|---|---|
| `PARTNER_SCOPED_KEYS_ENABLED` | off | J14 scoped partner keys (else legacy `JOKO_API_KEYS`) |
| `PARTNER_EVENTS_ENABLED` | off | signed partner webhooks (S1) |
| `PARTNER_PRODUCT_MAPPING_ENABLED`, `PARTNER_FULFILLMENT_ENABLED` | off | S2 / S3 |
| `PARTNER_DEBIT_INSTRUCTIONS_ENABLED` | off | S4 partner-requested debits (in-app approval required) |
| `MBOLO_ORDER_CARD_ENABLED`, `MBOLO_ORDER_EXPIRY_ENABLED` | off | S5 chat orders, 30-min reservation |
| `PARTNER_AUDIT_RETENTION_ENABLED`, `PARTNER_AUDIT_LEGAL_HOLD` | off | F3 retention / hold |
| `JOKKO_LOGISTICS_ENABLED` | off | J8 logistics money |
| `JOKKO_WORK_MONEY_ENABLED` | off | J9 work money |
| `JOKKO_COLLECTIVE_ENABLED`, `JOKKO_PROTECTED_FUNDS_ENABLED`, `TONTINE_ESCROW_ENABLED` | off | J11 collective money |
| `AFFILIATE_DEFERRED_SETTLEMENT` | off | refund-aware affiliate commissions (F4) |
| `LEGACY_CONSUMER_DELIVERY_ENABLED`, `LEGACY_B2B_ORDERS_ENABLED` | off | retired legacy flows |
| `PLATFORM_INCENTIVES_ENABLED` | off | unfunded rewards (never in production) |
| `ALLOW_BETA_DEPOSITS`, `ALLOW_BETA_OTP` | off; **inert in production** (J15 S-1) | local test conveniences |
| `AGENT_DEPOSITS_ENABLED` | **on** (`=false` disables) | J6 agent cash network |
| `PARTNER_LEGACY_PLATFORM_SETTLEMENT` | **on** (`=false` disables) | legacy unmapped Kabu settlement (P-J6-7) |
| S4 limits `PARTNER_DEBIT_LINE_MAX_XOF` / `_INSTRUCTION_MAX_XOF` / `_DAILY_MAX_XOF` / `_DAILY_MAX_COUNT` | 500 000 / 5 000 000 / 10 000 000 / 20 | **provisional local test limits, not approved for production** |

**Deployment:**
- `vercel.json` disables deployments of this branch (`git.deploymentEnabled`).
- The crons are unchanged. The gate checks `deploy_inert yes`.
- Nothing from J2–J15 is live.

## 5. Environment and database (no secrets)

- **Node 22**, local **Postgres 16** on `localhost:5432` (`npm run db:ensure`; see `docs/JOKKO-LOCAL-POSTGRES.md`).
- **Server variable names:**
  - core: `DATABASE_URL`, `DIRECT_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ADMIN_JWT_SECRET`, `DATA_ENCRYPTION_KEY`, `CRON_SECRET`;
  - optional: `SENTRY_DSN`, `RESEND_API_KEY`, `RESEND_FROM`;
  - providers: `JULAYA_*`, `STRIPE_SECRET_KEY`;
  - partners: `JOKO_API_KEYS` (legacy partner keys), `PARTNER_SETTLEMENT_USER_ID`.
- **Never** commit values. The test harness supplies fixed local test secrets.
- **Fresh local database:**
  ```bash
  createdb -h localhost -U postgres joko_dev
  export DATABASE_URL="postgres://postgres:postgres@localhost:5432/joko_dev?sslmode=disable" DIRECT_URL="$DATABASE_URL"
  npx prisma db push --skip-generate
  npx prisma db execute --schema prisma/schema.prisma --file prisma/sql/financial-invariants.sql
  npx prisma generate
  ```
- **Production migrations** use `npm run db:migrate:deploy`, and **must not be run** without an authorized production change.

## 6. Tests and gates

| Command | What |
|---|---|
| `npm test` | Full suite: unit, integration, security, http, money, j3 … j15. **Always `--test-concurrency=1`** (shared fixtures). |
| `node --test --test-concurrency=1 <file>` | One file |
| `npx prisma format --check` | Before any schema commit |
| `bash scripts/dev/gate.sh <worktree> <out> <db> [web] [playwright-core] [chromium]` | **Fresh-database gate.** Suite, all invariants, load, sweeps, web build, E2E J8–J15, weak-network lab, migration rehearsal, schema diff, audit, deploy-inert. Marks the run VOID if Postgres restarts. Run it in a separate worktree checked out at the commit under test, with its own `node_modules`. |
| `LAB_HARNESS_WORKERS=4 npm test` | The whole suite against 4 API processes per server |
| `docs/JOKKO-J15-LAB.md` | The torture lab: `scripts/lab/run.mjs`, `campaign.sh`, `kernel-storm.mjs`, P0 reproductions |

Browser E2E needs a web export (`EXPO_NO_TELEMETRY=1 npx expo export --platform web`), `playwright-core` and Chromium (`/opt/pw-browsers/...` in this environment). The gate script takes the paths.

## 7. Test results

See §14 for the final gate at the final commit. The J15 history, with failures and repairs, is in `docs/JOKKO-J15-REPORT.md` §2, §6 and §7.

## 8. Unresolved production incidents (separate track, NOT done)

Production runs **`b0318b5`** (`7d262de` + the P0-A containment). Packages and patches are under `docs/incidents/`. Each was reproduced on legacy code and refuted on its patch under concurrency (`docs/incidents/lab-p0/`, run on `7d262de`; the P0-B and F1 patches are byte-identical for `b0318b5`). Every remaining fix needs an authorized, separate deploy on the production base (never this branch, never bundled) plus production verification.

| Incident | Severity | Package | Status |
|---|---|---|---|
| P0-A tontine drain | P0, theft-capable | `2026-10-p0-tontine-drain-live/` | **Containment DEPLOYED** (`b0318b5`, `dpl_CmyTMHWs…`, 2026-10-10). **Runtime verification INCOMPLETE**: owner checks 1–3 in README §10 still to do. Forensics (read-only SQL) not run |
| P0-B delivery-dispute ruling by non-operators | P0 | `2026-10-p0-delivery-dispute/` | **OPEN on `b0318b5`**, likely exposed. On legacy code concurrent rulings also pay one escrow twice (lab); the patch (`emergency-b0318b5.patch`) closes the route |
| F1 coop double payout | P1 | `2026-10-f1-coop-double-payout/` | **OPEN on `b0318b5`**. Hotfix (`f1-hotfix-on-b0318b5.patch`) verified locally; 5× / 3× payouts reproduced on legacy |
| F4 affiliate commission never reversed | latent | `2026-10-f4-affiliate-commission/` | Not live on the production base; becomes live if any commit with `494991d` is deployed. Decision needed |
| Web slow boot | availability of the web app on 2G / slow 3G; no money or data risk | `2026-10-web-slow-boot/` | OPEN on `b0318b5`; patch package ready |

## 9. Open defects and risks (this branch)

See `docs/JOKKO-J15-REPORT.md` §8 for the complete list. None is a known money-correctness defect.

## 10. Security review (J15 final)

Findings S-1 to S-3, scope and results: `docs/JOKKO-J15-REPORT.md` §9.

## 11. Recommended J16 priorities

1. **Production track first** (separate, authorized):
   - complete the P0-A runtime verification (README §10, checks 1–3) and the read-only forensics;
   - deploy P0-B, then F1, on `b0318b5`, each verified in production;
   - then take the F4 decision and fix the web slow boot.
   - Never roll back to `7d262de`: it contains P0-A.
2. **Staging that models production:** Vercel instance count, the Supabase pooler and `connection_limit`. Re-measure the J15 latency budgets there and set real SLOs. OI-1 showed that connection exhaustion is the first failure mode under multi-instance load.
3. **Chaos providers** for the rails: Julaya / Stripe / partner receivers with duplicates, reordering, forged and late callbacks, amount mismatches. Live Julaya sandbox round-trip.
4. **Lab coverage:** crash scenarios with outcome audits for logistics, work, collective and agents (today: P2P, requests, merchant charges, kernel); per-worker clock skew.
5. **Policy decisions still open:** S4 production limits, the L6 production SLOs, the J9 / J11 money approvals and the P-J9 / P-J11 decision reviews.
6. **Observability:** Sentry, uptime and the morning checklist (`docs/K21-QUALITY-CONTROL.md`), with an alert for every lab failure mode (stuck intents, `db_unavailable` rate, reconciliation exceptions).

## 12. Rules that must not be broken

From `AGENTS.md` and `docs/K21-FINANCIAL-SECURITY.md`:
- every money change is atomic and goes through the kernel;
- every API call handles failure;
- never weaken an assertion to get green;
- a flaky test is a finding.

Unknown outcomes are never shown as failed or as succeeded until the server answers (F17). Keep the emergency production track separate. Never touch Kebu. Never deploy from this branch without explicit authorization.

## 13. How not to repeat work

- **Before building:**
  - decisions are in `docs/JOKKO-DECISIONS.md` and the `*-DECISION-REVIEW.md` files;
  - money and authorization semantics are in the J2 / J3 design docs;
  - the partner contract is `docs/JOKO-PARTNER-API.md`.
- **Root causes already established:** historical J4 failures, J6 scan order, OI-1. All are in the J15 report; don't re-investigate them.
- **Proving a money change under concurrency:** use the lab (`docs/JOKKO-J15-LAB.md`) rather than writing a new harness.

## 14. Final verification

_Filled in at the end of J15._
