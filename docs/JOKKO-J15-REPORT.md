# J15: Financial torture lab (report)

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
| OI-1 | Unexplained: one `money/home` failure after a recovery login in the multi-instance run (§6). Not reproduced in 11 runs. | Unknown | Diagnostic assertion keeps the evidence (`83aa302`) | — |
| FL-6 | Latent since J6: the J6 destruction test scanned 16 cash codes at once. A cash-out scan overtaking a cash-in hold is correctly refused `agent_capacity`, which crashed the test (first gate attempt). | Low (test integrity; product correct) | Scan cash-ins, then cash-outs; assert all 16 scans succeed | Proven by forcing cash-outs first (5/8 refused, same crash); file 7/7 ×3 |
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

**Setup:** measured on an idle machine.
- 4 API + 2 cron processes; one local Postgres.
- `p2p` scenario with no faults: 600 operations, 120 users. Seeds 5004 / 5008 / 5016 / 5032.
- Latencies in ms, as seen by the client.

**These are local measurements of this one machine. They do not represent production capacity and must not be used as production SLOs.**

| Concurrency | Ops/s | `POST transfers/send` p50 / p95 / p99 / max | `GET money/home` p50 / p95 / p99 | `POST transfers/:ref/undo` p50 / p95 | Oracle snapshot max | Verdict |
|---|---|---|---|---|---|---|
| 4 | 37 | 110 / 175 / 258 / 300 | 47 / 94 / 168 | 87 / 113 | 443 | CLEAN |
| 8 | 45 | 182 / 310 / 371 / 495 | 89 / 141 / 219 | 125 / 233 | 485 | CLEAN |
| 16 | 47 | 330 / 636 / 800 / 851 | 156 / 289 / 398 | 274 / 443 | 503 | CLEAN |
| 32 | 51 | 653 / 1 078 / 1 374 / 1 526 | 273 / 474 / 647 | 456 / 655 | 636 | CLEAN |

**Kernel hot row:** 4 processes × 250 concurrent spends on ONE balance, no faults (seed 8). p50 2 455, p95 3 484, p99 3 554 ms. CLEAN.

**Reading:**
- Throughput saturates near 45–50 ops/s from concurrency 8. Beyond that, latency grows about linearly with concurrency: the requests queue on this machine's CPU and connection pools.
- A single hot balance serializes by design (row lock). Its latency is the queue length × the per-transaction time.
- No request was lost and no outcome was unknown at any level.

**Proposal for the L6 soak thresholds** (to be confirmed by you; not adopted):
- Measure on a staging configuration that models production (Vercel instance count, Supabase pooler size) before fixing numbers.
- Until then, a local regression budget: `transfers/send` p99 at concurrency 8 ≤ 2 × this baseline (≈ 750 ms).
- Zero unknown-unresolved outcomes after quiesce.

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

**What ran:** the whole `npm test` (953 tests, J1–J15) with `LAB_HARNESS_WORKERS=4`.
- Every HTTP suite talked to **4 API processes** round-robin on one database.
- The lab hooks were live with `latency-widen.json`: slow commits, slow postings and slow rate-limit checks. **735 faults fired.**
- The database was a copy of the gate database.
- The run started at `1bba0e1`. Server code is loaded per test file, so files that ran after `dac39f4` saw the dispute fix. The fresh gate in §7 is the authoritative single-commit check.

**Result: 951 / 953 pass.** Every S4 approval race, partner key, settlement, logistics, work, collective, agent, commerce, P2P, undo, idempotency, F17 and torture test held with requests spread across 4 instances and widened race windows.

| Failure | Cause | Outcome |
|---|---|---|
| #488 shared rate limit fail-closed | **Harness defect:** lab mode overwrote the test's own fault schedule, so "enforcement unavailable" was never injected | Fixed (overrides win, `3866e84`); test 4/4 in both modes |
| #553 cash-out blocked (recovery case) | **Open item OI-1, unexplained.** `money/home` after a recovery login answered without `actions`. The recovery session was authenticated (`lastUsedAt` +60 ms), so the handler answered non-200 or another shape; the body was not captured. 11 further lab-mode runs of the file: 0 failures. | Not dismissed. The assertion now reports status and body if it recurs. |

**In-memory state drift (plan risk 5):** no module-level cache remains in `lib/` (besides the lab's own fault-file cache), and partner rate limits are shared (D3). No test failed because of instance-local state.

## 7. Fresh full gate

**First attempt at `8d52aa8`: NOT CLEAN.**
- 953/954; every other check 0.
- J6 destruction test: a cash-out scan was correctly refused `agent_capacity` because the test scanned all 16 codes at once (FL-6).
- Root-caused from the gate database and proven by forcing the order. Fixed in `1d00e03` (test only).

**Fresh full gate at `1d00e03`: CLEAN.** Postgres was up for the whole run (started 06:13, no restart), so the run is valid.

| Check | Result |
|---|---|
| Full suite (`npm test`, J1–J15) | **954 / 954** |
| Money / logistics / work / collective invariants, after the suite and after everything | 0 |
| Load, sweeps | 0 |
| Web build | 0 |
| Browser E2E J8–J15 (J15 = S4 approval screen) | 0 (7, 8, 9, 12, 3, 5, 12, 11 steps) |
| Weak-network lab (J12), migration rehearsal | 0 |
| `schema_diff` | empty |
| `audit_critical` | 0 |
| Crons | unchanged (`daily`, `scheduled-payments`); `deploy_inert yes` |
| Client matches schema | at start and end |

Later commits only touch this report.

## 8. Remaining risks and gaps

1. **Lab duration.** The plan's L1–L4 gate is 10 seeds × 30 min per family. What ran is shorter: single seeds per fault schedule plus the multi-instance suites. Not yet a soak (L6), and no thresholds set.
2. **L5 coverage.** Crash/restart was exercised on the P2P family only. Other families got multi-instance latency faults, not crashes. Existing suites cannot absorb crashes, so each family needs its own lab scenario with an outcome audit.
3. **Chaos providers** (Julaya / Stripe / partner receivers with duplicate, reorder, forged and late callbacks) are not built yet. The rails are covered by the existing torture and J6 suites, not by the lab.
4. **Clock skew per worker** is not implemented.
5. **The legacy `resolveDispute` race on `7d262de`** (P0-B double payout) is closed there only because the patch refuses every caller on the user route; the function itself is still racy on that base. It must stay unreachable on `7d262de`.
6. **Replay** reproduces the operation content and the fault schedule, not the interleaving; failing runs are turned into deterministic tests (as for FL-1 and FL-3).
7. **Local measurements are not production capacity.** One machine; Postgres local; the pool sizes are not the Supabase pooler's.
