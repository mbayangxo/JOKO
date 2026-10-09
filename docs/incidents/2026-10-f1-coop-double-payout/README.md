# Incident F1: cooperative double payout (OPEN in production)

**Status:** **OPEN in production.** A hotfix package is ready and verified **locally only**. It is not deployed. The local fix in the J9 branch is **not** evidence that production is protected.

**Severity:** P1 financial incident. No money is created (each payment debits the payer's wallet), but a cooperative can pay the same farmer several times for the same deliveries.

**Owner action:** authorize a production deploy through verified access only. This package is **separate** from the delivery-dispute P0 patch and from all J9 work.

## 1. Affected route
`POST /api/businesses/:id/cooperative/payout` → `cooperativePayoutHandler` (`lib/org-handlers.js`) → `payoutFarmerDeliveries` (`lib/cooperative-service.js`) → `payEmployee` → `executePayrollTransfer` (`lib/payroll-service.js`).

On the production base `7d262de`, the payment is debited from the **business owner's personal wallet** (`transferNational`).

## 2. Root cause
1. `payoutFarmerDeliveries` reads the `verified` logs, pays through payroll, then marks the logs `paid` **in a separate statement after the money transaction**. Concurrent requests (a double tap, a client retry, two admins) all read the same logs and each pay. **Reproduced on `7d262de`: 4 parallel requests → 4 transfers.**
2. `FarmerDeliveryLog.payoutReference` is `@unique`, but all logs of one payout were given the **same** reference. Paying two or more logs together throws **after** the money has moved, so the logs stay `verified` and are payable again. **Reproduced on `7d262de`.**

## 3. Minimal patch
File: `f1-hotfix-on-7d262de.patch`. 2 files, +47 / −20, applied on `7d262de`. No other change.

- **`lib/payroll-service.js`:** `executePayrollTransfer` / `payEmployee` accept an optional `inTx(db, ref)` callback, run **inside** the existing money transaction after the transfer. No behaviour change for other callers.
- **`lib/cooperative-service.js`:**
  1. **Claim** the logs first, with a conditional per-log `UPDATE … WHERE status='verified' AND payoutReference IS NULL` → `payout_pending`. A request that cannot claim every log pays nothing.
  2. Mark the logs `paid` with a **per-log reference** `<ref>:<logId>` inside the money transaction.
  3. **Release** the claim if the transfer fails.
  4. A risk-**held** payment keeps the claim (`payout_held`), so it can never be paid twice.

Observed but **not** changed in this patch (separate, lower risk): on `7d262de` the `PayrollRun` row is also written outside the money transaction. The J5 code fixes that; it ships with the normal release.

## 4. Migration requirements
**None.** `payout_pending` and `payout_held` are new values of an unconstrained `String` column. There is no schema change and no data migration. Existing `paid` rows keep their single-reference format; the queries below handle both formats.

## 5. Evidence (local, production-shaped)

| Check | Result |
|---|---|
| `f1-coop-payout.test.js` on **unpatched `7d262de`** | **fails 2/3**: 4× payment; the multi-log payout fails after paying |
| The same test on **patched `7d262de`** | **3/3**: paid exactly once under 4 concurrent requests; owner debited once (conservation); one `PayrollRun`; two logs paid together once; an insufficient-funds failure pays nothing and leaves the logs payable |
| `7d262de` full suite with the patch (`npm test`) | **125 / 125** |
| Historical queries on the production-shaped test database | run read-only; they detect the 4 duplicate runs created by the unpatched reproduction |

## 6. Deploy plan (only with verified access and explicit authorization)
1. **Base:** branch from **`7d262de`** (never `19ac203`; see the P0 incident §8). Apply `f1-hotfix-on-7d262de.patch` and add `f1-coop-payout.test.js` under `tests/integration/`.
2. **Order:** after the P0 patch is deployed and verified, as its own deploy. Never bundled with J9 or other product changes.
3. **Before deploying:** run the historical queries read-only (§8) and record the baseline counts.
4. **Deploy:** preview first, then production, through the verified team and project. **No environment-variable change.**

## 7. Post-deploy verification
1. Run `historical-duplicates.sql` again. The counts must not increase after the deploy timestamp.
2. On a test cooperative in **preview**: two simultaneous payout taps produce one `PayrollRun` and one ledger debit.
3. Watch logs and Sentry for `Payout already in progress or done` (expected on double taps) and for any 5xx on the route.

## 8. Historical exposure (read-only)
File: `historical-duplicates.sql`. It runs inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`, and outputs opaque ids, counts and sums only.

| Query | Finds |
|---|---|
| Orphan farmer payroll runs | payments no log points to |
| 10-minute bursts | concurrent duplicates |
| Suspect run list | one row per suspect run, for case review |
| Verified logs with a later farmer payout | multi-log failure leftovers |
| Totals | context |

**Remediation of any duplicate found is a finance decision.** Never debit a farmer automatically. Recovery (if any) is a reviewed, consented, auditable adjustment.

## 9. Rollback / forward-fix
- **Rollback:** redeploy `7d262de` (the bug returns but no data is harmed). Logs left in `payout_pending` by an interrupted request are safe: they are not payable. Return them to `verified` after review with a single targeted, audited update.
- **Forward-fix:** preferred. Any defect in the claim logic fails closed: nothing is paid, and the logs stay claimed or verified.
