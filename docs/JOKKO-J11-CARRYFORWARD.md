# J11 carry-forward (before any new money flow)

## 1. Intermittent test failures: investigation

| Failure | Evidence | Root cause | Status |
|---|---|---|---|
| 4 J4 P2P journey tests (`journeys-pay` #58–60, #64), one local batch at 01:44 UTC | **Not reproduced** in 3 full batch reruns (same files and order, same long-lived DB: 159 + 158 + 159 tests) or in 2 earlier reruns, nor in either full gate. The original error text was lost: that run's output was filtered to "not ok" lines. | **Ruled out with evidence:**<br>• **Night risk rule:** 01:44 UTC is outside 02:00–04:00, and 1 200 ₭ = 12 000 XOF is under the 100 000 threshold.<br>• **Phone collisions:** 7 random digits.<br>• **IP collisions:** 2^24 range, random start.<br>• **DB faults:** no deadlock, serialization, restart or lock error in the Postgres log 01:40–01:47.<br>• **Concurrent gate load:** the J9 gate DB was last active at 01:34. | **Unresolved.** The gate logs keep full output, so a recurrence is diagnosable. |
| J3 `authz-roles` #14 "concurrent removal vs payment never pays after removal" (repro batch run 2) | Reproduced intermittently. Then **forced deterministically** (`tests/j11/authority-race.test.js`): fails on the old code ("authorized"), passes on the fix ("refused"). | **Real authorization race.** `assertBusinessAuthorityInTx` re-locked the membership with `status='active' FOR SHARE` but **ignored an empty result**. A removal committing between the read and the lock let the just-removed member's payment through. **Secondary:** the removal stamped `removedAt` *before* waiting for the row lock, so the test's timestamp check could fail even when the ordering was correct. | **Fixed:** the empty re-check refuses, and removal locks first, then stamps the time. Branch code only: `assertBusinessAuthorityInTx` is J3 and not in `7d262de`. |
| Coop insufficient-funds test (A6) | 02:04 UTC | 2–4 am Dakar large-transaction risk hold | Fixed earlier (`bc63c51`) |

**Environmental instability, also recorded:** the container's Postgres does not restart on its own after the container restarts (seen twice: crash recovery at 08:29 UTC, and down again at 15:59 UTC). One gate run was voided for this.

## 2. P-J10 classification
See `docs/JOKKO-DECISIONS.md` → "P-J10 classification".

## 3. NEW P0 found at the start of J11.0
The tontine wallet drain is **live on the production base `7d262de`**: see `docs/incidents/2026-10-p0-tontine-drain-live/`. **STOP.** J11 feature work waits for the owner.
