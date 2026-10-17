# Local PostgreSQL reliability (development / test only)

**Scope:** the cloud development container only. Production infrastructure is not affected or modified.

## Symptom
Postgres was repeatedly found **down** between turns, and once mid-gate (the `b306ae7` J10 run was voided). After that, every database test failed with connection errors that looked like application failures.

## Root cause (evidence, 2026-10-10)
| Hypothesis | Evidence | Verdict |
|---|---|---|
| **Container lifecycle** | `uptime` = 0 min when found down. PID 1 is `/process_api --firecracker-init`: a Firecracker micro-VM **with no init system** (no systemd), so nothing restarts services after the VM is restored. The Postgres log ends mid-operation (`checkpoint starting`) with no shutdown line, and contains **52** "database system was interrupted / not properly shut down" recoveries. | **Cause.** The VM is paused or reclaimed and restored between turns; Postgres is killed without a clean shutdown and stays down. |
| Memory / OOM killer | 16 GB RAM, 15.5 GB free, no swap pressure; no OOM lines in the kernel log or the Postgres log | ruled out |
| Disk pressure | 22 GB free on `/` (43 % used) | ruled out |
| Postgres configuration / crash | Every restart recovers cleanly; no FATAL or PANIC before the gaps | ruled out |
| Process termination by tests | The gaps align with VM boots, not with test activity | ruled out |

## Durable local fix
1. `scripts/dev/ensure-postgres.sh` (`npm run db:ensure`) starts Postgres if it is down. Crash recovery runs automatically. The script waits up to 60 s for `pg_isready` and **fails loudly** otherwise.
2. A **SessionStart hook** (`.claude/settings.json`) runs it whenever a session starts or resumes.
3. A **test preflight** in `tests/helpers/setup.js`: every test file first checks the database TCP port. A down database gives one clear `DATABASE UNAVAILABLE … run npm run db:ensure` error instead of misleading application failures.
4. **Gate** (`scripts/dev/gate.sh`): ensures Postgres at the start and records `pg_postmaster_start_time()`. After **every** step it checks that the database is up and has not restarted. Otherwise the run is marked `VOID database_down_during <step>` / `VOID database_restarted_during <step>` and stops. A voided run is never reported as a pass or as application failures.
