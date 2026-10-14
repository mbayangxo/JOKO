/**
 * J14-S2 — partner (Kabu) fulfilment requests → Jokko Logistics (J8). DORMANT unless
 * PARTNER_FULFILLMENT_ENABLED=true.
 *
 * A partner asks Jokko to move goods for ITS order of one of ITS linked businesses. The order stays in the
 * partner's system (referenced by id, never copied). Lines name products by the partner's ids, resolved
 * through S3 product links of THAT business (an unmapped line refuses the whole request).
 *
 * No money moves (D-J14-1, option A): only the zero-fee modes are accepted — the merchant's own fleet and
 * customer pickup. JOKKO_LOGISTICS holds a delivery fee FROM the business wallet, which a partner may not
 * trigger without an explicit in-Jokko approval; that mode is refused here.
 *
 * Idempotent per (partner, external business, external order, purpose) through J8's sourceKey. Status and
 * proof come back to the partner through S1 (`shipment.*` events), for shipments this partner created only
 * (an ExternalLink objectType=shipment marks them). Destination details are used by J8 (and redacted on its
 * retention schedule); they are never echoed back.
 */
import { prisma } from '../prisma.js';
import { runMoneyTransaction } from '../wallet-atomic.js';
import { createRequestInTx } from '../logistics/intake.js';
import { resolveExternalProduct } from './product-links.js';

export const partnerFulfillmentEnabled = () => process.env.PARTNER_FULFILLMENT_ENABLED === 'true';

export class PartnerFulfillmentError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const MODES = { merchant_fleet: 'MERCHANT_FULFILLED', customer_pickup: 'CUSTOMER_PICKUP' };
/** No ':' — the J8 source id joins business and order with it. */
const ID_RE = /^[A-Za-z0-9._-]{1,120}$/;
const LINE_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const sourceSystemFor = (partnerId) => (partnerId === 'kebu' ? 'kabu' : `partner_${partnerId}`);
const MAX_LINES = 100;

function shape(request, shipment, extOrder) {
  return {
    reference: request.reference,
    external_order_id: extOrder,
    mode: Object.keys(MODES).find((k) => MODES[k] === request.fulfilmentOwner) ?? null,
    request_status: request.status,
    shipment: shipment ? { reference: shipment.reference, status: shipment.status } : null,
    created_at: request.createdAt.toISOString(),
  };
}

