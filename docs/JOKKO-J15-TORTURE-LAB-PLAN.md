# J15: Financial torture lab (plan)

**Status:** plan. Local engineering only. Nothing in J15 deploys, migrates production, touches a live wallet or activates a partner. Kebu Supabase is never accessed. The production emergency track (P0-A, P0-B, F1, web slow boot) stays separate: J15 measures the code that would ship, it does not ship it.

**Baseline to attack:**
- J14 `40b95b9`;
- J14 follow-ups `8c69b10` (F4), `752cf44` (F3), `31c8761` (F2), `d99a1d1` (F1 / S4). The fresh-gate result is recorded in `docs/JOKKO-J14-FOLLOWUP-REPORT.md`.

## 1. Why a lab, and what it must prove

Every J1–J14 suite proves a property in **one process, one scenario at a time**. Production fails differently:
- many workers;
- requests killed half-way;
- providers that lie, repeat or reorder;
- clocks that drift;
- a database that is slow or briefly unavailable;
- the same human retrying on a bad network.

J15 must show that, under all of these **at once**, for every implemented money flow:

1. **Conservation:** the double-entry ledger always balances. No account goes negative unless its type allows it. Every legacy balance column equals its ledger account.
2. **Exactly-once:** every business reference moves money at most once; every confirmed provider operation is booked exactly once.
3. **No unbooked value:** money is never minted outside a funded source (faucet, provider confirmation, approved adjustment), and never destroyed outside a recorded burn.
4. **Honest outcome:** every request ends in exactly one of completed / refused / unknown-then-reconciled. An "unknown" never silently becomes "failed" while money moved, and never the reverse (the F17 rules).
5. **Authority:** no money moves without the authority the policy names. Partner and admin money paths still need their approvals under concurrency.
6. **Recoverability:** after a crash at **any** point, restart plus the reconciliation jobs converge to a state that passes 1–5, without human edits.

## 2. Money-flow inventory (what exists in code today)

Each row is an entry point into the J2 kernel (`lib/money-kernel/*`, journal kinds as written by the code). **Dormant** = behind a flag that is off by default; it is still in scope (it is code that could be turned on).

| Family | Flows (journal kinds / entry points) | Live or dormant | Current proof | Gap the lab targets |
|---|---|---|---|---|
| Kernel | `move`, append-only journal, invariants, test faucet, admin adjustments (maker/checker) | live | `tests/money/torture.test.js` (27), kernel guards | Multi-process contention, DB failover mid-commit, invariant checking *during* load (not only after) |
| Provider rails | cash-in / cash-out ExternalOperation state machine (Julaya, Stripe card session, agent), webhooks, statement import, reversal, suspense | live (sandbox / mock locally) | torture 123–265, J6 | Provider chaos: duplicate / out-of-order / late / forged callbacks while users spend; restart mid-payout; reconciliation convergence time |
| P2P | `send`, `pay_user`, money requests, undo (`merchant_pay_undo`, reversal), scheduled payments, recipient binding (J13-4, S0) | live | J4, J13, S0 | Undo vs. spend vs. scheduled run vs. account freeze at once; handle reclaim during a burst |
| Merchant acceptance | `pay_merchant`, charges / QR (`charge_payment`), vouchers, refunds, partner checkout | live | J4, J5, J7 | Charge pay vs. cancel vs. expiry vs. refund storms; business suspension mid-payment (J7.0 lock) |
| Commerce | marketplace orders (`marketplace_purchase`), order refunds, affiliate hold / reversal, Mbolo card orders (S5 + F2 30-min reservation / expiry) | live; S5 / F2 dormant | J5, J7, S5, F2 | Pay vs. expiry vs. seller cancel vs. buyer cancel at scale; stock + money joint invariant |
| B2B | trade invoices, credit memos, COD, `business_transfer`, purchase orders | live | J7 | Invoice payment vs. credit memo vs. dispute concurrency; credit-limit races |
| Business wallet | owner draw, capital in, payroll (`payroll_payment`), partner payouts (`partner_payout`, S4) | live; S4 dormant | J5, F1 | Approval races across approvers, roster mutation during approval, daily-limit races, insufficient-funds partial-batch attempts |
| Partner settlement | mapped (`business:<id>:wallet`), held (`partner:<id>:unallocated`), legacy platform wallet, D-J14-3 closure, `reconcilePartnerSettlements` | live (legacy + mapped); closure dormant | J6.0, S1, D-J14-3 | Webhook storms across link revoke / re-link / suspension; reconciliation must stay `ok` throughout |
| Logistics | shipment fee hold / release / refund, courier earnings accrue / payout / reversal, failed-attempt compensation | dormant (`JOKKO_LOGISTICS_ENABLED`) | J8 | Fee hold vs. cancel vs. delivery proof vs. dispute ruling |
| Work | escrow fund / release / refund, earnings accrue / releasable / payout / reversal, rule budgets | live | J9 | Milestone acceptance vs. dispute vs. payout vs. contest window |
| Collective | tontine contributions / payouts / refunds, collective engine, protected funds (release / refund), coop records, terminations | J11 engine dormant; legacy tontine live (P0-A) | J11 | Contribution vs. member spend vs. termination vs. payout at scale; legacy tontine drain reproduction (P0-A) in the lab |
| Agents and cash | float top-up (maker/checker), agent cash-in / out, commissions accrue / settle / clawback, deposits / withdrawals | live | J6 | Float exhaustion races, commission budget contention (the J6 shared-account race seen in F11), handoff mid-cash-out |

