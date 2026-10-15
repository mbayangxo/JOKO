# J15: Financial torture lab (report)

> **DRAFT** — §4 (latency), §6 (multi-instance suite run) and §7 (fresh gate) are pending. J15 is not claimed complete.

**Status:** local engineering only. **Nothing deployed.** No production action, no production migration, no live money. Kebu Supabase was never accessed. The emergency production track (P0-A, P0-B, F1) stays separate: the lab measures the patches, it does not ship them.

**Plan:** `docs/JOKKO-J15-TORTURE-LAB-PLAN.md`.
**How to run the lab:** `docs/JOKKO-J15-LAB.md`.
**Baseline:** J14 + follow-ups accepted at `d99a1d1` (gate CLEAN, 935/935).

## 1. Decisions applied (J15 brief)

| # | Decision | Result | Commit |
|---|---|---|---|
| 1 | S4 limits: 500 000 XOF / line, 5 000 000 XOF / request, 10 000 000 XOF or 20 payments / business / day, **provisional local test limits only** | Limits in XOF, converted through the ledger peg (50 000 / 500 000 / 1 000 000 ₭). Every response carries `limitsStatus: provisional_local_test_limits`. Boundary test at each limit. | `7e85150` |
| 2 | S4 in-app approval screen | List (pending first, server-clock countdown) and detail screens. The detail shows partner, kind, reference, memo, every recipient (search, re-assigned handles flagged), amounts, fees, total, balance, expiry and status. Approval needs an explicit confirmation plus a fresh PIN and echoes the `detailsHash`. Rejection needs a reason. Expired, decided and underfunded requests offer no approval. E2E 5/5. | `d72ceb0` |
| 3 | Shared atomic partner rate limits, 4 API processes, fail closed | Postgres-shared buckets per partner and per key. Test across 4 processes. Sensitive operations get 503 `rate_limit_unavailable` when enforcement is down (mutation-checked). | `4d82744` |
| 4 | L0–L5, 4 API + 2 workers, deterministic faults and replay | See §2 | `9200c75`, `1bba0e1` |
| 5 | Latency baselines before L6 thresholds | See §4. Local only, **not production capacity** | — |
| 6 | Continuous verification | Snapshot oracle every second during every lab run; outcome audit after; see §2 | `9200c75` |
| 7 | P0-A / P0-B / F1 on legacy and patched code, isolated | See §3 | `b2658e0` |
| 8 | Unexplained J4 failures | **Root cause demonstrated**; see §5 | `1530f49`, `61fff59` |
| 9 | Record every L result, commit, failures, fixes, risks; fresh full gate | This report; gate in §7 | — |

## 2. Lab phases

| Phase | What ran | Tested code | Result |
|---|---|---|---|
| **L0** harness | Fault points (`money.tx_start` / `before_commit` / `after_commit`, `ledger.post`, `ratelimit.partner`); multi-process cluster with supervisor; snapshot oracle; P2P scenario + outcome audit; replay | `9200c75` | Hooks inert in 5 env combinations under an always-crash schedule. Oracle catches **6/6 seeded defect classes** (unbalanced entry, single posting, negative balance, materialized drift, projection drift, double booking) and is clean on the baseline. |
| **L1** kernel and rails | Kernel storm: 4 processes × 250 concurrent spends on ONE balance, injected mid-posting errors | `1bba0e1` | **CLEAN.** 209 ok spending 199 999 of 200 000 (final balance 1), 715 insufficient funds, 76 injected errors rolled back, 0 unexpected. |
| **L2** P2P (J4 at storm load) | `p2p` scenario: 4 API + 2 cron processes; send, double tap on two workers, retry-after-unknown with the same key, undo | `9200c75`+ | No faults (seed 1001): CLEAN. Crash mix (seed 2002): **finding FL-1** (below), fixed; replay CLEAN. After-commit crashes (seed 3003, 40 kill -9 right after COMMIT): **CLEAN**: 91 lost responses resolved to "completed", booked exactly once; 170 resolved to "nothing moved"; 0 stuck. |
| **L2–L4** all suites multi-instance | Every HTTP suite (J3–J15) against **4 API processes**, round-robin, latency faults widening every race window | see §6 | see §6 |
| **L3** S4 / partner | S4 approvals (5 concurrent approvals, 2 approvers → 1 execution) and shared rate limits, inside the multi-instance suite run | see §6 | see §6 |
| **L4** logistics / work / collective / agents | Their suites in the multi-instance run; dispute ruling race found while extending P0-B (**FL-3**) | `dac39f4` | FL-3 fixed |
| **L5** crash / restart | Crash before COMMIT (seed 2002) and right after COMMIT (seed 3003) on the P2P family; supervisor restart; reconciliation convergence | `2bcee30` | After FL-1: every abandoned key converges within the lease (lab: 3 s; production default: 5 min); 0 manual fixes. **Coverage: the P2P family only** (see §8). |

### Findings

