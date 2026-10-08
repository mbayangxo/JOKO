-- D43 — legacy consumer delivery (DeliveryTask / DeliveryEscrow / DeliveryDispute) inventory
-- before D41 (closure of the open-claim courier marketplace) goes live.
--
-- READ ONLY (the transaction is opened READ ONLY; nothing can be written).
-- Opaque ids and aggregates only: no names, phones, addresses, notes, photos, coordinates.
-- Written against the LIVE (7d262de, pre-J2) schema: it does not rely on J2 ledger tables
-- or on columns added later (e.g. "amountKoriHeld"). Run ONLY against the correct authorized
-- project with a read-only role; never against Kebu Supabase:
--   psql "$PROD_READONLY_URL" -v ON_ERROR_STOP=1 -f scripts/forensics/legacy-delivery-inventory.sql
-- NOT RUN: no authorized production access from the audit session (see the P0 incident record).
BEGIN TRANSACTION READ ONLY;

\echo '== 1. Tasks by status (open = never accepted: nothing held) =='
SELECT t.status, COUNT(*) AS tasks, MIN(t."createdAt") AS oldest, MAX(t."createdAt") AS newest,
       COUNT(*) FILTER (WHERE t."assignedDriverId" IS NOT NULL) AS with_courier,
       COUNT(*) FILTER (WHERE t."hubId" IS NOT NULL) AS hub_last_mile
FROM "DeliveryTask" t GROUP BY 1 ORDER BY 1;

\echo '== 2. Money held in delivery escrow, by escrow status (national units / Kori) =='
SELECT e.status, COUNT(*) AS escrows, SUM(e."amountNational") AS held_national, SUM(e."koriPayout") AS kori_payout_recorded,
       MIN(e."reservedAt") AS oldest_reserved
FROM "DeliveryEscrow" e GROUP BY 1 ORDER BY 1;

\echo '== 3. Outstanding obligations: escrow still held (reserved / disputed_held) =='
SELECT t.id AS task_id, t.status AS task_status, e.status AS escrow_status, e."amountNational" AS held_national,
       e."reservedAt", t."pickedUpAt", t."deliveredAt", t."autoReleaseAt",
       (t."assignedDriverId" IS NOT NULL) AS has_courier, d.status AS dispute_status
FROM "DeliveryEscrow" e JOIN "DeliveryTask" t ON t.id = e."deliveryTaskId"
LEFT JOIN "DeliveryDispute" d ON d."deliveryTaskId" = t.id
WHERE e.status IN ('reserved', 'disputed_held')
ORDER BY e."reservedAt";

\echo '== 4. Courier assignments in flight (accepted, not completed / cancelled) =='
SELECT t.status, COUNT(*) AS tasks, COUNT(DISTINCT t."assignedDriverId") AS distinct_couriers,
       MIN(t."updatedAt") AS stalest_update
FROM "DeliveryTask" t
WHERE t."assignedDriverId" IS NOT NULL AND t.status NOT IN ('completed', 'cancelled')
GROUP BY 1 ORDER BY 1;

\echo '== 5. Disputes by status, with escrow state =='
SELECT d.status AS dispute_status, e.status AS escrow_status, COUNT(*) AS disputes, SUM(e."amountNational") AS amount_national,
       MIN(d."createdAt") AS oldest
FROM "DeliveryDispute" d LEFT JOIN "DeliveryEscrow" e ON e."deliveryTaskId" = d."deliveryTaskId"
GROUP BY 1, 2 ORDER BY 1, 2;

\echo '== 6. Delivered but never confirmed (pre-J8.0 auto-release risk: courier-only proof) =='
SELECT COUNT(*) AS delivered_unconfirmed, MIN(t."deliveredAt") AS oldest, SUM(e."amountNational") AS escrow_national
FROM "DeliveryTask" t LEFT JOIN "DeliveryEscrow" e ON e."deliveryTaskId" = t.id
WHERE t.status = 'delivered' AND t."confirmedAt" IS NULL;

\echo '== 7. Released escrows with no buyer confirmation (historical courier-only payouts; review, never auto-reverse) =='
SELECT COUNT(*) AS released_without_confirmation, SUM(e."amountNational") AS amount_national
FROM "DeliveryEscrow" e JOIN "DeliveryTask" t ON t.id = e."deliveryTaskId"
WHERE e.status = 'released' AND t."confirmedAt" IS NULL;

\echo '== 8. Migration eligibility to J8 (classification only; nothing is migrated) =='
-- open, no escrow          → ELIGIBLE_TO_CLOSE   (no money held; can be cancelled / re-requested as a J8 shipment)
-- reserved, not picked up  → FINISH_OR_REFUND    (money held; finish in legacy or refund the buyer through an operator)
-- picked_up / in_transit   → FINISH_IN_LEGACY    (goods in courier custody: never migrate mid-custody)
-- delivered, unconfirmed   → BUYER_CONFIRM_OR_REVIEW
-- disputed                 → OPERATOR_RULING     (admin/deliveries/:id/dispute/resolve; reason + audit)
-- completed / cancelled    → HISTORICAL_ONLY
SELECT CASE
         WHEN t.status = 'open' AND e.id IS NULL THEN 'ELIGIBLE_TO_CLOSE'
         WHEN e.status = 'reserved' AND t."pickedUpAt" IS NULL THEN 'FINISH_OR_REFUND'
         WHEN t.status IN ('picked_up', 'in_transit') THEN 'FINISH_IN_LEGACY'
         WHEN t.status = 'delivered' AND t."confirmedAt" IS NULL THEN 'BUYER_CONFIRM_OR_REVIEW'
         WHEN t.status = 'disputed' OR e.status = 'disputed_held' THEN 'OPERATOR_RULING'
         WHEN t.status IN ('completed', 'cancelled') THEN 'HISTORICAL_ONLY'
         ELSE 'UNCLASSIFIED_REVIEW'
       END AS classification,
       COUNT(*) AS tasks, SUM(COALESCE(e."amountNational", 0)) AS held_or_recorded_national
FROM "DeliveryTask" t LEFT JOIN "DeliveryEscrow" e ON e."deliveryTaskId" = t.id
GROUP BY 1 ORDER BY 1;

ROLLBACK;
