# JOKKO FORENSIC EVIDENCE REPORT — Run 1 (halted at the P0 stop condition)

Date: 2026-09-25. Mode: FIND → PROVE → RECORD. No code was changed, nothing was committed or pushed, nothing was deployed, and production was not touched.

> **The run stopped early.** Phase 6 (money) proved that any logged-in user can create balance from nothing through two public API routes. Your brief says to stop immediately when a severe financial defect turns up, so phases 7–22 were **NOT RUN**. They are not BLOCKED, and none of them PASSED. Phase 23 (test suite) ran before the halt.

---

## 1. Repository / branch / HEAD
| Item | Value |
|---|---|
| Repo | `mbayangxo/JOKO` (the package name is `joko`) |
| Branch | `claude/jokko-forensic-audit-rprqia` |
| Local HEAD | `19ac203` "Complete Partner API slices 2–4: POS, payouts, and Mbolo Business CS." |
| Remote HEAD | `19ac203` (`origin/HEAD` and `claude/k21-phase-1-scope-wnk8gf`). The audit branch does not exist on the remote. |
| Working tree | Clean before the audit and clean after it. There was no uncommitted user work. |

## 2. Naming: legacy vs canonical
- **Joko** is the canonical name in `package.json`, `app.json` (`name: "Joko"`), README, `platform/config`, and the `joko` Vercel project.
- **K21** is still widespread: `docs/K21-*.md`, `design/k21-*.html`, `K21Logo`/`K21QrCode` components, `lib/k21-qr.js`, the Sentry org/project (`k21` / `k21-mobile`), camera/mic permission strings ("K21 utilise…"), user-facing API errors ("Aucun compte K21…", "contacte le support K21"), QR scheme `k21://pay/@handle`, the ledger title "Dépôt K21", and the alert `source: "K21"`.
- **KEIT** survives in the default API URL `https://keit-six.vercel.app` (`app.config.js`).
- **Kori (₭) → "Cauris" (C)**: the API returns `currency: "CAURIS"`, `unit: "C"`, and both `kori` and `cauris` objects. The code still calls the unit Kori everywhere.
- **KEBU** is a separate B2B product that talks to Joko through the Partner API (`/api/v1/*`).
- **Rect** appears as a separate app in `platform/config`.

## 3. Production safety / environments
- **Production**: Vercel project `joko` (`prj_lOUwSQp2PPi8Bhe1tA1jjrKXdiYt`). I could not read its env vars or deployments: the Vercel token got **403** for the scope `mbayangxos-projects`. The mobile app falls back to `https://keit-six.vercel.app`. **I did not call production at all.**
- **Supabase**: the account has one project, **"Kebu"** (`tnygqgcqlnlsmjpygrca`), which is **INACTIVE**. It belongs to KEBU, not Joko. I found no Joko Supabase project visible to this session.
- **QA DB**: none existed and no QA config exists in the repo. I created a **disposable local Postgres 16 database (`joko_qa`) inside this ephemeral container**, applied `prisma db push`, and ran everything against it. It is fully isolated from production.
- ⚠️ **Deploy-time schema mutation**: `vercel-build` runs `scripts/db-sync-deploy.mjs`, which runs `prisma db push` against the production DB on **every deploy** and never fails the build. There is no migration review gate, and `db push` can apply destructive diffs. (P2 reliability, and a data-loss risk.)

## 4. Architecture (as found)
- **Frontend**: Expo 57 / React Native 0.86 / react-native-web. 73 screens and 41 components in `src/`. It talks to the backend through `src/lib/api-client.js`.
- **Backend**: a single Vercel function `api/index.js` → `lib/api-router.js` (≈300 routes in the `ROUTES` table) → `lib/*-service.js`. Data access is Prisma 6 on Postgres. **Supabase is not the app's auth or data layer.** It is used only for optional media storage (service-role key, server side) and optionally for pg_cron.
- **Auth**: custom phone/email OTP. It issues JWTs (30-min access token, 30-day refresh token stored as a hash). It also has PIN, biometric flag, step-up tokens, and a separate admin session system with TOTP.
- **Authorization**: enforced in application code per handler. **No RLS** (Prisma connects as the DB owner).
- **Money model**: `Wallet.koriBalance` is a **mutable integer column**. Alongside it sit two history tables, `LedgerEntry` and `KoriTransaction`. The global `KoriReserve` row holds the circulation and "reserve held XOF" counters.
- **Rails**: Julaya (mobile money), Stripe (cards), LemFi (future), agent cash network, and the Partner API. Each rail falls back to **mock mode** when its key is missing.
- **Jobs**: Vercel cron (2 jobs) plus Supabase pg_cron (8 jobs), all served by `/api/cron/*` and protected by `CRON_SECRET`.
- **Realtime**: none (the app polls). **Offline**: `OfflineSyncQueue` model, the `offline/sync` route, and `src/lib/mbolo-outbox.js` (not audited).
- `/server` (legacy Express) is not in the repo (it is gitignored). `api-disabled/` holds dead per-route files.