export async function createPartnerFulfillment(partnerId, body, db = prisma) {
  if (!partnerFulfillmentEnabled()) throw new PartnerFulfillmentError('disabled', 'Partner fulfilment requests are not enabled', 403);
  const extBiz = String(body?.external_business_id ?? '');
  const extOrder = String(body?.external_order_id ?? '');
  if (!ID_RE.test(extBiz) || !ID_RE.test(extOrder)) throw new PartnerFulfillmentError('invalid', 'external_business_id and external_order_id are required');
  if (body?.mode === 'jokko_logistics') {
    throw new PartnerFulfillmentError('requires_merchant_approval', 'Jokko Logistics holds a delivery fee from the business wallet: not available to partners without an in-Jokko approval (D-J14-1)', 409);
  }
  const owner = MODES[body?.mode];
  if (!owner) throw new PartnerFulfillmentError('invalid_mode', 'mode must be merchant_fleet or customer_pickup');
  const lines = Array.isArray(body?.lines) ? body.lines : [];
  if (!lines.length || lines.length > MAX_LINES) throw new PartnerFulfillmentError('invalid_lines', `1–${MAX_LINES} lines are required`);
  for (const l of lines) {
    if (!LINE_ID_RE.test(String(l?.external_product_id ?? '')) || !Number.isSafeInteger(l?.qty) || l.qty < 1 || l.qty > 100_000) {
      throw new PartnerFulfillmentError('invalid_lines', 'Each line needs external_product_id and a positive integer qty');
    }
  }
  const biz = await db.externalLink.findUnique({ where: { system_objectType_externalId: { system: partnerId, objectType: 'business', externalId: extBiz } } });
  if (!biz || biz.status !== 'active') throw new PartnerFulfillmentError('business_not_linked', 'Business not linked', 404);
  const businessId = biz.jokkoId;
  const business = await db.business.findUnique({ where: { id: businessId }, select: { id: true, ownerId: true } });
  if (!business) throw new PartnerFulfillmentError('business_not_linked', 'Business not linked', 404);

  const resolved = [];
  const unmapped = [];
  for (const l of lines) {
    const r = await resolveExternalProduct(db, partnerId, extBiz, l.external_product_id);
    if (!r) unmapped.push(l.external_product_id);
    else resolved.push({ productId: r.productId, qty: l.qty, externalProductId: String(l.external_product_id) });
  }
  if (unmapped.length) {
    const e = new PartnerFulfillmentError('product_not_mapped', 'Some products are not mapped to this business (POST /v1/product-links first)', 422);
    e.unmapped = unmapped.slice(0, 20);
    throw e;
  }
  let pickupPointId = null;
  if (owner === 'CUSTOMER_PICKUP' && body?.pickup_point_id) {
    const pp = await db.pickupPoint.findUnique({ where: { id: String(body.pickup_point_id) }, select: { id: true, status: true } });
    if (!pp || pp.status !== 'active') throw new PartnerFulfillmentError('invalid_pickup_point', 'Pickup point not available', 409);
    pickupPointId = pp.id;
  }
  const d = body?.destination ?? {};
  const dest = {
    area: d.area ? String(d.area).slice(0, 120) : null,
    precise: d.precise ? String(d.precise).slice(0, 300) : null,
    lat: Number.isFinite(d.lat) ? d.lat : null,
    lng: Number.isFinite(d.lng) ? d.lng : null,
  };
  if (owner === 'MERCHANT_FULFILLED' && !dest.area) throw new PartnerFulfillmentError('invalid_destination', 'destination.area is required for merchant_fleet');

  const sourceSystem = sourceSystemFor(partnerId);
  const sourceId = `${extBiz}:${extOrder}`;
  const out = await runMoneyTransaction(db, async (tx) => {
    // Serialize per partner order so concurrent retries converge on one request.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`partner-fulfilment:${sourceSystem}:${sourceId}`}))`;
    // A suspended / closed business takes no new partner-driven shipments (row share-locked against a concurrent change).
    await tx.$executeRaw`SELECT id FROM "Business" WHERE id = ${businessId} FOR SHARE`;
    const st = await tx.business.findUnique({ where: { id: businessId }, select: { status: true } });
    if ((st?.status ?? 'missing') !== 'active') throw new PartnerFulfillmentError('business_inactive', 'This business cannot take new fulfilment requests', 409);
    const r = await createRequestInTx(tx, {
      sourceSystem, sourceId, fulfilmentOwner: owner, fulfillerBusinessId: businessId, originBusinessId: businessId,
      pickupPointId, lines: resolved, dest, createdBy: business.ownerId,
    });
    if (r.replayed && r.request.originBusinessId !== businessId) throw new PartnerFulfillmentError('conflict', 'Order reference already used', 409);
    if (!r.replayed && r.shipment) {
      await tx.externalLink.create({ data: { system: partnerId, objectType: 'shipment', externalId: `${extBiz}::${extOrder}::${r.shipment.id}`, jokkoType: 'shipment', jokkoId: r.shipment.id, businessId, linkedBy: `partner:${partnerId}` } });
    }
    return r;
  });
  return { body: shape(out.request, out.shipment, extOrder), created: !out.replayed };
}

export async function getPartnerFulfillment(partnerId, reference, db = prisma) {
  if (!partnerFulfillmentEnabled()) throw new PartnerFulfillmentError('disabled', 'Partner fulfilment requests are not enabled', 403);
  const request = await db.fulfilmentRequest.findUnique({ where: { reference: String(reference) } });
  // Another partner's (or a Jokko-native) request reads exactly like a missing one.
  if (!request || request.sourceSystem !== sourceSystemFor(partnerId)) throw new PartnerFulfillmentError('not_found', 'Fulfilment request not found', 404);
  const [extBiz, ...rest] = request.sourceId.split(':');
  const biz = await db.externalLink.findUnique({ where: { system_objectType_externalId: { system: partnerId, objectType: 'business', externalId: extBiz } } });
  if (!biz || biz.status !== 'active' || biz.jokkoId !== request.originBusinessId) throw new PartnerFulfillmentError('not_found', 'Fulfilment request not found', 404);
  const shipment = await db.shipment.findFirst({ where: { requestId: request.id }, orderBy: { createdAt: 'desc' } });
  return shape(request, shipment, rest.join(':'));
}