| # | Finding | Severity | Fix | Regression |
|---|---|---|---|---|
| FL-1 | A request killed mid-flight (instance crash, platform timeout, OOM) left its idempotency key `in_progress` **forever**. The client was told "in progress, do not retry", a retry got 409 and a void could not close it, although nothing had moved. 22 stuck keys from 8 crashes. Money was never at risk. | High (recoverability / honest outcome) | After a lease the original cannot outlive (5 min default; 30 s function limit; 15 s money transaction timeout), the key converges as a 5xx already does: money moved → completed; nothing moved → released. Runs lazily (intent read, void, retry) and in the existing pending-transactions cron. `vercel.json` unchanged. | `tests/j15/stale-intent.test.js` (5), mutation-checked ×2; lab replay CLEAN |
| FL-2 | **Systemic test order dependence:** the shared incentive pool, left funded by one test, makes 19 exact-balance tests in 7 suites fail by exactly the funded reward (+2 / +5 ₭). Root cause of the J4 failures (§5). | Medium (test integrity) | `drainIncentivePool()`: tests that fund the pool restore it through the kernel's reward flow. The torture test's expected-payout formula corrected (it assumed a pool under 240 ₭). | funded-pool probe + `reward-pool-isolation.test.js` |
| FL-3 | Concurrent delivery-dispute rulings **deadlocked** (opposite lock orders → 500). A losing customer ruling answered 200, rewrote the record (resolved_customer, delivery cancelled) after the courier had been paid, and was audited twice. Money already safe on this branch. | Medium (record integrity) | Both paths claim the dispute atomically first (one lock order); the loser changes nothing | `tests/j15/dispute-ruling-race.test.js` (15 rounds; unfixed fails 3/3) |
| FL-4 | `PressScale` silently dropped `disabled`: dimmed buttons stayed pressable and were not announced as disabled (22 busy / in-flight guards on send, undo, submit, upload). | Low (double-tap UX; server idempotency already held) | Real `disabled` + `aria-disabled` | `tests/e2e/j15-ui.mjs` |
| FL-5 | Defence in depth confirmed: a negative customer balance cannot even be written (DB CHECK `LedgerAccount_nonneg_chk`). | — | — | `lab-l0.test.js` |

## 3. P0-A, P0-B, F1 under lab concurrency (decision 7)

Same test file on two local worktrees of the production base `7d262de`, each with its own disposable database (`docs/incidents/lab-p0/`). No production access.

| Storm | `7d262de` as deployed | `7d262de` + the three emergency patches |
|---|---|---|
| **P0-A** 6 creators × 3 strangers, 4 concurrent releases each + 3 concurrent cron passes | **Reproduced.** 720 000 drained from 18 strangers into the creators. Concurrency **doubles** the drain per victim (40 000 against 20 000). | **Refuted.** 0 debited, 0 gained, every release 503. |
| **P0-B** 12 concurrent rulings by courier, buyer, strangers (`ADMIN_API_KEY` unset) | **Reproduced**, plus a **new aspect**: a rider ruling and a customer ruling both commit (unlocked status check, different references), so one 1 500 XOF escrow pays out **3 000**. | **Refuted.** All 12 refused (403), escrow stays `disputed_held`, nothing moved. |
| **F1** 3 coops × 12 concurrent payouts | **Reproduced.** Farmers paid **5×, 3× and 1×**, while every call reported failure. | **Refuted.** Exactly once per farmer; owner debit = farmer credit. |

This is evidence for the separate emergency track; it is not a deploy. P0-A runtime verification in production remains INCOMPLETE (Vercel 403), as before.

## 4. Latency baselines (decision 5)

_Pending: measured on an idle machine after the multi-instance suite run (filled in below)._

## 5. Historical J4 P2P failures (decision 8): root cause demonstrated

- **Where:** 2026-10-09 01:43, one batch on the long-lived `joko_j8p` database; `journeys-pay` #1/#2/#3/#7 failed; reruns passed.
- **Evidence (the original database still existed):**
  - In the failing run, every P2P send also booked a `reward` (+2 ₭) from the shared incentive pool. In both passing reruns, none did.
  - Money, references and recipients were otherwise identical across the three runs.
  - The pool held 16 ₭ at 01:43, left by two 60 ₭ fundings from `tests/money/torture.test.js`, which leaves `(start + 60) mod 50`.
  - That run drained it to 1 ₭, so every later run passed.
- **Mechanism:** the four failing tests are exactly the ones asserting exact payer balances after a send.
- **Reproduced deterministically at HEAD:**
  - with an empty pool, 8/8 pass;
  - with the pool funded to 15 ₭, exactly #1/#2/#3/#7 fail, each by +2.
- **Ruled out along the way, with evidence:**
  - the `recordDailySend` upsert race: Prisma 6.19 emits a native `ON CONFLICT`; 40 × 8 concurrent first-of-day calls gave 0 errors;
  - post-commit notification failures;
  - per-user velocity rules;
  - any concurrent process on that database at the time.
- **Not a money defect.** Fixes: `1530f49` (journeys-pay net of booked rewards) and `61fff59` (FL-2, systemic).
- **Side result:** under 12 concurrent PIN-confirmed retries the reward is paid exactly once.

## 6. Multi-instance suite run (L2–L4)

_Filled in when the run completes._

## 7. Fresh full gate

_Filled in at the end._

## 8. Remaining risks and gaps

1. **Lab duration.** The plan's L1–L4 gate is 10 seeds × 30 min per family. What ran is shorter: single seeds per fault schedule plus the multi-instance suites. Not yet a soak (L6), and no thresholds set.
2. **L5 coverage.** Crash/restart was exercised on the P2P family only. Other families got multi-instance latency faults, not crashes. Existing suites cannot absorb crashes, so each family needs its own lab scenario with an outcome audit.
3. **Chaos providers** (Julaya / Stripe / partner receivers with duplicate, reorder, forged and late callbacks) are not built yet. The rails are covered by the existing torture and J6 suites, not by the lab.
4. **Clock skew per worker** is not implemented.
5. **The legacy `resolveDispute` race on `7d262de`** (P0-B double payout) is closed there only because the patch refuses every caller on the user route; the function itself is still racy on that base. It must stay unreachable on `7d262de`.
6. **Replay** reproduces the operation content and the fault schedule, not the interleaving; failing runs are turned into deterministic tests (as for FL-1 and FL-3).
7. **Local measurements are not production capacity.** One machine; Postgres local; the pool sizes are not the Supabase pooler's.
