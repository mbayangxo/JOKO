/** J14-S5 HTTP: seller order card in a Mbolo conversation (dormant unless MBOLO_ORDER_CARD_ENABLED=true). */
import { MboloOrderError, createMboloOrderCard, reshareMboloOrderCard } from './mbolo-orders.js';

function fail(res, e) {
  if (e instanceof MboloOrderError) {
    res.status(e.status).json({ error: e.message, code: e.code });
    return true;
  }
  if (e?.name === 'OrgAccessError' || e?.name === 'MboloAccessError') {
    res.status(e.status ?? 403).json({ error: e.message, code: e.code ?? 'forbidden' });
    return true;
  }
  return false;
}

export async function mboloOrderCardCreate(req, res) {
  try {
    const b = req.body ?? {};
    const r = await createMboloOrderCard(req.userId, req.query.id, {
      businessId: b.businessId, lines: b.lines, fulfillmentType: b.fulfillmentType, requestKey: b.requestKey ?? req.headers['idempotency-key'],
    });
    res.status(r.replayed ? 200 : 201).json(r);
  } catch (e) {
    if (!fail(res, e)) throw e;
  }
}

export async function mboloOrderCardReshare(req, res) {
  try {
    res.status(201).json(await reshareMboloOrderCard(req.userId, req.query.id, req.query.subId));
  } catch (e) {
    if (!fail(res, e)) throw e;
  }
}

/** J14-F2: expiry pass for unpaid card orders (dormant unless MBOLO_ORDER_EXPIRY_ENABLED). */
export async function cronMboloOrderExpiry(req, res) {
  const { assertCronAuth } = await import('../cron-auth.js');
  if (!assertCronAuth(req, res)) return;
  const { expireMboloCardOrders } = await import('./mbolo-orders.js');
  res.json(await expireMboloCardOrders());
}