## 3. Remaining production risks the lab must address or measure

1. **P0-A, legacy tontine drain: still uncontained in production** (Vercel 403). The lab reproduces the drain against the legacy code and proves the containment patch closes it under concurrency. That is evidence for the separate emergency deploy; it is not the deploy.
2. **P0-B (delivery dispute) and F1 (coop double payout)** packages: reproduce and prove each fix under the same chaos, as separate packages.
3. **Unexplained historical J4 P2P failures** (logs lost). The lab runs the P2P family at 10× the previous load, with full request tracing, until they reproduce or the risk is closed with evidence.
4. **Single-node measurement only.** Nothing has run with several API processes against one database. Vercel runs many concurrent instances, so lock ordering, advisory locks and in-memory rate limits (the per-partner limiter is per-process) all need a multi-worker run.
5. **In-memory state** (partner rate-limit windows, some caches) is wrong across instances. Measure the drift and decide whether to move it to Postgres.
6. **No production observability baseline yet** (Sentry, uptime, morning checklist). The lab defines the alerts that would have caught each injected failure.
7. **Provider truthfulness:** the live Julaya round-trip has never run. The lab's fake provider must cover every documented status, plus lies (duplicates, reversals after settle, amount mismatch).
8. **Dormant features** (S1–S6, F1–F4, J8, J11): the lab runs them **enabled** in its sandbox, so their safety is measured before anyone flips a flag.
9. **Known shared-account contention:** `platform:agent_commission_budget` (F11) and other platform accounts are hot rows. Measure lock wait and timeout behaviour under load.

## 4. Lab design

**Harness (`tests/lab/` + `scripts/lab/`):**
- **N API workers** (default 4) as separate processes on one Postgres, behind a round-robin client, each with its own pool. Option: a pgbouncer-like pool cap to reproduce exhaustion.
- **Fault injector** per worker:
  - `kill -9` at named points (an instrumented hook before COMMIT, after provider call, between ledger and side effects);
  - induced DB errors (statement timeout, serialization failure, connection drop);
  - artificial latency;
  - clock offset per worker (±5 min).