## 5. Proven findings (live HTTP against the real `api/index.js` entry, `NODE_ENV=production`, QA DB)

### P0-1 — Unfunded balance creation via `POST /api/deposits/national` — **PROVEN**
- Code: `lib/handlers.js:2166`. The production guard is `if (production && !allowBeta && !source?.includes('julaya')) → 403`.
- A client that sends `{"amount":5000,"source":"julaya"}` gets past the guard. The handler then calls `completeCashIn` directly, with no provider call, no rail row, and no payment proof.
- Evidence: a fresh tier-1 user got **201** with `koriMinted: 500`, `reserveXofAdded: 5000`, `beta: false`, and a ledger row "Dépôt K21 +C 500".
- **This path does not depend on Julaya keys.** It works whether or not Julaya is configured.

### P0-2 — `POST /api/cash/in` auto-settles as "completed" when no Julaya key is set, even in production — **PROVEN**
- Code: `lib/payment-config.js` sets mode to `'mock'` when there is no key, regardless of `NODE_ENV`. Then `lib/julaya.js:85` returns `sandboxResult(...)` with `status: 'completed'`.
- Evidence: two calls (10,000 and 30,000 XOF) each returned **201** `status: completed`, `externalId: sandbox-CIN-…`. The balance went 0 → 1000 → 4000, and the reserve counter was credited with XOF that never existed.
- Production's Julaya config is unknown (Vercel env returned 403). `platform/config` reports `depositsLive: false`, which suggests the key is absent in production too. **If it is absent, this is exploitable in production.**
- Also code-level: in mock mode `verifyWebhookSignature` returns `true` when no secret is set, so the Julaya webhook is unauthenticated.

### Why the integrity checks don't catch it
Every mint also increments `KoriReserve.totalReserveHeldXof` by the same fake XOF amount. The reserve reconciliation stays balanced, so the hourly integrity cron would report healthy. After tests plus my probes, the QA reserve claims 80,308,990 XOF "held".

### P0-3 — OTP returned in API responses in production — **PROVEN for signup; the login path is the same code but I did not run it**
- In `NODE_ENV=production` with no SMS provider configured, `POST /api/auth/phone` returned `{"otp":"709468","sms":"mock"}`. The same thing happens whenever `ALLOW_BETA_OTP=true`, and `docs/K21-BETA-DAKAR.md` lists that as the production setting.
- The same block serves `intent: "login"` and `intent: "recover"`. `recover` also clears `pinHash` (`lib/handlers.js:882`).
- Consequence: anyone who knows a phone number can take over that account, wallet included, **if production runs either configuration**.

### P1 — `GET /api/me/summary` returns 500 for every user — **PROVEN**
`prisma.ticket.count({ where: { userId } })` fails because `Ticket` has `buyerId`, not `userId`.

### P1 (privacy) — `GET /api/agents/nearby` exposes agents' personal data to any user — **PROVEN**
Any logged-in user receives each agent's personal `phone`, internal `userId`, `handle`, `floatBalance` (cash on hand) and exact lat/lng. That is a targeting risk for cash-holding agents.

### P2 — Hardcoded "live" emergency alerts and culture feed — **PROVEN**
- `lib/regional-alerts-service.js` seeds fixed alerts ("Canicule — Dakar & banlieue", "Sécheresse agricole — Kaolack & Fatick") with `validFrom = now` and `validUntil = now + 3 days`, labelled `source: "K21"`. They look like current, real alerts.
- The same alert appears twice (a seeding race).
- `lib/culture-feed.js` seeds fixed events ("Lions — match à venir · 17h", etc.).

### Empty-account test (Phase 4) — **PASS for personalized state**
I hit 40 GET routes as a fresh user. Wallet 0, transactions `[]`, friends, threads, tontines, orders, requests, notifications, tickets, parcels and support tickets were all empty. I saw no fabricated personal data. The only non-personal content was the hardcoded feeds above, plus fixtures the test suite had left in the shared QA DB.

## 6. Code-level findings (Evidence level 1 only — NOT executed, because testing had already stopped)
| Sev | Finding | Location |
|---|---|---|
| P0 (suspected) | **Earn-on-send mint**: every successful send credits the sender +2 ₭ (`KORI_EARN.send`), even for a 1 ₭ send. A self-send looks possible because nothing checks `recipient.id === sender.id` in `transfersSend`. If both hold, balance can be looped upward. | `lib/handlers.js:1605-1720`, `lib/kori-service.js:44` |
| P0/P1 (suspected) | **Rate limiter never runs**: `api/index.js` calls `createHandler({auth:false, skipRateLimit:true})`, and `dispatchApi` never calls `enforceRateLimit`. OTP verify has no attempt counter (it compares against the latest code; 6 digits, 10-minute window). | `api/index.js`, `lib/api-router.js:892`, `lib/handlers.js:239` |
| P1 | `complete-profile` sets `email` **and `emailVerifiedAt = now` without verification**, which allows email squatting and a false verified flag. | `lib/handlers.js:963` |
| P1 | Ledger history is deletable: `LedgerEntry` → `Wallet`/`User` use `onDelete: Cascade`, and there is no append-only protection or DB `CHECK (koriBalance >= 0)`. | `prisma/schema.prisma:189-257` |
| P2 | Two parallel histories (`LedgerEntry` and `KoriTransaction`) plus the legacy `Wallet.balance`. There is no single source of truth for derived balances. | schema |
| P2 | Auth-failure responses echo internal `debug` details (`uid:…`, JWT error names). The code comment says "gate this behind a flag once the app has real users". | `lib/api-router.js:928` |
| P2 | In mock mode, cash-out also reports "completed" (a fake success path). | `lib/julaya.js` |

