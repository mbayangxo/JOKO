import { prisma } from '../prisma.js';

/**
 * J8 physical / custody invariants (read-only). The money side (fee escrow,
 * courier earnings) is I20 / I21 in lib/money-kernel/invariants.js; these are the
 * goods side. Each check returns offending ids only — never addresses or contacts.
 *
 *   L1  status ⇒ custody (also a DB trigger) and a courier custodian only while the courier holds it
 *   L2  ≤ 1 active courier assignment per shipment, and only while a courier is involved
 *   L3  delivered ⇔ exactly one `delivered` event, a recognised proof and a delivery time
 *   L4  ≤ 1 receiving record per shipment, only on delivered shipments, every dispatched unit accounted for
 *   L5  stock credited from receiving == units received (once), per shipment — buyer side: own-product
 *       StockMovement(receive_purchase) + pending UnmatchedReceipt; depot side: DepotStockMovement
 *   L6  fee settlement consistent: released ⇒ one earning ≤ the snapshotted courier share; refunded / held ⇒ none
 *   L7  transfer conservation: out − cancel-back − return-back == in + damaged + missing + refused + in transit
 *   L8  the courier is never the receiving person / a member of the receiving business (transfers excepted)
 *   L9  (D44) return stock holds: exactly one quarantine movement (−sellable) per stocked hold, and one
 *       release movement (+sellable) iff the hold was released — no double deduction, no double restock
 */
const PROOFS = ['receiver_challenge', 'receiver_receiving', 'pickup_point_release', 'operator_ruling'];