- **Chaos fake providers** (Julaya, Stripe, partner receivers): configurable duplicate, reorder, delay, drop, forged-signature, amount-mismatch and late-reversal rates.
- **Actor simulator:** seeded, deterministic users, merchants, approvers, agents and partners performing realistic journeys, including human retries with the same and new idempotency keys and app restarts (F17 handoff).
- **Continuous oracle** running every second during a run:
  - J2 `checkInvariants`, plus logistics, work and collective invariants;
  - `reconcilePartnerSettlements`;
  - a balance-column ↔ ledger sweep;
  - "no request older than X without a terminal or reconciled state".

  Any violation stops the run and dumps the seed, the action log and the DB snapshot.
- **Replay:** every run is reproducible from `(seed, scenario, fault schedule)`. A failing run becomes a permanent regression test.

**Scenario matrix (each one runs as a single-flow storm and mixed with everything else):**
- **S-K kernel:** 1 000 concurrent spends on one balance; hot platform accounts; DB drop mid-commit.
- **S-R rails:** a webhook storm (10× duplicates, reordered) while the user spends; worker killed between provider confirm and booking; statement import during the storm.
- **S-P P2P:** send / undo / request / scheduled run / freeze, all on the same accounts; handle rename and reclaim mid-burst.
- **S-M merchant and commerce:** charge pay vs. cancel vs. expiry vs. refund; card-order pay vs. reservation expiry vs. both cancels; business suspended mid-payment.
- **S-B B2B and business wallet:** invoice pay vs. credit memo vs. dispute. Partner debit approvals by several approvers while the roster changes and the daily limit is hit.
- **S-S partner settlement:** collection storms across link revoke / re-link / suspension; legacy closure switched on mid-run; reconciliation stays `ok`.
- **S-W work, S-L logistics, S-C collective (incl. the P0-A legacy drain reproduction), S-A agents (float exhaustion, commission budget contention).**
- **S-X crash and restart:** every scenario re-run with random `kill -9` at instrumented points and a full restart; convergence measured.

## 5. Phases and gates

| Phase | Deliverable | Gate |
|---|---|---|
| L0 | Harness: multi-worker runner, fault hooks (no-op in production builds), chaos providers, oracle, replay | Oracle catches every seeded known defect (mutation set from J2–J14) |
| L1 | Kernel and rails storms | 0 oracle violations over 10 seeds × 30 min |
| L2 | P2P, merchant, commerce (incl. S5/F2 enabled) | Same; historical J4 P2P failure reproduced or closed with evidence |
| L3 | B2B, business wallet, S4 partner debits, partner settlement (S1–S6, D-J14-3 enabled) | Same; reconciliation `ok` continuously |
| L4 | Work, logistics (enabled), collective (J11 enabled + legacy), agents | Same; P0-A drain reproduced on legacy and refuted with the containment patch |
| L5 | Crash / restart sweep across all scenarios | Convergence ≤ the reconciliation job period; 0 manual fixes |
| L6 | Soak: mixed load, 4 workers, 4 h; latency / lock-wait report; in-memory state drift | p99 and lock-wait budgets met (to be set with the user); every failure has a named alert |
| L7 | Report: findings, fixes (each in its own commit with regression tests), residual risks, per-flow readiness verdict | Fresh full gate + lab pass on the final commit |

## 6. Rules

- Root-cause every violation. Never weaken an oracle or assertion to get a green run. A flaky lab test is a finding, never a skip.
- Fault hooks are compiled in only under `NODE_ENV=test` or `JOKKO_LAB=true`, and a test proves they are inert otherwise.
- Every fix ships as its own follow-up commit with its regression scenario, and is gated before it is claimed.
- No production access of any kind. The P0 reproductions use local copies of the legacy code paths only.

## 7. Decisions needed before L6

1. Latency and lock-wait budgets (p95/p99) per money route for the soak.
2. Whether in-memory partner rate limits must become shared (Postgres) before any partner activation.
3. Worker count and pool size that model the intended Vercel / Supabase production configuration.