What looked sound in code: wallet debits take `SELECT … FOR UPDATE` in sorted lock order and check the balance on the locked row, inside `$transaction` (`lib/wallet-atomic.js`). **I did not verify this under concurrency** (Phase 7 NOT RUN), and the repo's own load tests are broken (see §8).

## 7. Wallet classification
**DEMO-GRADE CLOSED-LOOP STORED VALUE, not safe for real value.** Balances are mutable integer columns with ledger rows written beside them. The funding paths can credit balance with no real funding (P0-1, P0-2), and the reserve counter records fake XOF. Classification: **FAIL** at the security/abuse level (9).

## 8. Phase 23 — full test suite (QA DB)
| Command | Files | Tests | Pass | Fail | Skip |
|---|---|---|---|---|---|
| `npm test` (unit + integration + security; the repo's canonical suite) | 47 (16 unit, 30 integration, 1 security) | 209 | 207 | **2** | 0 |
| `npm run test:load` (part of `test:launch-gate`) | 1 | 3 | 0 | **3** | 0 |
| `npx tsc --noEmit` | — | — | — | **exit 2**: 5 errors, all in `supabase/functions/cron-proxy/index.ts` (Deno types not excluded) | — |
| Lint | — | — | — | **NOT CONFIGURED** (no lint script or eslint config) | — |
| Build `expo export --platform web` | — | — | **exit 0** (main bundle 4 MB) | — | — |
| Playwright / E2E | — | — | — | **NOT PRESENT** in the repo | — |

- The two `npm test` failures:
  - `partner-pay-flow.test.js:151` expected channel `mbolo` but got `sms`.
  - `partner-slices-2-4.test.js:110` got a 404 `user_not_found` when creating a partner support agent.
- Load-test failures are **stale tests**. They assert the legacy `Wallet.balance`, but money now lives in `koriBalance`. As a result, the repo's concurrency and idempotency gate currently verifies nothing.
- No repo test covers the P0-1/P0-2 paths under `NODE_ENV=production` semantics.

## 9. Phase status
| Phase | Status |
|---|---|
| 0 Safety | DONE |
| 1 Architecture | PARTIAL (backend mapped; frontend screen→API wiring not traced) |
| 2 Reality map | PARTIAL (API route inventory in `lib/api-router.js:366-760`; per-screen tracing NOT RUN) |
| 3 Fake/shell hunt | PARTIAL (feeds, mock rails found; UI dead controls NOT RUN) |
| 4 Empty account | PASS (personal state) |
| 5 Roles/IDOR | NOT RUN |
| 6 Money/ledger | **FAIL — P0 proven → STOP** |
| 7–22 | **NOT RUN (halted by stop rule)** |
| 23 Test suite | DONE (results above) |

## 10. Jokko Reality Map (only what this run proved)
| Capability | Classification | Evidence level reached |
|---|---|---|
| Signup / OTP login | REAL E2E backend, **insecure OTP delivery in production-without-SMS** | 5 (authenticated E2E, API only) |
| Profile create/read | REAL (API) | 5 |
| Wallet read | REAL (DB-backed) | 5 |
| Cash-in (Julaya) | **FAKE SUCCESS / MOCK in prod without key** | 9 — FAIL |
| National deposit | **BROKEN GUARD — unfunded mint** | 9 — FAIL |
| Transaction history | REAL (reads `LedgerEntry`) | 5 |
| Me / summary | BROKEN (500) | 5 |
| Agents nearby | REAL data, **PII over-exposure** | 5 |
| Trending alerts / culture feed | HARDCODED | 5 |
| Charts, marketplace listing, businesses list | REAL DB reads (content came from test fixtures) | 4 |
| P2P, merchant pay, tontines, agents cash-in/out, commerce, delivery, rides, gigs, messaging, offline, locale | **NOT RUN** | 1 (code exists) |

## 11. Blockers
- Vercel env and deployments return 403, so the production config (Julaya key, SMS provider, `ALLOW_BETA_*`) is unknown and exposure cannot be confirmed from here.
- There is no Joko QA database. I used an ephemeral local Postgres.
- No Playwright or E2E harness exists, and I did no browser-level UI verification.

## 12. Recommended next decisions (for you; I did not act on any of them)
1. **Check production now**:
   - Is `JULAYA_API_KEY` set?
   - Is `ALLOW_BETA_OTP` true, or is SMS unconfigured?
   - Query `LedgerEntry` for `type='cash_in'` rows with references `DEP-%` or `CIN-%` whose `RailTransaction.externalId` starts with `sandbox-`, or which have no rail row at all.
2. Decide whether to freeze deposits in production before the fix work.
3. After P0-1 to P0-3 are fixed, re-run from Phase 6 onward, including real concurrency tests (the stale load tests need updating first).


---
---

# RUN 2 — J1 (P0 Financial & Account Safety) + resumed J0 audit — 2026-10-02

Starting point: report above and commit `19ac203` (clean tree). All work on the
local branch `claude/jokko-forensic-audit-rprqia`. **Nothing was pushed or
deployed, and production was not touched.** QA used disposable local Postgres databases
(`joko_qa`, `joko_j1_fresh`, `joko_audit`) inside the session container. The runtime was the real
`api/index.js` with `NODE_ENV=production`, plus a real local HTTP fake Julaya provider for
failure injection.

> **Stopped again under the stop rule.** The resumed audit found a new P0, a **tontine wallet drain**.
> It is contained fail-closed in code, but the real fix needs a product decision (member consent plus an escrowed pot).
> Phases 9 and 11–22 were **NOT TESTED** in this run.

## 1. J1 status

**J1 code gate: PASS.** All P0s from run 1, plus the P0s newly proven in this run, are fixed and covered by regression tests.

The deploy gate is not cleared:
- Production configuration and data have not been checked; see §7.
- Recommended production data checks still need running.
- The tontine decision is still open.

Evidence:
- The full launch gate on a **fresh, empty** database passed: **255/255** tests in 49 files (unit, integration, security, http, load).
- 26 of the new HTTP tests **fail on `19ac203`** and pass now.

## 2. Findings and disposition

| # | Sev | Finding | Proof before (HTTP, prod mode) | Disposition | Proof after |
|---|---|---|---|---|---|
| 1 | P0 | `deposits/national` minted ₭ whenever `source` contained "julaya" | +500 ₭, 201 | FIXED: beta-only and never in production | 403 for every source; no ledger row |
| 2 | P0 | Julaya "mock" auto-settled cash-in in production when no key was set | 0→4 000 ₭ | FIXED: production state is `unavailable` and fails closed | 503 `rail_unavailable`; no rail row |
| 3 | P0 | Partner sandbox-complete minted in production (`partnerMode` never "live") | +5 000 ₭ to settlement wallet | FIXED: production is always live | 403 |
| 4 | P0 | A pending cash-out didn't hold funds → spend, then payout (double-spend). Webhook then 500'd and the rail stuck pending | User spent 1 990 ₭ while the 20 000 XOF payout completed | FIXED: debit at initiation; refund once on explicit failure; ambiguous → review | Spend refused; refund exactly once |
| 5 | P0 | An initiation response was treated as settlement | n/a (design) | FIXED: credit only after a signed webhook or a status query with matching amount | Pending until confirmed; mismatch → review |
| 6 | P0 | Self-transfer allowed, and every send minted +2 ₭ | Self +2; 8 round-trip sends → +16 ₭ from nothing | FIXED: self-transfer refused; unfunded earn off in production | 400; system total conserved |
| 7 | P0 | OTP returned in API responses in production (no SMS provider or `ALLOW_BETA_OTP`) | `{"otp":"709468"}` | FIXED: never disclosed; 503 if undeliverable; not logged; not stored in SMS log | 503, no code |
| 8 | P0 | Unlimited OTP guesses | 60 wrong guesses, then the right one → token | FIXED: 5 attempts then burned; single use; constant-time compare | 429 on the right code after 5 misses |
| 9 | P0 | Unauthenticated `auth/recover` attached an attacker's email, then email login → account takeover | Victim's account email became `attacker@evil.test` | FIXED: only the account's own phone or verified email; nothing attached; generic response | Email untouched |
| 10 | P0 | Rate limiter never invoked | 150 req/min OK | FIXED: per-IP and per-identifier limits on auth; per-user global; tighter per-user on money routes | 429s |
| 11 | P0 | Agent monthly payout credited the XOF amount as ₭ (10×), unbacked | Code + integration test | FIXED: accrued liability; no mint | 0 ₭ minted |
| 12 | P0 | Delivery escrow debited the XOF fee as ₭ (10×) and minted a separate rider reward | Integration test | FIXED: escrow holds fee→₭ and pays exactly that; atomic accept; locked release/refund | Totals conserved |
| 13 | P0 | Partner payout burned funds with no refund on failure; could execute twice | Code | FIXED: claim-once; refund once | Settlement 10 000 → 10 000 on reject; one debit for 3 concurrent |
| 14 | P0 | App auto-retried POSTs after timeout → duplicate transfers possible; no server dedupe | Code | FIXED: one Idempotency-Key per write across retries; server replay/409/422 | Replay returns the same ref; one debit |
| 15 | **P0 NEW** | **Tontine wallet drain**: add anyone, release at once, members' wallets debited into creator | **0 → 60 000 ₭ stolen in one call** | **CONTAINED** (money movement off in production); real fix needs a decision | 503; balances unchanged |
| 16 | P1 | `complete-profile` marked a typed email as verified | `emailVerifiedAt` set | FIXED: stored unverified; login only matches verified emails | null; lookup null |
| 17 | P1 | `me/summary` returned 500 for everyone | 500 | FIXED | 200 |
| 18 | P1 (privacy) | `agents/nearby` leaked agents' phone, userId, float, exact location | Visible | FIXED: public shape, location rounded to ~100 m | Absent |
| 19 | P2 | Hardcoded "live" emergency alerts and culture items | Visible | FIXED: dev-only; old seeded rows hidden in production by fingerprint | Absent |
| 20 | P1 | Financial history removable through cascading deletes; ledger rows mutable | Schema | FIXED: ON DELETE RESTRICT; append-only triggers; CHECK balance ≥ 0 | Delete/update/negative refused |
| 21 | P1 | `auth/device/verify` mounted unauthenticated but used `req.userId` → always 403 (second devices never verifiable) | Code | FIXED: authenticated + attempt-limited | — |
| 22 | P1 | Transfer undo could reverse twice concurrently | Code | FIXED: row lock | — |
| 23 | P1 | `kori/convert` burned ₭, claimed "→ 4 900 F", delivered nothing | 1 000→500 ₭; no payout | CONTAINED: 410 `conversion_unavailable` | Balance unchanged |
| 24 | **P1 NEW** | **Transfer undo always returns 500** (`reference` param shadows the `reference()` helper) | 500 | **OPEN** (failure is safe; no money moved) | — |
| 25 | P2 | Partner create raced to the unique index → 500 | 500 under concurrency | FIXED: idempotent create | — |
| 26 | P2 | Test helper `uniquePhone()` made hex phone numbers (cause of the two pre-existing partner test failures) | 2 failures | FIXED | Pass |
| 27 | P2 | Load tests asserted the legacy `Wallet.balance` column (verified nothing) | 0/3 | FIXED to assert `koriBalance` | 3/3 |
| 28 | P2 | Tontine members added without consent | 201 | OPEN (part of decision #15) | — |

## 3. Money-mutation map (every code path that changes stored value)

Legend for "after J1":
- ✅ authoritative / conserving
- 🔒 fail-closed or contained
- ⚠️ open

| Path | Kind | Value source / authority | After J1 |
|---|---|---|---|
| `rail-service` cash-in (`POST cash/in`, Julaya webhook, pending resolver, admin release) | **CREATE** (mint) | Provider-confirmed settlement only (signed webhook / status query with amount match / audited admin action) | ✅ |
| Stripe deposit (`webhooks/stripe` → `completeCashIn`) | CREATE | Stripe-signed `checkout.session.completed` | ✅ (needs both key and secret) |
| Agent deposit confirm (`agent/deposits/:id/confirm`) | CREATE for user, DESTROY agent float | Agent's cash float (admin-funded) | ✅ code-level; **Phase 11 not tested** |
| Admin agent float top-up / approve request | CREATE (float) | Admin (TOTP) attestation of cash received | ✅ code-level; not tested |
| Partner collect (`completePartnerPayment`) | CREATE to settlement wallet | Provider-confirmed (webhook/status); sandbox only outside production | ✅ |
| `deposits/national` beta credits | CREATE | None (test credits) | 🔒 never in production |
| `auth/complete-profile` fundAmount | CREATE | — | 🔒 forced to 0 (pre-existing) |
| `creditKoriEarn` (send, merchant pay, money request) | CREATE | None (unfunded) | 🔒 off in production |
| Agent monthly payout | was CREATE (10×) | None | 🔒 accrued liability only |
| Delivery rider payout | was CREATE | Now the buyer's escrow | ✅ TRANSFER |
| Cash-out burn (`cash/out`, held approval) | DESTROY (hold at initiation) | Real payout via provider; refund on explicit failure | ✅ |
| Cash-out refund | CREATE (re-mint after burn) | Provider failure, once per reference | ✅ |
| Partner payout burn and refund | DESTROY / CREATE | Settlement wallet; provider outcome | ✅ |
| `kori/convert` | DESTROY with no destination | — | 🔒 410 |
| P2P send (`transfers/send`, held approval, money requests) | TRANSFER | Sender (token identity) | ✅ |
| Transfer undo | TRANSFER (reverse) | Original sender within 60 s | ⚠️ broken (500), safe |
| Merchant pay (wallet / voucher), affiliate split | TRANSFER | Payer | ✅ code-level; **Phase 9 not tested** |
| Marketplace order, events tickets, school fees, jekkal, payroll, cooperative, business wallet transfers, trade invoices | TRANSFER | Caller's own wallet / business owner | Code-level only; **not tested** |
| Delivery escrow hold / release / refund | HOLD / RELEASE | Buyer order; rider confirm; dispute | ✅ |
| Money-request voucher, payment funds/pots, scheduled payments | HOLD / RELEASE (balances in side tables) | Owner | Code-level only; not tested |
| **Tontine collection / payout** | TRANSFER **from non-consenting wallets** | **None** | 🔒 contained; ⚠️ needs redesign |
| Admin refund (`ADMIN_FLOAT_USER_ID` → user) | TRANSFER | Admin float wallet | Code-level only |
| KoriReserve counters | ADJUST | Every mint adds "reserve XOF" = ₭×10 regardless of real cash | ⚠️ **bookkeeping only**: see §7 |

## 4. Financial invariants now enforced

| Invariant | Enforcement |
|---|---|
| No value from nothing | Every remaining mint needs provider-confirmed settlement or an audited admin/agent attestation; unfunded mints off in production; regression-tested |
| No double-spend | `SELECT … FOR UPDATE` in sorted order, balance check on the locked row, cash-out held at initiation; DB `CHECK (koriBalance >= 0)` as a backstop |
| No negative balance | DB CHECK on Wallet, BusinessWallet, MerchantVoucher, PaymentFund, AgentProfile.float, TontineGroup.pot (NOT VALID: new writes) |
| One external settlement credits at most once | Row-locked rail settle, final states are no-ops, unique ledger references; replay and out-of-order tested |
| Retries are idempotent | Idempotency-Key on all money routes (replay / 409 / 422); the client sends one key per action |
| Pending provider ops are not spendable | Cash-in credits only on confirmation; cash-out funds held |
| Failed provider ops never credit | Tested for failed / 400 / 500 / timeout / failed-then-completed |
| Refunds traceable | `-REFUND` ledger rows, once per reference |
| Every mutation has provenance | Ledger reference per movement; ledgers append-only (DB trigger); no cascading deletes of financial rows |
| Mock/test rails never run in production | `lib/runtime-safety.js` is the single gate; no env flag re-enables in production; tested |

## 5. Test results (HEAD `be92e2b`, fresh DB)

| Command | Files | Tests | Pass | Fail | Skip |
|---|---|---|---|---|---|
| `npm run test:launch-gate` (unit + integration + security + **http** + load) | 49 | 255 | **255** | 0 | 0 |
| `npm test` (no load tests) | 48 | 252 | 252 | 0 | 0 (run before the last 3 tests were added; the launch gate above is the current full run) |
| `npx tsc --noEmit` | — | — | — | exit 2: the same 5 pre-existing errors, all in `supabase/functions/cron-proxy` (Deno) | — |
| Lint | — | — | — | NOT CONFIGURED | — |
| `expo export --platform web` | — | — | **exit 0** (4 MB main bundle) | — | — |
| Playwright / browser E2E | — | — | — | NOT PRESENT | — |

## 6. Resumed J0 audit — phases 6–23

| Phase | Status | Evidence |
|---|---|---|
| 6 Money/ledger | **FAIL → FIXED/CONTAINED** | §2 #1–6, 11–13, 23. Wallet = closed-loop stored value (mutable integer plus two parallel histories); reserve = derived bookkeeping |
| 7 Concurrency / idempotency | **PASS (tested scope)** | Concurrent overdraft (exactly 1 of 2); 5× same key; concurrent rider accept; 3× partner payout; 1 000-sender load test; 30-way overdraft race |
| 8 P2P | **PARTIAL** | PASS: self, 0/−/fraction/huge/string amounts, nonexistent recipient, unauthenticated/forged, duplicate/retry, other user's undo refused. **FAIL: undo always 500 (#24).** NOT TESTED: blocked recipient, reload/second session |
| 9 Merchant payments | NOT TESTED | — |
| 10 Tontines | **FAIL (P0)**, contained | §2 #15, #28 |
| 11 Agents | NOT TESTED (privacy fix #18 only) | — |
| 12–16 Commerce, food/delivery, rides, gigs, messaging | NOT TESTED (delivery escrow invariants tested at service level) | — |
| 17 Offline | NOT TESTED | Note: the client's automatic POST retry is now idempotency-safe |
| 18 Mobile | NOT TESTED | — |
| 19 Locale | NOT TESTED | — |
| 20 Security | PARTIAL | Auth/OTP/recovery/rate limits/IDOR on undo/agent PII tested. Remaining routes NOT TESTED |
| 21 Failure injection | **PASS (rails)** | Fake provider: pending/completed/failed/400/500/timeout, duplicate/out-of-order webhooks, amount mismatch |
| 22 Reload / second session | NOT TESTED | — |
| 23 Full verification | **PASS** (except the pre-existing Deno tsc errors) | §5 |

## 7. Unresolved risks and blockers

1. **Production exposure is unknown.** Vercel env/deployments are still 403 to this session. Before deploying, read-only checks are needed on production:
   - `RailTransaction` where `externalId LIKE 'sandbox-%'`;
   - `LedgerEntry` `cash_in` rows with references `DEP-%` / `BETA-%`;
   - `KoriTransaction` where `transactionType='earn'`;
   - `TontineMembership`/`LedgerEntry` with type `tontine_contribution`;
   - `AgentPayout` status `paid`;
   - users with an email that came from `auth/recover`;
   - partner payments completed with source `sandbox_*`.
2. **Deploying this branch changes the production DB.** `vercel-build` runs `prisma db push` and now also applies the invariant SQL. That means FK changes to RESTRICT, new columns, a new table, CHECK constraints (NOT VALID) and triggers. Nothing is dropped or rewritten, but treat it as a production schema migration. **Preview deploys of this branch would do the same against whatever `DATABASE_URL` Preview uses.** This is why nothing was pushed.
3. **Login availability.** If production has no SMS provider and relied on the OTP echo, phone signup/login now returns 503 (fail closed). Email login works if Resend is configured.
4. Users who already had an email marked "verified" through complete-profile (or attached through recover) keep that flag. This needs a data review.
5. **KoriReserve is not a reserve.** Every mint adds ₭×10 "XOF held" without reference to real bank or mobile-money balances, so reconciliation proves internal consistency, not backing. This is a J2 architectural item.
6. Two parallel ledgers (`LedgerEntry` and `KoriTransaction`) plus a legacy `Wallet.balance`. No single authoritative ledger exists (J2).
7. Business wallets, payment pots, merchant vouchers and tontine pots keep balances in their own columns, outside a unified ledger (J2).
8. Undo is broken (#24, P1). Tontine needs a consent/escrow design (#15).

## 8. Commits (local only — NOT pushed)

```
be92e2b Contain two value-destroying paths found in the resumed audit
cd15f86 J1: production-mode HTTP regression suite for every P0
fe66bb6 J1: stop exposing agents' private data and serving fake "live" alerts
612829b J1: rate limits and Idempotency-Key replay enforced in the API dispatcher
07f03d9 J1: account safety — no OTP disclosure, attempt limits, safe recovery
dde1394 J1: money paths fail closed and can no longer create value from nothing
f582a1d J1: database guards for financial records and invariants
```

## 9. J2 (Money Kernel) entry recommendation

**Do not enter J2 yet.** Clear these first:
- (a) The tontine decision.
- (b) The production read-only exposure checks in §7.1.
- (c) Push/deploy approval, with Preview DB isolation confirmed.
- (d) Phases 9 and 11–22 of the audit.

When J2 starts, its core should be:
- One append-only double-entry ledger as the single source of truth.
- Balances derived or verified from that ledger.
- Explicit system accounts (external settlement, escrow, fees, a funded incentive pool, agent float, a tontine escrow pot).
- A reserve fed only by reconciled external settlement statements.
- Migrations via `prisma migrate deploy`, not `db push`.


---
---

# RUN 3 — tontine consent/escrow, undo fix, exposure pack, resumed audit — 2026-10-02

Branch `claude/jokko-forensic-audit-rprqia` (pushed; **Vercel deployments disabled for this branch**). QA used local disposable Postgres databases only. No production access and no deploy. Every finding below was proven over real HTTP against `api/index.js` running with `NODE_ENV=production`.

> **Stopped under the stop rule.** Phase 16 proved a new **P0**: Mboolo returned other users' full account rows, including bcrypt PIN/password hashes, CNI fields, email, phone and birth date, to anyone who opened a thread with them by handle. It is **contained** (commit `397e89a`). The **decision needed**: whether to force-rotate PINs/passwords that production may already have exposed. Phases 17–22 were **NOT TESTED** in this run.

## Decisions implemented

| Decision | Delivered | Evidence |
|---|---|---|
| Tontine: explicit consent + dedicated escrow | `0897520`:<br>• invited→accepted lifecycle;<br>• self-authorized contributions into an escrow pot (append-only `TontinePotEntry`, `CHECK potBalance ≥ 0`);<br>• one contribution per member per cycle;<br>• rule-based payout only when fully funded, once per cycle, to the rotation recipient;<br>• creator cancel refunds once;<br>• the cron only sends reminders;<br>• app wired (accept / start / cotiser / verser / quitter / annuler). | `tests/http/tontine-escrow.test.js`: 19/19 adversarial tests, covering every case you listed. **Production money movement stays OFF** until `TONTINE_ESCROW_ENABLED=true` is set deliberately. |
| Production exposure (read-only) | **BLOCKED**:<br>• Vercel returns 403;<br>• only the paused Kebu Supabase project is visible;<br>• the production API can't be "read" because every request writes `ApiAuditLog`. | `scripts/forensics/production-exposure.sql` (READ ONLY + ROLLBACK, ids only, 15 sections, validated on QA). `docs/JOKKO-PRODUCTION-EXPOSURE.md`: how to run it, proposed append-only remediation (not executed). |
| Preview topology | **BLOCKED** (same 403). Preview treated as unsafe; branch deployments stay disabled. | Checklist and `migrate deploy` roadmap in `docs/JOKKO-PRODUCTION-EXPOSURE.md` |
| P2P undo | `317aa7c`: shadowed `reference()` helper — every undo returned 500. | `tests/http/p2p-undo.test.js`: 9/9 (6 fail before the fix) |

## New findings in this run

| Sev | Finding | Disposition | Commit / test |
|---|---|---|---|
| **P0** | Mboolo thread list/create returned other users' full User rows (`pinHash`, `passwordHash`, `cniNumberEnc`, `cniHash`, email, phone, date of birth). Anyone can open a direct thread with any handle. | **CONTAINED**: safe member select + global response secret scrubber. Rotation decision pending. | `397e89a`, `pii-sweep` (12 leaks before) |
| P1 | `users/lookup` by handle returned the full phone number | FIXED: masked unless the searcher typed the phone | `397e89a` |
| P1 | Reserve reconciliation counted personal wallets only → any escrow, pot, business or voucher balance froze all cash-outs | FIXED: `custodyKoriTotals` | `352e461` |
| P1 | Merchant-pay receipt injectable into any `threadId` | FIXED: both parties must be members | `06b7a22` |
| P1 | Agent cash-in ignored KYC tier caps (tier 1 → 10 000 ₭ with a 5 000 ₭ cap) | FIXED | `06b7a22` |
| P1 | Agent withdrawal didn't shrink circulation → every withdrawal froze cash-outs | FIXED | `06b7a22` |
| P1 | Agent cash-out bypassed the 24h post-recovery hold | FIXED | `06b7a22` |
| P2 | Agents saw the customer's full phone and internal id | FIXED: masked | `06b7a22` |
| P1 | b2c buyer could self-grant net30/cod → unpaid order, stock reserved | FIXED: b2c is immediate-pay only | `99c6fab` |
| P1 | b2b net terms with no trade account → unlimited unpaid credit | FIXED: agreed account + credit limit + agreed term required | `99c6fab` |
| P1 | `deliveries/:id/accept` granted the driver role to anyone (and triggered the buyer escrow debit) | FIXED: onboarded courier required | `99c6fab` |

## Phase status (J0)

| Phase | Area | Classification | Gate |
|---|---|---|---|
| 6 | Wallet/ledger | REAL (closed-loop; fragmented ledgers) | PASS after J1 (architecture → J2) |
| 7 | Concurrency/idempotency | REAL | PASS (tested scope) |
| 8 | P2P incl. undo | REAL | **PASS** |
| 9 | Merchant pay | REAL | **PASS** (after 1 P1 fix) |
| 10 | Tontines | REAL (new consent/escrow model); production money movement disabled | **PASS** (19 adversarial tests) |
| 11 | Agents | REAL | **PASS** (after 4 fixes) |
| 12 | Commerce | REAL ordering/stock/price; **cancel/refund NOT IMPLEMENTED**; b2c pays the merchant directly (no escrow) | **PARTIAL** |
| 13 | Food/delivery | REAL (restaurants are marketplace merchants; escrowed courier fee) | **PASS** (after courier-gate fix) |
| 14 | Rides | **NOT IMPLEMENTED** ("Movement" = deliveries + gigs) | N/A, roadmap |
| 15 | Gigs/work | **PARTIAL**: post + list (as `category: gig` products); no apply/accept/complete/pay lifecycle; gig rows have no action | **PARTIAL** (lifecycle NOT IMPLEMENTED) |
| 16 | Messaging/community | REAL storage, polling only (no realtime) | **FAIL → CONTAINED (P0)**; blocked users, group rules, attachments NOT TESTED |
| 17 | Offline | — | NOT TESTED |
| 18 | Mobile/low-end | — | NOT TESTED |
| 19 | Locale | — | NOT TESTED |
| 20 | Security | — | PARTIAL (auth, OTP, rate limits, IDOR on money/tontine/orders/deliveries, PII sweep of 23 endpoints) |
| 21 | Failure injection | — | PASS for payment rails; other boundaries NOT TESTED |
| 22 | Reload/second session | — | PARTIAL (restart persistence for undo and tontine) |

## Test gate (HEAD `397e89a`, QA DB)

`npm run test:launch-gate`: **298 / 298 pass**, 0 fail, 0 skipped.

## Decision needed before continuing

1. **Credential exposure response.** Production may have served PIN/password hashes to other users. Options:
   - (a) force a PIN reset (and invalidate password logins) for every user who shared a thread;
   - (b) force it for all users;
   - (c) first run §15 of the exposure pack on production, then decide.

   Recommended: **(c) then (a)**. Rotation needs a user-facing flow, so it is a product decision.
2. **Messaging consent.** Anyone can open a direct thread with any handle and message them. The leak is closed, but whether direct messages need acceptance (message requests) or blocking-by-default is a product decision.
