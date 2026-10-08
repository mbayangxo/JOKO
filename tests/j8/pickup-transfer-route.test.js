/**
 * J8.13 / J8.14 / J8.17 / J8.22 / J8.23 — customer pickup (at the source and at an
 * approved pickup point), inventory transfer between a business's own locations,
 * and own-fleet routes with consolidation. J2 invariants after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { assertLogisticsInvariants } from '../../lib/logistics/invariants.js';
import { runMoneyTransaction } from '../../lib/wallet-atomic.js';
import { createRequestInTx } from '../../lib/logistics/intake.js';
import { business, customer, operator, signedIn } from '../j3/helpers.js';
import { fleetDriver, member, readyPo, shipmentFor, stockAt, supplier } from './fixture.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => {
  await assertInvariants(prisma);
  await assertLogisticsInvariants(prisma);
});

const ok = (r, what = '') => {
  assert.ok(r.status >= 200 && r.status < 300, `${what} ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

test('buyer pickup at the distributor: buyer issues the collection code, the desk releases once, then per-line receiving', async () => {
  const x = await readyPo(api, { packs: 1 });
  ok(await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/b2b/purchase-orders/${x.po.id}/advance`, { to: 'fulfilment_requested', fulfilmentMode: 'buyer_pickup', tracked: true }));
  const sh = await shipmentFor(x.po.id);
  assert.equal((await prisma.fulfilmentRequest.findUnique({ where: { id: sh.requestId } })).fulfilmentOwner, 'CUSTOMER_PICKUP');
  assert.equal((await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/codes`, { purpose: 'collection' })).status, 404, 'the desk cannot issue the receiver’s code');
  const cc = ok(await x.m.owner.call('POST', `logistics/shipments/${sh.id}/codes`, { purpose: 'collection' }));
  assert.equal((await x.m.owner.call('POST', `logistics/shipments/${sh.id}/release`, { code: cc.code })).status, 404, 'the receiver cannot release to itself');
  const desk = await member(api, x.sup.b, 'fulfillment');
  assert.equal((await desk.call('POST', `logistics/shipments/${sh.id}/release`, { code: 'WRONGCOD' })).body.code, 'code_invalid');
  const rel = ok(await desk.call('POST', `logistics/shipments/${sh.id}/release`, { code: cc.code }));
  assert.equal(rel.deliveryProof, 'pickup_point_release');
  assert.equal((await desk.call('POST', `logistics/shipments/${sh.id}/release`, { code: cc.code })).body.replayed, true);
  assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: x.po.id } })).status, 'delivered');
  ok(await x.m.owner.call('POST', `logistics/shipments/${sh.id}/receiving`, { lines: [{ productId: x.sup.product.id, received: 12 }] }));
  assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: x.po.id } })).status, 'received');
});

test('pickup point: enrollment ≠ activation; only an approved point’s operator receives and releases; the source cannot bypass the point', async () => {
  const merchantC = await customer();
  const merchantS = await signedIn(api, merchantC);
  const shop = await business(merchantC.user);
  const pointOwnerC = await customer();
  const pointOwner = await signedIn(api, pointOwnerC);
  const pointBiz = await business(pointOwnerC.user);
  const point = ok(await pointOwner.call('POST', `businesses/${pointBiz.id}/pickup-points`, { name: 'Boutique Relais Médina', services: ['customer_pickup'] }), 'apply');
  assert.equal(point.status, 'applied');
  assert.equal(ok(await merchantS.call('GET', 'logistics/pickup-points')).items.some((p) => p.id === point.id), false, 'not listed before approval');
  const buyerC = await customer();
  const buyer = await signedIn(api, buyerC);
  const { shipment } = await runMoneyTransaction(prisma, (tx) => createRequestInTx(tx, {
    sourceSystem: 'jokko_order', sourceId: `ord-${Date.now()}`, fulfilmentOwner: 'CUSTOMER_PICKUP', fulfillerBusinessId: shop.id, originBusinessId: shop.id,
    destinationUserId: buyerC.id, pickupPointId: point.id, lines: [], createdBy: merchantC.id,
  }));
  assert.equal((await pointOwner.call('POST', `logistics/shipments/${shipment.id}/drop`, {})).status, 404, 'an unapproved point cannot take custody');
  // Approval is a compliance decision; logistics ops cannot approve points.
  const lops = await operator(api, ['logistics_ops']);
  assert.equal((await lops.call('POST', `admin/pickup-points/${point.id}/decide`, { status: 'active', reason: 'visite effectuée' })).status, 403);
  const comp = await operator(api, ['compliance']);
  ok(await comp.call('POST', `admin/pickup-points/${point.id}/decide`, { status: 'active', reason: 'visite effectuée' }));
  const listed = ok(await buyer.call('GET', 'logistics/pickup-points')).items.find((p) => p.id === point.id);
  assert.ok(listed);
  assert.equal(listed.operatorBusinessId, undefined, 'no operator identity / address in the public list');
  ok(await pointOwner.call('POST', `logistics/shipments/${shipment.id}/drop`, {}), 'drop');
  const cc = ok(await buyer.call('POST', `logistics/shipments/${shipment.id}/codes`, { purpose: 'collection' }));
  assert.equal((await merchantS.call('POST', `logistics/shipments/${shipment.id}/release`, { code: cc.code })).status, 404, 'the source cannot release a parcel held at a point');
  // Suspending the point removes its authority at once.
  ok(await comp.call('POST', `admin/pickup-points/${point.id}/decide`, { status: 'suspended', reason: 'contrôle en cours' }));
  assert.equal((await pointOwner.call('POST', `logistics/shipments/${shipment.id}/release`, { code: cc.code })).status, 404);
  ok(await comp.call('POST', `admin/pickup-points/${point.id}/decide`, { status: 'active', reason: 'contrôle terminé' }));
  const rel = ok(await pointOwner.call('POST', `logistics/shipments/${shipment.id}/release`, { code: cc.code }));
  assert.equal(rel.status, 'delivered');
  assert.equal(rel.custody, 'receiver');
  // The buyer sees area-level data only; the point never sees the buyer's contact.
  const bv = ok(await buyer.call('GET', `logistics/shipments/${shipment.id}`));
  assert.equal(bv.role, 'receiver');
  assert.equal(bv.destination.precise, undefined);
});

test('inventory transfer between own locations: out once, in once (received only), courier never signs, cancel re-credits', async () => {
  const sup = await supplier(api, { stock: 0 });
  const second = await prisma.inventoryLocation.create({ data: { operatorBusinessId: sup.b.id, kind: 'store', name: 'Boutique Thiaroye' } });
  ok(await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/depots/${sup.depot.id}/stock`, { productId: sup.product.id, units: 100 }));
  const outsider = await signedIn(api, await customer());
  assert.equal((await outsider.call('POST', `businesses/${sup.b.id}/logistics/transfers`, { fromLocationId: sup.depot.id, toLocationId: second.id, lines: [{ productId: sup.product.id, units: 10 }] })).status, 404);
  const tooMany = await sup.owner.call('POST', `businesses/${sup.b.id}/logistics/transfers`, { fromLocationId: sup.depot.id, toLocationId: second.id, lines: [{ productId: sup.product.id, units: 1000 }] });
  assert.equal(tooMany.body.code, 'insufficient_stock');
  const t = ok(await sup.owner.call('POST', `businesses/${sup.b.id}/logistics/transfers`, { fromLocationId: sup.depot.id, toLocationId: second.id, lines: [{ productId: sup.product.id, units: 30 }] }), 'transfer');
  assert.equal((await stockAt(sup.depot.id, sup.product.id)).onHand, 70);
  assert.equal((await stockAt(second.id, sup.product.id)).onHand, 0, 'in transit: in nobody’s position');
  const driver = await fleetDriver(api, sup.b);
  ok(await sup.owner.call('POST', `logistics/shipments/${t.shipmentId}/assign`, { courierUserId: driver.id }), 'assign (own driver allowed on an internal transfer)');
  const pc = ok(await sup.owner.call('POST', `logistics/shipments/${t.shipmentId}/codes`, { purpose: 'pickup' }));
  ok(await driver.call('POST', `logistics/shipments/${t.shipmentId}/pickup`, { code: pc.code }));
  ok(await driver.call('POST', `logistics/shipments/${t.shipmentId}/step`, { step: 'arrive_delivery' }));
  assert.equal((await driver.call('POST', `logistics/shipments/${t.shipmentId}/receiving`, { lines: [{ productId: sup.product.id, received: 30 }] })).status, 404, 'the driver cannot sign');
  const rc = ok(await sup.owner.call('POST', `logistics/shipments/${t.shipmentId}/receiving`, { lines: [{ productId: sup.product.id, received: 28, damaged: 2 }] }));
  assert.equal(rc.receiving.outcome, 'damaged');
  assert.equal((await stockAt(second.id, sup.product.id)).onHand, 28, 'only received units credited');
  assert.equal((await prisma.stockTransfer.findUnique({ where: { id: t.transfer.id } })).status, 'received');
  ok(await sup.owner.call('POST', `logistics/shipments/${t.shipmentId}/receiving`, { lines: [{ productId: sup.product.id, received: 30 }] }));
  assert.equal((await stockAt(second.id, sup.product.id)).onHand, 28, 'credited once');
  // The owner as both driver and receiver: refused.
  const t2 = ok(await sup.owner.call('POST', `businesses/${sup.b.id}/logistics/transfers`, { fromLocationId: sup.depot.id, toLocationId: second.id, lines: [{ productId: sup.product.id, units: 5 }] }));
  ok(await sup.owner.call('POST', `logistics/shipments/${t2.shipmentId}/assign`, { courierUserId: sup.owner.id }));
  const pc2 = ok(await sup.owner.call('POST', `logistics/shipments/${t2.shipmentId}/codes`, { purpose: 'pickup' }));
  ok(await sup.owner.call('POST', `logistics/shipments/${t2.shipmentId}/pickup`, { code: pc2.code }));
  ok(await sup.owner.call('POST', `logistics/shipments/${t2.shipmentId}/step`, { step: 'arrive_delivery' }));
  assert.equal((await sup.owner.call('POST', `logistics/shipments/${t2.shipmentId}/receiving`, { lines: [{ productId: sup.product.id, received: 5 }] })).body.code, 'courier_is_party');
  // Cancel before pickup re-credits the source once.
  const t3 = ok(await sup.owner.call('POST', `businesses/${sup.b.id}/logistics/transfers`, { fromLocationId: sup.depot.id, toLocationId: second.id, lines: [{ productId: sup.product.id, units: 10 }] }));
  const mid = (await stockAt(sup.depot.id, sup.product.id)).onHand;
  ok(await sup.owner.call('POST', `logistics/shipments/${t3.shipmentId}/cancel`, { reason: 'erreur de saisie' }));
  assert.equal((await stockAt(sup.depot.id, sup.product.id)).onHand, mid + 10);
  assert.equal((await prisma.stockTransfer.findUnique({ where: { id: t3.transfer.id } })).status, 'cancelled');
  const list = ok(await sup.owner.call('GET', `businesses/${sup.b.id}/logistics/transfers`));
  assert.equal(list.length, 3);
});

test('route consolidation: one driver, several merchants, each shipment keeps its own custody and proof', async () => {
  const a = await readyPo(api, { packs: 1 });
  const sup = a.sup;
  // A second merchant of the same distributor.
  const { merchant, submit, withStepUp } = await import('../j7/fixture.js');
  const m2 = await merchant(api, sup);
  const po2 = ok(await submit(m2, sup, { packs: 1 }));
  ok(await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po2.id}/accept`, {}));
  ok(await m2.owner.call('POST', `businesses/${m2.b.id}/b2b/purchase-orders/${po2.id}/pay`, { expectedAmountKori: po2.totalKori }, await withStepUp(m2.owner)));
  for (const to of ['preparing', 'ready']) ok(await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po2.id}/advance`, { to }));
  for (const id of [a.po.id, po2.id]) ok(await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${id}/advance`, { to: 'fulfilment_requested', fulfilmentMode: 'seller_delivery', tracked: true }));
  const s1 = await shipmentFor(a.po.id);
  const s2 = await shipmentFor(po2.id);
  const driver = await fleetDriver(api, sup.b);
  const outsider = await signedIn(api, await customer());
  assert.equal((await sup.owner.call('POST', `businesses/${sup.b.id}/logistics/routes`, { serviceDate: new Date().toISOString(), driverUserId: outsider.id, shipmentIds: [s1.id, s2.id] })).body.code, 'not_a_driver');
  assert.equal((await driver.call('POST', `businesses/${sup.b.id}/logistics/routes`, { serviceDate: new Date().toISOString(), driverUserId: driver.id, shipmentIds: [s1.id, s2.id] })).status, 404, 'a driver cannot dispatch');
  const r = ok(await sup.owner.call('POST', `businesses/${sup.b.id}/logistics/routes`, { serviceDate: new Date().toISOString(), driverUserId: driver.id, shipmentIds: [s1.id, s2.id] }), 'route');
  assert.deepEqual(r.stops.map((s) => s.assigned), [true, true]);
  assert.equal((await sup.owner.call('POST', `businesses/${sup.b.id}/logistics/routes`, { serviceDate: new Date().toISOString(), driverUserId: driver.id, shipmentIds: [s1.id] })).body.code, 'invalid_state', 'a shipment is on one route');
  const mine = ok(await driver.call('GET', 'logistics/courier/shipments'));
  assert.deepEqual(new Set(mine.items.map((s) => s.id)), new Set([s1.id, s2.id]));
  // One proof per shipment: merchant 1's code does not deliver merchant 2's goods.
  for (const s of [s1, s2]) {
    const pc = ok(await sup.owner.call('POST', `logistics/shipments/${s.id}/codes`, { purpose: 'pickup' }));
    ok(await driver.call('POST', `logistics/shipments/${s.id}/pickup`, { code: pc.code }));
  }
  const dc1 = ok(await a.m.owner.call('POST', `logistics/shipments/${s1.id}/codes`, { purpose: 'delivery' }));
  assert.equal((await driver.call('POST', `logistics/shipments/${s2.id}/deliver`, { code: dc1.code })).body.code, 'code_invalid');
  assert.equal((await a.m.owner.call('POST', `logistics/shipments/${s2.id}/codes`, { purpose: 'delivery' })).status, 404, 'merchant 1 is not party to merchant 2’s shipment');
  ok(await driver.call('POST', `logistics/shipments/${s1.id}/deliver`, { code: dc1.code }));
  assert.equal((await prisma.shipment.findUnique({ where: { id: s2.id } })).status, 'picked_up');
  const routes = ok(await sup.owner.call('GET', `businesses/${sup.b.id}/logistics/routes`));
  assert.equal(routes[0].stops.length, 2);
});
