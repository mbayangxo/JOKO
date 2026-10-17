import { prisma } from '../helpers/db.js';
import { customer, signedIn } from '../j3/helpers.js';
import { idemH, member, merchant, submit, supplier, withStepUp } from '../j7/fixture.js';

export { idemH, member, merchant, submit, supplier, withStepUp };

/** A paid, ready PO from a distributor to a merchant (due_now), returned with both parties. */
export async function readyPo(api, { packs = 2, stock = 1200 } = {}) {
  const sup = await supplier(api, { stock });
  const m = await merchant(api, sup);
  const po = await submit(m, sup, { packs });
  if (po.status !== 201) throw new Error(`submit ${po.status} ${JSON.stringify(po.body)}`);
  const ok = (r, what) => {
    if (r.status !== 200) throw new Error(`${what} ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  ok(await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.body.id}/accept`, {}), 'accept');
  ok(await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.body.id}/pay`, { expectedAmountKori: po.body.totalKori }, await withStepUp(m.owner)), 'pay');
  for (const to of ['preparing', 'ready']) ok(await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.body.id}/advance`, { to }), to);
  return { sup, m, po: po.body };
}

/** A driver of the business's own fleet (role fleet_driver), signed in. */
export const fleetDriver = (api, biz) => member(api, biz, 'fleet_driver');

/** An approved Jokko courier (active driver application role), signed in. */
export async function jokkoCourier(api) {
  const c = await customer();
  await prisma.accountRole.upsert({ where: { userId_role: { userId: c.id, role: 'driver' } }, create: { userId: c.id, role: 'driver', status: 'active' }, update: { status: 'active' } });
  return signedIn(api, c);
}

export async function shipmentFor(poId) {
  const r = await prisma.fulfilmentRequest.findFirst({ where: { sourceSystem: 'jokko_po', sourceId: poId }, orderBy: { createdAt: 'desc' } });
  if (!r) return null;
  return prisma.shipment.findFirst({ where: { requestId: r.id }, orderBy: { createdAt: 'desc' } });
}

export const stockAt = async (locationId, productId) => (await prisma.depotStock.findUnique({ where: { locationId_productId: { locationId, productId } } })) ?? { onHand: 0, reserved: 0 };
