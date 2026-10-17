-- P0 (J8.0): legacy user route POST /api/deliveries/:id/dispute/resolve.
-- READ ONLY. Opaque ids only: no names, phones, addresses, notes or documents.
-- Works on the live (pre-audit, 7d262de) schema. Run with:
--   psql "$PROD_READONLY_URL" -v ON_ERROR_STOP=1 -f scripts/forensics/p0-delivery-dispute.sql
BEGIN TRANSACTION READ ONLY;

\echo '== A. Delivery disputes by status =='
SELECT status, COUNT(*) AS disputes, MIN("createdAt") AS first_opened, MAX("createdAt") AS last_opened
FROM "DeliveryDispute" GROUP BY 1 ORDER BY 1;

\echo '== B. Resolved disputes: outcome, amount, resolver attribution (ApiAuditLog) =='
-- The legacy route writes no resolver id. Attribution comes only from ApiAuditLog:
--   1. exact path match (if the platform recorded the rewritten path);
--   2. otherwise a POST 200 from any user within 10 s of resolvedAt (weak, time correlation only).
-- If neither exists, the resolver is UNKNOWN.
WITH resolved AS (
  SELECT d.id AS dispute_id, d."deliveryTaskId" AS task_id, d.status, d."resolvedAt",
         d."openedByUserId" AS opened_by, t."buyerId" AS buyer_id, t."assignedDriverId" AS courier_id,
         e.status AS escrow_status, e."amountNational" AS fee_national, e."koriPayout" AS kori_amount
  FROM "DeliveryDispute" d
  JOIN "DeliveryTask" t ON t.id = d."deliveryTaskId"
  LEFT JOIN "DeliveryEscrow" e ON e."deliveryTaskId" = t.id
  WHERE d.status IN ('resolved_rider', 'resolved_customer')
), exact AS (
  SELECT r.dispute_id, a."userId" AS resolver_id, a."createdAt" AS at, 'exact_path' AS basis
  FROM resolved r JOIN "ApiAuditLog" a
    ON a.method = 'POST' AND a."statusCode" = 200 AND a.path LIKE '%deliveries/' || r.task_id || '/dispute/resolve%'
), near AS (
  SELECT r.dispute_id, a."userId" AS resolver_id, a."createdAt" AS at, 'time_window_10s' AS basis
  FROM resolved r JOIN "ApiAuditLog" a
    ON a.method = 'POST' AND a."statusCode" = 200 AND a."createdAt" BETWEEN r."resolvedAt" - interval '10 seconds' AND r."resolvedAt" + interval '2 seconds'
  WHERE NOT EXISTS (SELECT 1 FROM exact x WHERE x.dispute_id = r.dispute_id)
), attributed AS (SELECT * FROM exact UNION ALL SELECT * FROM near)
SELECT r.dispute_id, r.task_id, r."resolvedAt", r.status AS outcome, r.escrow_status, r.fee_national, r.kori_amount,
       COALESCE(a.basis, 'none') AS attribution_basis,
       COUNT(a.resolver_id) OVER (PARTITION BY r.dispute_id) AS candidate_resolvers,
       CASE
         WHEN a.resolver_id IS NULL THEN 'UNKNOWN'
         WHEN a.resolver_id = r.courier_id THEN 'courier_of_this_delivery'
         WHEN a.resolver_id = r.buyer_id THEN 'buyer_of_this_delivery'
         ELSE 'unrelated_user'
       END AS resolver_relationship,
       CASE
         WHEN a.basis = 'time_window_10s' THEN 'REVIEW: weak time correlation only — not proof of who resolved'
         WHEN a.resolver_id = r.courier_id AND r.status = 'resolved_rider' THEN 'SUSPICIOUS: courier ruled for courier'
         WHEN a.resolver_id = r.buyer_id AND r.status = 'resolved_customer' THEN 'SUSPICIOUS: buyer ruled for buyer'
         WHEN a.resolver_id IS NOT NULL AND a.resolver_id NOT IN (r.courier_id, r.buyer_id) THEN 'SUSPICIOUS: unrelated user ruled'
         ELSE 'REVIEW: resolver not provable'
       END AS assessment
FROM resolved r LEFT JOIN attributed a ON a.dispute_id = r.dispute_id
ORDER BY r."resolvedAt";

\echo '== C. Calls to the vulnerable path (any status), if the platform recorded the path =='
SELECT a."statusCode", COUNT(*) AS calls, COUNT(DISTINCT a."userId") AS distinct_callers, MIN(a."createdAt") AS first_seen, MAX(a."createdAt") AS last_seen
FROM "ApiAuditLog" a WHERE a.method = 'POST' AND a.path LIKE '%/dispute/resolve%' GROUP BY 1 ORDER BY 1;
\echo '-- what the audit log records as the path for API calls (tells whether attribution by path is possible)'
SELECT CASE WHEN path LIKE '/api/%' THEN 'full_path' WHEN path = '/api' THEN 'rewritten_api_only' ELSE 'other' END AS path_shape, COUNT(*) AS rows
FROM "ApiAuditLog" WHERE "createdAt" > now() - interval '30 days' GROUP BY 1;

\echo '== D. Disputes still exposed to the vulnerable route (open / under_review) =='
SELECT d.id AS dispute_id, d."deliveryTaskId" AS task_id, d.status, d."createdAt", d."holdUntil", e.status AS escrow_status, e."amountNational" AS fee_national
FROM "DeliveryDispute" d LEFT JOIN "DeliveryEscrow" e ON e."deliveryTaskId" = d."deliveryTaskId"
WHERE d.status IN ('open', 'under_review') ORDER BY d."createdAt";

ROLLBACK;
