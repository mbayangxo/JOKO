/**
 * J14-S2 Partner API: fulfilment requests for the partner's linked businesses → Jokko Logistics (J8).
 * Dormant unless PARTNER_FULFILLMENT_ENABLED=true. No money moves.
 */
import { PartnerFulfillmentError, createPartnerFulfillment, getPartnerFulfillment } from './partner-fulfillment.js';

async function partner(req, res) {
  const { requirePartner } = await import('../partner-handlers.js');
  return requirePartner(req, res);
}
function fail(res, e) {
  if (e instanceof PartnerFulfillmentError) {
    res.status(e.status).json({ error: e.message, code: e.code, ...(e.unmapped ? { unmapped: e.unmapped } : {}) });
    return true;
  }
  if (e?.name === 'LogisticsError' || e?.constructor?.name === 'LogisticsError') {
    res.status(e.status ?? 409).json({ error: e.message, code: e.code });
    return true;
  }
  return false;
}

export async function partnerFulfillmentCreate(req, res) {
  if (!(await partner(req, res))) return;
  try {
    const r = await createPartnerFulfillment(req.partnerId, req.body ?? {});
    res.status(r.created ? 201 : 200).json(r.body);
  } catch (e) {
    if (!fail(res, e)) throw e;
  }
}

export async function partnerFulfillmentGet(req, res) {
  if (!(await partner(req, res))) return;
  try {
    res.json(await getPartnerFulfillment(req.partnerId, req.query.reference ?? req.query.id));
  } catch (e) {
    if (!fail(res, e)) throw e;
  }
}
