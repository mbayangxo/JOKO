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
The tontine wallet drain is **live on the production base `7d262de`**: see `docs/incidents/2026-10-p0-tontine-drain-live/`. J11 stopped there. The owner then ordered production containment (P0-A, blocked at Vercel 403, nothing deployed) and a **local** J11 resume. All new J11 money stays off in production.

## 4. Stale-authorization review (staff removal and permission revocation)
Question: after the J3 race (§1), does any other money path check a revocable permission with a read that a concurrent revocation can slip past? **The rule now applied:** the permission row is read **inside the money transaction, under a row lock** (`FOR SHARE`). A revocation that is committing either lands first and is seen, or waits until the posting commits.

| Path | Permission | Before | Now | Evidence |
|---|---|---|---|---|
| Business wallet out (to personal, to business, payroll, held-transaction execution): 9 callers | business member capability | in-tx `assertBusinessAuthorityInTx` | fixed in §1 (empty re-check refuses) | `tests/j11/authority-race.test.js` |
| Work funding (`work/money.js`), rule funding (`work/rules.js`), logistics transfers | business capability | in-tx `assertBusinessAuthorityInTx` | covered by the same fix | J9/J8 suites |
| Logistics fee hold from the J7 outbox (`intake.js`) | none at execution | the debit executes a PO the seller **already accepted** with Jokko Logistics (a business commitment, not a staff session) | **by design**, recorded: removing the accepting staff member does not cancel the business's accepted order; cancelling the PO does | — |
| **Courier steps and assignment** (`asCourier`, `assignCourier`, `emergencyReassign`) | Jokko `driver` role | **plain read** inside the tx: a suspension committing at that moment was invisible | `courierRoleActiveInTx`: `FOR SHARE` | `tests/j11/courier-role-race.test.js`: old code fails (stale `true`), fixed passes |
| **Cash agent bind, customer commit, agent completion** (`agents/cash.js`) | agent profile status | **plain read** inside the tx (and `requireOperatingAgent` before the tx) | `agentActiveInTx`: `FOR SHARE` inside the money tx; the pre-tx check stays as a fast refusal | `tests/j11/agent-suspension-race.test.js`: old code fails, fixed passes |
| Courier earnings payout | none (the courier's own earned money) | — | unchanged on purpose: a suspended courier is still owed earned money; open disputes freeze it | — |

**Severity:** the window is milliseconds and the actor was authorized moments earlier, so these are **P2 hardening fixes, not P0s**. No money is created or lost: each posting stays a balanced J2 move.

**Production (`7d262de`):** not affected by these races, for a different reason. That code has **no member status and no removal or revocation path at all** (`requireBusinessAdmin` / `requireBusinessMember` check membership outside any transaction, and nothing removes a member). Staff revocation is therefore impossible in production, which is the J3 finding that the branch fixes. **Nothing here is deployed**, and none of these branch fixes is to be shipped to production on its own.

**Verification:** J6 + J8 + J11 suites serially: **123 / 123**. These fixes go into the next full local gate together with the J3 fix.