export async function checkLogisticsInvariants(db = prisma) {
  const v = [];
  const add = (id, rows) => { if (rows.length) v.push({ id, count: rows.length, sample: rows.slice(0, 5).map((r) => r.id ?? r.shipmentId ?? r) }); };
  add('L1', await db.$queryRaw`SELECT id FROM "Shipment" WHERE (custody = 'courier') <> ("custodianUserId" IS NOT NULL)`);
  add('L2', await db.$queryRaw`SELECT a."shipmentId" AS id FROM "CourierAssignment" a JOIN "Shipment" s ON s.id = a."shipmentId"
                                 WHERE a.status = 'active' AND s.status NOT IN ('assigned','pickup_arrived','picked_up','in_transit','delivery_arrived','delivery_failed','delivery_exception','return_requested','return_in_transit')`);
  add('L3', await db.$queryRaw`SELECT s.id FROM "Shipment" s
                                 WHERE (s.status = 'delivered') <> ((SELECT COUNT(*) FROM "ShipmentEvent" e WHERE e."shipmentId" = s.id AND e."toStatus" = 'delivered') = 1)
                                    OR (s.status = 'delivered' AND (s."deliveredAt" IS NULL OR s."deliveryProof" IS NULL OR NOT (s."deliveryProof" = ANY(${PROOFS}))))`);
  const recs = await db.receivingRecord.findMany({ select: { shipmentId: true, linesJson: true } });
  const ships = new Map((await db.shipment.findMany({ where: { id: { in: recs.map((r) => r.shipmentId) } }, select: { id: true, status: true, reference: true } })).map((s) => [s.id, s]));
  const pkgs = await db.shipmentPackage.findMany({ where: { shipmentId: { in: recs.map((r) => r.shipmentId) } }, select: { shipmentId: true, linesJson: true } });
  const l4 = [];
  for (const r of recs) {
    const s = ships.get(r.shipmentId);
    const expected = new Map();
    for (const p of pkgs.filter((x) => x.shipmentId === r.shipmentId)) for (const l of JSON.parse(p.linesJson)) expected.set(l.productId, (expected.get(l.productId) ?? 0) + l.units);
    const lines = JSON.parse(r.linesJson);
    const bad = s?.status !== 'delivered' || lines.length !== expected.size || lines.some((l) => l.received + l.damaged + l.missing + l.refused !== expected.get(l.productId));
    if (bad) l4.push({ id: r.shipmentId });
  }
  add('L4', l4);
  // Depot-side receipts (transfer_in / return_restock / refusal_return) reconcile against DepotStockMovement;
  // buyer receipts (jokko_po) against the buyer's StockMovement(receive_purchase) + still-pending UnmatchedReceipt.
  add('L5', await db.$queryRaw`
    SELECT s.id FROM "ReceivingRecord" r JOIN "Shipment" s ON s.id = r."shipmentId"
     JOIN "FulfilmentRequest" q ON q.id = s."requestId"
     WHERE q."sourceSystem" IN ('jokko_po','stock_transfer','j7_return','refusal')
       AND NOT (q."sourceSystem" = 'j7_return' AND EXISTS (SELECT 1 FROM "CommercialReturn" cr JOIN "PurchaseOrder" p ON p.id = cr."purchaseOrderId" WHERE cr.id = q."sourceId" AND p."depotLocationId" IS NULL))
       AND NOT (q."sourceSystem" = 'refusal' AND EXISTS (SELECT 1 FROM "Shipment" o JOIN "FulfilmentRequest" oq ON oq.id = o."requestId" WHERE o.id = q."sourceId" AND oq."originLocationId" IS NULL))
       AND (SELECT COALESCE(SUM((l->>'received')::int), 0) FROM jsonb_array_elements(r."linesJson"::jsonb) l)
        <> CASE WHEN q."sourceSystem" = 'jokko_po' THEN
             (SELECT COALESCE(SUM(m.delta), 0) FROM "StockMovement" m WHERE m.reason = 'receive_purchase' AND m.note = s.reference)
             + (SELECT COALESCE(SUM(u.units), 0) FROM "UnmatchedReceipt" u WHERE u."shipmentId" = s.id AND u.status = 'pending')
           ELSE (SELECT COALESCE(SUM(m."deltaOnHand"), 0) FROM "DepotStockMovement" m
             WHERE m.reason IN ('transfer_in','return_restock','refusal_return') AND (m.note = s.reference OR m.note LIKE '% / ' || s.reference)) END`);
  add('L6', await db.$queryRaw`
    SELECT q.id FROM "FulfilmentRequest" q LEFT JOIN "Shipment" s ON s."requestId" = q.id LEFT JOIN "CourierEarning" e ON e."shipmentId" = s.id
     WHERE (q."feeStatus" = 'released' AND q."courierEarningKori" > 0 AND (e.id IS NULL OR e."amountKori" > q."courierEarningKori"))
        OR (q."feeStatus" IN ('held','refunded','none') AND e.id IS NOT NULL)`);
  const transfers = await db.stockTransfer.findMany({ where: { status: { in: ['received', 'returned', 'cancelled'] } }, select: { id: true, reference: true, linesJson: true, status: true } });
  const l7 = [];
  for (const t of transfers) {
    const moves = await db.depotStockMovement.findMany({ where: { note: { startsWith: t.reference } }, select: { reason: true, deltaOnHand: true } });
    const sum = (r) => moves.filter((m) => m.reason === r).reduce((a, m) => a + m.deltaOnHand, 0);
    const out = -sum('transfer_out');
    const back = sum('transfer_cancel') + sum('shipment_return');
    let accounted = sum('transfer_in');
    if (t.status === 'received') {
      const req = await db.fulfilmentRequest.findFirst({ where: { sourceSystem: 'stock_transfer', sourceId: t.id } });
      const sh = await db.shipment.findFirst({ where: { requestId: req.id } });
      const rec = await db.receivingRecord.findUnique({ where: { shipmentId: sh.id } });
      for (const l of JSON.parse(rec.linesJson)) accounted += l.damaged + l.missing + l.refused;
    }
    if (out !== back + accounted) l7.push({ id: t.id });
  }
  add('L7', l7);
  add('L8', await db.$queryRaw`
    SELECT s.id FROM "Shipment" s JOIN "FulfilmentRequest" q ON q.id = s."requestId" JOIN "CourierAssignment" a ON a."shipmentId" = s.id
     LEFT JOIN "ReceivingRecord" r ON r."shipmentId" = s.id
     WHERE r."receiverUserId" = a."courierUserId"
        OR (q."destinationBusinessId" IS DISTINCT FROM q."fulfillerBusinessId" AND (q."destinationUserId" = a."courierUserId"
            OR EXISTS (SELECT 1 FROM "Business" b WHERE b.id = q."destinationBusinessId" AND b."ownerId" = a."courierUserId")))`);
  add('L9', await db.$queryRaw`
    SELECT h.id FROM "ReturnStockHold" h
     LEFT JOIN LATERAL (SELECT COUNT(*) FILTER (WHERE m.reason = 'return_quarantine') AS qn, COALESCE(SUM(m.delta) FILTER (WHERE m.reason = 'return_quarantine'), 0) AS qd,
                               COUNT(*) FILTER (WHERE m.reason = 'return_release') AS rn, COALESCE(SUM(m.delta) FILTER (WHERE m.reason = 'return_release'), 0) AS rd
                          FROM "StockMovement" m WHERE m.note = 'hold:' || h.id) x ON true
     WHERE CASE WHEN h."buyerProductId" IS NOT NULL AND h."sellableUnits" > 0
                THEN NOT (x.qn = 1 AND x.qd = -h."sellableUnits" AND ((h.state = 'released' AND x.rn = 1 AND x.rd = h."sellableUnits") OR (h.state <> 'released' AND x.rn = 0)))
                ELSE x.qn + x.rn > 0 END`);
  return { ok: v.length === 0, violations: v };
}

export async function assertLogisticsInvariants(db = prisma) {
  const r = await checkLogisticsInvariants(db);
  if (!r.ok) throw new Error(`logistics invariants violated: ${JSON.stringify(r.violations)}`);
  return r;
}
