/**
 * J8 pilot: courier accept / decline (offered work), D39 emergency reassignment
 * with a handoff code (never duplicate custody or earnings), refusals at the door
 * travelling back to the depot, and route reconciliation. J2 + custody invariants
 * after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { assertLogisticsInvariants } from '../../lib/logistics/invariants.js';
import { operator } from '../j3/helpers.js';
import { fleetDriver, jokkoCourier, readyPo, shipmentFor, stockAt } from './fixture.js';

let api;
before(async () => { api = await startApiServer({ JOKKO_LOGISTICS_ENABLED: 'true' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => {
  await assertInvariants(prisma);
  await assertLogisticsInvariants(prisma);
});

const ok = (r, what = '') => {
  assert.ok(r.status >= 200 && r.status < 300, `${what} ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

async function tracked(packs = 1) {
  const x = await readyPo(api, { packs });
  ok(await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/b2b/purchase-orders/${x.po.id}/advance`, { to: 'fulfilment_requested', fulfilmentMode: 'seller_delivery', tracked: true }));
  return { ...x, sh: await shipmentFor(x.po.id) };
}

test('offered work: the courier sees it as offered, accepts or declines; a decline returns it to dispatch', async () => {
  const x = await tracked();
  const d1 = await fleetDriver(api, x.sup.b);
  ok(await x.sup.owner.call('POST', `logistics/shipments/${x.sh.id}/assign`, { courierUserId: d1.id }));
  const list = ok(await d1.call('GET', 'logistics/courier/shipments'));
  assert.equal(list.items[0].offered, true);
  const dec = ok(await d1.call('POST', `logistics/shipments/${x.sh.id}/respond`, { accept: false, reason: 'moto en panne' }));
  assert.equal(dec.status, 'ready_for_pickup');
  assert.equal((await d1.call('GET', `logistics/shipments/${x.sh.id}`)).status, 404, 'no residual access after declining');
  const d2 = await fleetDriver(api, x.sup.b);
  ok(await x.sup.owner.call('POST', `logistics/shipments/${x.sh.id}/assign`, { courierUserId: d2.id }));
  ok(await d2.call('POST', `logistics/shipments/${x.sh.id}/respond`, { accept: true }));
  assert.equal(ok(await d2.call('GET', 'logistics/courier/shipments')).items[0].offered, false);
  const pc = ok(await x.sup.owner.call('POST', `logistics/shipments/${x.sh.id}/codes`, { purpose: 'pickup' }));
  ok(await d2.call('POST', `logistics/shipments/${x.sh.id}/pickup`, { code: pc.code }));
  assert.equal((await d2.call('POST', `logistics/shipments/${x.sh.id}/respond`, { accept: false })).body.code, 'invalid_state', 'no decline once the goods are held');
});

test('D39 emergency reassignment (Jokko): new courier holds nothing until the handoff code; one custody, one earning', async () => {
  const x = await readyPo(api, { packs: 1 });
  const ops = await operator(api, ['logistics_ops']);
  ok(await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/b2b/purchase-orders/${x.po.id}/advance`, { to: 'fulfilment_requested', fulfilmentMode: 'jokko_logistics' }));
  const sh = await shipmentFor(x.po.id);
  ok(await ops.call('POST', `admin/logistics/shipments/${sh.id}/accept`, {}));
  ok(await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/ready`, {}));
  const [c1, c2] = [await jokkoCourier(api), await jokkoCourier(api)];
  ok(await ops.call('POST', `admin/logistics/shipments/${sh.id}/assign`, { courierUserId: c1.id }));
  const pc = ok(await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/codes`, { purpose: 'pickup' }));
  ok(await c1.call('POST', `logistics/shipments/${sh.id}/pickup`, { code: pc.code }));
  // The business cannot reassign a Jokko shipment; a reason is required.
  assert.equal((await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/emergency-reassign`, { courierUserId: c2.id, reason: 'accident de moto signalé' })).status, 404);
  assert.equal((await ops.call('POST', `admin/logistics/shipments/${sh.id}/emergency-reassign`, { courierUserId: c2.id, reason: 'court' })).status, 400);
  ok(await ops.call('POST', `admin/logistics/shipments/${sh.id}/emergency-reassign`, { courierUserId: c2.id, reason: 'accident de moto signalé' }));
  assert.equal(await prisma.courierAssignment.count({ where: { shipmentId: sh.id, status: 'active' } }), 1);
  // Before the handoff: the new courier cannot deliver; the old courier has no more rights.
  const dc = ok(await x.m.owner.call('POST', `logistics/shipments/${sh.id}/codes`, { purpose: 'delivery' }));
  assert.equal((await c2.call('POST', `logistics/shipments/${sh.id}/deliver`, { code: dc.code })).body.code, 'handoff_pending');
  assert.equal((await c1.call('POST', `logistics/shipments/${sh.id}/deliver`, { code: dc.code })).status, 404);
  assert.equal(ok(await c2.call('GET', 'logistics/courier/shipments')).items[0].handoffPending, true);
  // The previous custodian issues the handoff code (bound to c2); only c2 can use it.
  const hc = ok(await c1.call('POST', `logistics/shipments/${sh.id}/handoff-code`, {}));
  const c3 = await jokkoCourier(api);
  assert.equal((await c3.call('POST', `logistics/shipments/${sh.id}/handoff`, { code: hc.code })).status, 404);
  ok(await c2.call('POST', `logistics/shipments/${sh.id}/handoff`, { code: hc.code }));
  assert.equal(ok(await c2.call('POST', `logistics/shipments/${sh.id}/handoff`, { code: hc.code })).replayed, true);
  assert.equal((await prisma.shipment.findUnique({ where: { id: sh.id } })).custodianUserId, c2.id);
  const dc2 = ok(await x.m.owner.call('POST', `logistics/shipments/${sh.id}/codes`, { purpose: 'delivery' }));
  ok(await c2.call('POST', `logistics/shipments/${sh.id}/deliver`, { code: dc2.code }));
  const earnings = await prisma.courierEarning.findMany({ where: { shipmentId: sh.id } });
  assert.deepEqual(earnings.map((e) => [e.courierUserId, e.amountKori]), [[c2.id, 120]], 'exactly one earning, to the courier who delivered');
  assert.equal(await prisma.identityAuditEvent.count({ where: { action: 'shipment_emergency_reassigned', subjectId: sh.id } }), 1);
});

test('refused at the door: refused units leave with the courier on a return shipment; back in the depot once; reconciliation balances', async () => {
  const x = await tracked(3); // 36 units
  const driver = await fleetDriver(api, x.sup.b);
  const route = ok(await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/logistics/routes`, { serviceDate: new Date().toISOString(), driverUserId: driver.id, shipmentIds: [x.sh.id] }));
  const pc = ok(await x.sup.owner.call('POST', `logistics/shipments/${x.sh.id}/codes`, { purpose: 'pickup' }));
  ok(await driver.call('POST', `logistics/shipments/${x.sh.id}/pickup`, { code: pc.code }));
  ok(await driver.call('POST', `logistics/shipments/${x.sh.id}/step`, { step: 'arrive_delivery' }));
  const depotBefore = (await stockAt(x.sup.depot.id, x.sup.product.id)).onHand;
  const rc = ok(await x.m.owner.call('POST', `logistics/shipments/${x.sh.id}/receiving`, { lines: [{ productId: x.sup.product.id, received: 20, damaged: 2, missing: 2, refused: 12 }] }));
  assert.ok(rc.refusalReturnShipmentId);
  const rs = await prisma.shipment.findUnique({ where: { id: rc.refusalReturnShipmentId } });
  assert.deepEqual([rs.status, rs.custody, rs.custodianUserId], ['picked_up', 'courier', driver.id]);
  let rec = ok(await x.sup.owner.call('GET', `businesses/${x.sup.b.id}/logistics/routes/${route.id}/reconciliation`));
  assert.equal(rec.closed, false, 'the route is open while refused goods are on the road');
  assert.equal(rec.totals.refusedInTransit, 12);
  assert.equal(rec.totals.unaccounted, 0);
  // The courier brings them back; the depot receives per line (11 good, 1 lost on the way back).
  ok(await driver.call('POST', `logistics/shipments/${rs.id}/step`, { step: 'arrive_delivery' }));
  ok(await x.sup.owner.call('POST', `logistics/shipments/${rs.id}/receiving`, { lines: [{ productId: x.sup.product.id, received: 11, missing: 1 }] }));
  assert.equal((await stockAt(x.sup.depot.id, x.sup.product.id)).onHand, depotBefore + 11, 'refused units back on hand once');
  rec = ok(await x.sup.owner.call('GET', `businesses/${x.sup.b.id}/logistics/routes/${route.id}/reconciliation`));
  assert.equal(rec.closed, true);
  assert.deepEqual({ ...rec.totals }, { dispatched: 36, received: 20, damaged: 2, missing: 3, refused: 12, refusedBackAtDepot: 11, refusedInTransit: 0, returnedToDepot: 0, inTransit: 0, unaccounted: 0 });
  // A refusal after the courier left is refused (it would strand goods): use a J7 return instead.
  const y = await tracked(1);
  const d2 = await fleetDriver(api, y.sup.b);
  ok(await y.sup.owner.call('POST', `logistics/shipments/${y.sh.id}/assign`, { courierUserId: d2.id }));
  const pc2 = ok(await y.sup.owner.call('POST', `logistics/shipments/${y.sh.id}/codes`, { purpose: 'pickup' }));
  ok(await d2.call('POST', `logistics/shipments/${y.sh.id}/pickup`, { code: pc2.code }));
  const dc = ok(await y.m.owner.call('POST', `logistics/shipments/${y.sh.id}/codes`, { purpose: 'delivery' }));
  ok(await d2.call('POST', `logistics/shipments/${y.sh.id}/deliver`, { code: dc.code }));
  assert.equal((await y.m.owner.call('POST', `logistics/shipments/${y.sh.id}/receiving`, { lines: [{ productId: y.sup.product.id, received: 6, refused: 6 }] })).body.code, 'refusal_requires_courier');
});
