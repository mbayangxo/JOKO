import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { emitCommerceEvent } from '../commerce/events.js';
import { runMoneyTransaction } from '../wallet-atomic.js';
import { FULFILMENT_OWNERS, LogisticsError, SERVICE_TYPES, jokkoLogisticsEnabled } from './contract.js';
import { feeFor, holdFeeInTx } from './fees.js';
import { ownerForPoMode, poShipmentSource, returnShipmentSource } from './commerce-adapter.js';

/**
 * J8.1 — fulfilment intake. J8 CONSUMES the J5/J7 outbox: every
 * `fulfillment.requested` CommerceEvent for a purchase order becomes one
 * FulfilmentRequest (+ one Shipment), idempotent per (source, purpose). The
 * commercial order stays authoritative for the obligation; the request only
 * references it.
 */
const ref = (p) => `${p}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

export async function createRequestInTx(tx, {
  sourceSystem, sourceId, purpose = 'outbound', fulfilmentOwner, serviceType = 'local', fulfillerBusinessId, originBusinessId, originLocationId = null,
  destinationBusinessId = null, destinationUserId = null, pickupPointId = null, lines, dest = {}, createdBy, cod = false, attemptKey = null,
}) {
  const owner = FULFILMENT_OWNERS[fulfilmentOwner];
  if (!owner) throw new LogisticsError('invalid_owner', 'Mode de livraison inconnu', 400);
  if (owner.status === 'DORMANT') throw new LogisticsError('fulfilment_not_activated', `${owner.label} : pas activé`);
  if (fulfilmentOwner === 'JOKKO_LOGISTICS' && !jokkoLogisticsEnabled()) throw new LogisticsError('fulfilment_not_activated', 'Jokko Logistics n’est pas encore activé');
  const svc = SERVICE_TYPES[serviceType];
  if (!svc) throw new LogisticsError('invalid', 'Type de service inconnu', 400);
  if (svc.status !== 'ACTIVE' && fulfilmentOwner === 'JOKKO_LOGISTICS') throw new LogisticsError('service_not_available', `${svc.label} : pas encore proposé par Jokko`, 409);
  if (cod) throw new LogisticsError('cod_not_activated', 'Paiement à la livraison en espèces : pas activé (J8.12)', 409);
  const sourceKey = `${sourceSystem}:${sourceId}:${purpose}${attemptKey ? `:${attemptKey}` : ''}`;
  const prior = await tx.fulfilmentRequest.findUnique({ where: { sourceKey } });
  if (prior) return { request: prior, shipment: await tx.shipment.findFirst({ where: { requestId: prior.id }, orderBy: { createdAt: 'desc' } }), replayed: true };
  const fee = fulfilmentOwner === 'JOKKO_LOGISTICS' ? feeFor(serviceType) : { feeKori: 0, courierEarningKori: 0 };
  let request = await tx.fulfilmentRequest.create({
    data: {
      reference: ref('FR'), sourceSystem, sourceId, purpose, sourceKey, fulfilmentOwner, serviceType,
      fulfillerBusinessId: fulfilmentOwner === 'JOKKO_LOGISTICS' ? null : fulfillerBusinessId,
      originBusinessId, originLocationId, destinationBusinessId, destinationUserId, pickupPointId,
      feePayer: fee.feeKori > 0 ? 'sender' : 'none', feeKori: fee.feeKori, courierEarningKori: fee.courierEarningKori, createdBy,
    },
  });
  if (fee.feeKori > 0) request = await holdFeeInTx(tx, request, { actorUserId: createdBy });
  // Owner-fulfilled and pickup start ready (J7 already prepared the goods); Jokko Logistics waits for ops acceptance.
  const status = fulfilmentOwner === 'JOKKO_LOGISTICS' ? 'requested' : 'ready_for_pickup';
  const shipment = await tx.shipment.create({
    data: { reference: ref('SH'), requestId: request.id, status, custody: 'source', destArea: dest.area ?? null, destPrecise: dest.precise ?? null, destLat: dest.lat ?? null, destLng: dest.lng ?? null },
  });
  await tx.shipmentPackage.create({ data: { shipmentId: shipment.id, reference: `${shipment.reference}-1`, linesJson: JSON.stringify(lines ?? []) } });
  await tx.shipmentEvent.create({ data: { shipmentId: shipment.id, fromStatus: null, toStatus: status, custodyBefore: null, custodyAfter: 'source', actorType: 'system', actorId: createdBy, note: `${sourceSystem}:${sourceId}` } });
  await emitCommerceEvent(tx, { type: 'shipment.created', businessId: originBusinessId, aggregateType: 'shipment', aggregateId: shipment.id, payload: { requestId: request.id, fulfilmentOwner, serviceType } });
  return { request, shipment, replayed: false };
}

/** Consume J7 `fulfillment.requested` events for purchase orders. Safe to run any number of times. */
export async function processLogisticsOutbox(db = prisma, { limit = 200, aggregateId = null } = {}) {
  // Only TRACKED hand-offs become shipments (Jokko Logistics always; own fleet / pickup when the
  // seller opted in). Untracked seller deliveries stay seller-recorded in J7 (D34).
  const events = await db.$queryRaw`
    SELECT e.id, e."aggregateId", e."payloadJson" FROM "CommerceEvent" e
     WHERE e.type = 'fulfillment.requested' AND e."aggregateType" = 'purchase_order'
       AND e."payloadJson" LIKE '%"tracked":true%'
       AND (${aggregateId}::text IS NULL OR e."aggregateId" = ${aggregateId}::text)
       AND NOT EXISTS (SELECT 1 FROM "FulfilmentRequest" r WHERE r."sourceKey" = 'jokko_po:' || e."aggregateId" || ':outbound:' || e.id)
     ORDER BY e."createdAt" ASC LIMIT ${limit}`;
  const out = { created: 0, skipped: 0, errors: [] };
  for (const ev of events) {
    try {
      const payload = JSON.parse(ev.payloadJson ?? '{}');
      const r = await runMoneyTransaction(db, async (tx) => {
        const src = await poShipmentSource(tx, ev.aggregateId);
        const owner = await ownerForPoMode(tx, src.po, payload.mode);
        if (!owner) return null; // third party: outside Jokko, recorded by the seller only
        return createRequestInTx(tx, {
          sourceSystem: 'jokko_po', sourceId: src.po.id, attemptKey: ev.id, fulfilmentOwner: owner,
          fulfillerBusinessId: src.po.sellerBusinessId, originBusinessId: src.originBusinessId, originLocationId: src.originLocationId,
          destinationBusinessId: src.destinationBusinessId, lines: src.lines, dest: src.dest, createdBy: src.po.acceptedBy ?? src.po.submittedBy,
        });
      });
      if (r && !r.replayed) out.created += 1;
      else out.skipped += 1;
    } catch (e) {
      out.errors.push({ eventId: ev.id, code: e.code ?? 'error', message: String(e.message).slice(0, 120) });
    }
  }
  // J8.18: tracked J7 returns — collected by the seller's fleet from the buyer, back to the seller.
  const rets = await db.$queryRaw`
    SELECT e.id, e."aggregateId", COALESCE((e."payloadJson"::jsonb->>'attempt')::int, 1) AS attempt FROM "CommerceEvent" e
     WHERE e.type = 'return.collection_requested' AND e."aggregateType" = 'commercial_return'
       AND (${aggregateId}::text IS NULL OR e."aggregateId" = ${aggregateId}::text)
       AND NOT EXISTS (SELECT 1 FROM "FulfilmentRequest" r WHERE r."sourceKey" = 'j7_return:' || e."aggregateId" || ':return'
             || CASE WHEN COALESCE((e."payloadJson"::jsonb->>'attempt')::int, 1) > 1 THEN ':a' || (e."payloadJson"::jsonb->>'attempt') ELSE '' END)
     ORDER BY e."createdAt" ASC LIMIT ${limit}`;
  for (const ev of rets) {
    try {
      const r = await runMoneyTransaction(db, async (tx) => {
        const src = await returnShipmentSource(tx, ev.aggregateId);
        return createRequestInTx(tx, {
          sourceSystem: 'j7_return', sourceId: src.ret.id, purpose: 'return', attemptKey: Number(ev.attempt) > 1 ? `a${Number(ev.attempt)}` : null, fulfilmentOwner: await ownerForPoMode(tx, src.po, 'seller_delivery'),
          fulfillerBusinessId: src.ret.sellerBusinessId, originBusinessId: src.ret.buyerBusinessId, destinationBusinessId: src.ret.sellerBusinessId,
          lines: src.lines, dest: src.dest, createdBy: src.ret.requestedBy,
        });
      });
      if (r && !r.replayed) out.created += 1;
      else out.skipped += 1;
    } catch (e) {
      out.errors.push({ eventId: ev.id, code: e.code ?? 'error', message: String(e.message).slice(0, 120) });
    }
  }
  return out;
}
