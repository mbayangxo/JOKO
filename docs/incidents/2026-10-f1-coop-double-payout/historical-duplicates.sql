-- F1 — historical duplicate cooperative payouts. READ-ONLY. Production schema as of 7d262de.
-- Run only with separately verified, authorized production database access. Outputs opaque ids,
-- counts and sums — no names, phones or handles. Never modifies anything.
BEGIN TRANSACTION READ ONLY;

-- 1. Farmer payroll runs that no delivery log points to. With the bug, a concurrent duplicate payout
--    (or a multi-log payout whose log update failed) leaves a run without a matching log reference.
SELECT 'orphan_farmer_payroll_runs' AS check, COUNT(*) AS runs, COALESCE(SUM(r.amount), 0) AS amount_national
  FROM "PayrollRun" r JOIN "PayrollEmployee" e ON e.id = r."employeeId"
 WHERE e."jobTitle" = 'farmer'
   AND NOT EXISTS (SELECT 1 FROM "FarmerDeliveryLog" l WHERE l."payoutReference" = r.reference OR l."payoutReference" LIKE r.reference || ':%'); -- pre- and post-hotfix reference formats

-- 2. Bursts: ≥ 2 farmer runs for the same business + farmer + amount within 10 minutes (concurrent duplicates).
WITH runs AS (
  SELECT r.id, r."businessId", r."employeeId", r.amount, r."createdAt",
         LAG(r."createdAt") OVER (PARTITION BY r."businessId", r."employeeId", r.amount ORDER BY r."createdAt") AS prev_at
    FROM "PayrollRun" r JOIN "PayrollEmployee" e ON e.id = r."employeeId" WHERE e."jobTitle" = 'farmer')
SELECT 'burst_duplicates' AS check, COUNT(*) AS suspect_runs, COALESCE(SUM(amount), 0) AS suspect_amount_national,
       COUNT(DISTINCT "businessId") AS businesses
  FROM runs WHERE prev_at IS NOT NULL AND "createdAt" - prev_at < interval '10 minutes';

-- 3. Suspect runs, one row each (opaque ids only) for case review.
WITH runs AS (
  SELECT r.id, r."businessId", r."employeeId", r.amount, r."createdAt", r.reference,
         LAG(r."createdAt") OVER (PARTITION BY r."businessId", r."employeeId", r.amount ORDER BY r."createdAt") AS prev_at
    FROM "PayrollRun" r JOIN "PayrollEmployee" e ON e.id = r."employeeId" WHERE e."jobTitle" = 'farmer')
SELECT id AS payroll_run_id, "businessId" AS business_id, "employeeId" AS payroll_employee_id, amount, "createdAt",
       EXISTS (SELECT 1 FROM "FarmerDeliveryLog" l WHERE l."payoutReference" = runs.reference OR l."payoutReference" LIKE runs.reference || ':%') AS referenced_by_a_log
  FROM runs WHERE prev_at IS NOT NULL AND "createdAt" - prev_at < interval '10 minutes'
 ORDER BY "createdAt";

-- 4. Logs left payable after a payout (multi-log failure): verified logs whose farmer received a farmer
--    payroll run after the log was verified.
SELECT 'verified_logs_with_later_farmer_payout' AS check, COUNT(DISTINCT l.id) AS logs, COALESCE(SUM(l."quantityTons"), 0) AS tons
  FROM "FarmerDeliveryLog" l
  JOIN "PayrollEmployee" e ON e."businessId" = l."businessId" AND e."userId" = l."farmerUserId" AND e."jobTitle" = 'farmer'
  JOIN "PayrollRun" r ON r."employeeId" = e.id AND r."createdAt" > l."verifiedAt"
 WHERE l.status = 'verified' AND l."payoutReference" IS NULL;

-- 5. Totals for context.
SELECT 'farmer_payroll_totals' AS check, COUNT(*) AS runs, COALESCE(SUM(r.amount), 0) AS amount_national,
       (SELECT COUNT(*) FROM "FarmerDeliveryLog" WHERE status = 'paid') AS paid_logs
  FROM "PayrollRun" r JOIN "PayrollEmployee" e ON e.id = r."employeeId" WHERE e."jobTitle" = 'farmer';

ROLLBACK;
