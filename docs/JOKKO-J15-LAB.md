# J15 torture lab: how to run it

**Local only.** The runner refuses any non-local database. Fault hooks are inert unless `JOKKO_LAB=true` **and** `JOKKO_LAB_ALLOW=local-only`, and never when `VERCEL` or `VERCEL_ENV` is set (`tests/j15/lab-l0.test.js` proves this).

## Pieces

| Piece | File | What it does |
|---|---|---|
| Fault points | `lib/lab/faults.js` | `labPoint(name)`: `crash` (SIGKILL), `throw` (infrastructure error) or `delay`, on the nth / every k-th / every hit, counted per process, every firing logged |
| Money hooks | `lib/wallet-atomic.js`, `lib/money-kernel/ledger.js` | `money.tx_start`, `money.before_commit`, `money.after_commit` around every `runMoneyTransaction`; `ledger.post` on every journal entry (covers direct `$transaction` paths too) |
| Other hooks | `lib/integrations/partner-rate-limit.js` | `ratelimit.partner` (shared limiter unavailable → sensitive operations fail closed) |
| Cluster | `scripts/lab/cluster.mjs` | N API processes + M cron processes (real `api/index.js`, `NODE_ENV=production`) on one Postgres; supervisor restarts killed workers; routing by (actor, sequence); per-route latency |
| Oracle | `scripts/lab/oracle.mjs` | money + logistics + work + collective + affiliate invariants, partner settlement reconciliation, exactly-once per client key, all on **one** repeatable-read snapshot |
| Scenario | `scripts/lab/scenarios/p2p.mjs` | send, double tap on two workers, retry-after-unknown with the same key, undo, reads, on contended accounts. Audit: what each client was told vs what the ledger booked |
| Runner | `scripts/lab/run.mjs` | baseline-diffed oracle every second, cron passes, quiesce past the idempotency lease, final oracle + audit, `manifest.json` / `records.jsonl` / `results.json`; `--replay <dir>` |
| Kernel storm | `scripts/lab/kernel-storm.mjs` | P processes × N concurrent kernel spends on ONE balance, faults live |
| Multi-instance suites | `tests/helpers/http-harness.js` | `LAB_HARNESS_WORKERS=4` runs every existing HTTP suite against 4 API processes (round-robin), with `LAB_HARNESS_FAULT_FILE` |
| P0 reproductions | `docs/incidents/lab-p0/` | P0-A / P0-B / F1 storms on `7d262de` as deployed and patched |

## Commands

```bash
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/joko_lab?sslmode=disable
node scripts/lab/run.mjs --scenario p2p --seed 2002 --ops 400 --concurrency 12 --faults scripts/lab/faults/crash-mix.json --out lab-runs/crash-2002
node scripts/lab/run.mjs --replay lab-runs/crash-2002
node scripts/lab/kernel-storm.mjs --procs 4 --per 250 --fund 200000 --seed 7 --faults scripts/lab/faults/kernel-errors.json
LAB_HARNESS_WORKERS=4 LAB_HARNESS_FAULT_FILE=$PWD/scripts/lab/faults/latency-widen.json npm test
bash docs/incidents/lab-p0/run-p0-lab.sh <legacy-worktree> <patched-worktree> <out-dir>
# L6 soak (4 h; allow ~1 h after load for quiesce + final oracle + audit), then score it against T1–T7
node scripts/lab/run.mjs --scenario mixed --seed 9005 --durationMs 14400000 --concurrency 8 --users 300 --merchants 40 --faults scripts/lab/faults/soak.json --oracleMs 15000 --cronMs 5000 --windowSec 900 --out lab-runs/soak-9005
node scripts/lab/score-soak.mjs lab-runs/soak-9005
```

Fault schedules: `scripts/lab/faults/*.json`. A failing run is reproducible from its `manifest.json`: seed, sizes, fault schedule and commit. **The content of every operation and the fault schedule replay exactly. The interleaving of concurrent operations does not**, so neither does which request a per-process fault lands on. Turn a failing run into a deterministic test, as was done for `tests/j15/stale-intent.test.js`.

## Reading a result

- `verdict` is `CLEAN` only if the oracle found nothing new (during load and at the end) **and** the outcome audit found nothing.
- `audit.stats`:
  - `completed` / `held` / `refused` are what the client saw.
  - `unknownResolvedCompleted` / `unknownResolvedNothing` are requests whose response was lost (crash, timeout), resolved by asking the server what the client would ask (`intentOutcome`).
  - `stuckInProgress` must be 0.
- `latency` is local and per route (p50 / p95 / p99 / max, status counts). **It is not production capacity.**

## L6 soak thresholds (pre-registered before the run)

**Local engineering budgets, not production SLOs.** Derived from the measured local baseline at concurrency 8 (`docs/JOKKO-J15-REPORT.md` §4). Production budgets need a staging configuration that models Vercel instances and the Supabase pooler.

**Run:** `mixed` scenario, 4 API + 2 cron processes, concurrency 8, 300 users, 4 h, `faults/soak.json` (rare crashes, no injected latency). Latency counts answered requests only, per 15-minute window. A request lost with a killed worker is counted as an error and must resolve in the outcome audit.

| # | Threshold | Budget |
|---|---|---|
| T1 | `POST transfers/send` p99, every window | ≤ 750 ms (2 × baseline 371 ms) |
| T2 | `GET money/home` p99, every window | ≤ 450 ms (2 × baseline 219 ms) |
| T3 | Other money writes (`money/charges/:code/pay`, `transfers/requests/:id/accept`, `transfers/:ref/undo`) p99, every window | ≤ 1 000 ms |
| T4 | Stability: last window p99 vs first full window p99 (send, home) | ≤ 1.5 × |
| T5 | Answered 5xx (not lost-with-worker) | ≤ 0.1 % of requests |
| T6 | Oracle findings (during load and final), outcome-audit findings, stuck keys | 0 |
| T7 | API worker memory: RSS at the end vs at 30 min (same process, no restart in between) | ≤ 2 × |

**Notes from the valid run (thresholds unchanged):** the window after the 4-hour mark only holds the in-flight tail, so T4 compares the last *full* window. T7 cannot be judged under `faults/soak.json`: the crash schedule restarts every API worker more often than every 30 minutes; judging memory needs a no-crash soak. Results: `docs/JOKKO-J15-REPORT.md` §11.

