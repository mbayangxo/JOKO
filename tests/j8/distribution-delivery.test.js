/**
 * J8.15 / J8.16 — distributor → merchant delivery on the distributor's own fleet,
 * end to end over HTTP: PO hand-off → shipment → assignment → two-party pickup →
 * two-party delivery → per-line receiving (with a discrepancy) → stock credited
 * once → PO received / disputed. J2 invariants after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { assertLogisticsInvariants } from '../../lib/logistics/invariants.js';
import { ensurePrimaryInventoryLocation } from '../../lib/business/identity.js';
import { customer, signedIn } from '../j3/helpers.js';
import { fleetDriver, member, readyPo, shipmentFor, stockAt } from './fixture.js';

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
const adv = (x, body) => x.sup.owner.call('POST', `businesses/${x.sup.b.id}/b2b/purchase-orders/${x.po.id}/advance`, body);

test('tracked own-fleet delivery: verified proof, receiving with a discrepancy, stock credited once, PO disputed', async () => {
  const x = await readyPo(api, { packs: 2 }); // 24 units
  const driver = await fleetDriver(api, x.sup.b);
  const outsider = await signedIn(api, await customer());

  const fr = ok(await adv(x, { to: 'fulfilment_requested', fulfilmentMode: 'seller_delivery', tracked: true }), 'handoff');
  assert.equal(fr.status, 'fulfilment_requested');
  const sh = await shipmentFor(x.po.id);
  assert.ok(sh, 'the outbox hand-off created exactly one shipment');
  assert.equal(sh.status, 'ready_for_pickup');
  const req = await prisma.fulfilmentRequest.findUnique({ where: { id: sh.requestId } });
  assert.equal(req.fulfilmentOwner, 'DISTRIBUTOR_FULFILLED');
  assert.equal(req.feeKori, 0, 'own fleet: no Jokko fee');

  // The seller can no longer self-record delivery: the shipment proves it.
  assert.equal((await adv(x, { to: 'delivered' })).body.code, 'delivered_by_shipment');

  // Outsiders, the buyer and the driver cannot read precise data / assign.
  assert.equal((await outsider.call('GET', `logistics/shipments/${sh.id}`)).status, 404);
  assert.equal((await x.m.owner.call('POST', `logistics/shipments/${sh.id}/assign`, { courierUserId: driver.id })).status, 404, 'receiver cannot dispatch');
  assert.equal((await driver.call('POST', `logistics/shipments/${sh.id}/assign`, { courierUserId: driver.id })).status, 404, 'driver cannot self-assign');
  // A buyer staff member is never the courier of what they receive.
  const buyerStaff = await member(api, x.m.b, 'inventory');
  await prisma.businessMember.create({ data: { businessId: x.sup.b.id, userId: buyerStaff.id, role: 'fleet_driver', status: 'active', acceptedAt: new Date() } });
  assert.equal((await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/assign`, { courierUserId: buyerStaff.id })).body.code, 'courier_is_party');
  assert.equal((await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/assign`, { courierUserId: outsider.id })).body.code, 'not_a_driver');

  const asg = ok(await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/assign`, { courierUserId: driver.id }), 'assign');
  assert.equal(asg.status, 'assigned');
  // Courier sees the precise destination only while assigned; the source sees only the area.
  const dView = ok(await driver.call('GET', `logistics/shipments/${sh.id}`));
  assert.equal(dView.role, 'courier');
  assert.ok('precise' in dView.destination);
  const sView = ok(await x.sup.owner.call('GET', `logistics/shipments/${sh.id}`));
  assert.equal(sView.destination.precise, undefined);

  // Pickup without a code / with a wrong code fails; the source issues a code bound to this driver.
  assert.equal((await driver.call('POST', `logistics/shipments/${sh.id}/pickup`, { code: 'AAAAAAAA' })).body.code, 'code_invalid');
  assert.equal((await driver.call('POST', `logistics/shipments/${sh.id}/codes`, { purpose: 'pickup' })).status, 404, 'courier cannot issue its own pickup code');
  const pc = ok(await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/codes`, { purpose: 'pickup' }), 'pickup code');
  assert.equal(pc.code.length, 8);
  assert.equal((await outsider.call('POST', `logistics/shipments/${sh.id}/pickup`, { code: pc.code })).status, 404);
  const pu = ok(await driver.call('POST', `logistics/shipments/${sh.id}/pickup`, { code: pc.code }), 'pickup');
  assert.equal(pu.custody, 'courier');
  // Offline retry of the same act returns the result, not a second handoff.
  const pu2 = ok(await driver.call('POST', `logistics/shipments/${sh.id}/pickup`, { code: pc.code }), 'pickup replay');
  assert.equal(pu2.replayed, true);
  assert.equal(await prisma.shipmentEvent.count({ where: { shipmentId: sh.id, toStatus: 'picked_up' } }), 1);

  // The courier's own word is never delivery: no code → refused; an "exception" is not delivery.
  assert.equal((await driver.call('POST', `logistics/shipments/${sh.id}/deliver`, { code: 'ZZZZZZZZ' })).body.code, 'code_invalid');
  ok(await driver.call('POST', `logistics/shipments/${sh.id}/step`, { step: 'depart' }));
  ok(await driver.call('POST', `logistics/shipments/${sh.id}/step`, { step: 'arrive_delivery' }));
  assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: x.po.id } })).status, 'fulfilment_requested', 'arrival is not delivery');

  // Receiving: every unit accounted for; 2 damaged, 1 missing.
  const productId = x.sup.product.id;
  const bad = await x.m.owner.call('POST', `logistics/shipments/${sh.id}/receiving`, { lines: [{ productId, received: 20 }] });
  assert.equal(bad.body.code, 'quantity_mismatch');
  assert.equal((await driver.call('POST', `logistics/shipments/${sh.id}/receiving`, { lines: [{ productId, received: 24 }] })).status, 404, 'the courier cannot sign the receiving');
  const loc = await ensurePrimaryInventoryLocation(x.m.b.id, prisma);
  const before = await stockAt(loc.id, productId);
  const rc = ok(await x.m.owner.call('POST', `logistics/shipments/${sh.id}/receiving`, { lines: [{ productId, received: 21, damaged: 2, missing: 1 }], note: 'carton abîmé' }), 'receiving');
  assert.equal(rc.receiving.outcome, 'partial');
  assert.equal(rc.shipment.status, 'delivered');
  assert.equal(rc.shipment.deliveryProof, 'receiver_receiving');
  const again = ok(await x.m.owner.call('POST', `logistics/shipments/${sh.id}/receiving`, { lines: [{ productId, received: 24 }] }));
  assert.equal(again.replayed, true);
  assert.equal(again.receiving.outcome, 'partial', 'the first record stands; a second cannot overwrite it');
  assert.equal((await stockAt(loc.id, productId)).onHand, before.onHand + 21, 'only received units credited, once');

  const po = await prisma.purchaseOrder.findUnique({ where: { id: x.po.id } });
  assert.equal(po.status, 'disputed');
  assert.match(po.deliveryRecordedBy, /^shipment:/);
  const view = ok(await x.m.owner.call('GET', `businesses/${x.m.b.id}/b2b/purchase-orders/${x.po.id}`));
  assert.equal(view.deliveryRecordedBy, 'verified_shipment');
  // Buyer can't bypass receiving via the J7 receive action (would skip the per-line record).
  // History is append-only; delivery is once.
  await assert.rejects(prisma.shipmentEvent.deleteMany({ where: { shipmentId: sh.id } }));
  await assert.rejects(prisma.receivingRecord.updateMany({ where: { shipmentId: sh.id }, data: { outcome: 'full' } }));
  await assert.rejects(prisma.shipment.update({ where: { id: sh.id }, data: { status: 'in_transit', custody: 'courier' } }), 'delivered is final');
  // After delivery the courier no longer sees the precise destination.
  const after = await driver.call('GET', `logistics/shipments/${sh.id}`);
  assert.ok(after.status === 404 || after.body.destination.precise === undefined);
});

test('courier-code delivery then full receiving → PO received; buyer receive shortcut refused for a carried order', async () => {
  const x = await readyPo(api, { packs: 1 }); // 12 units
  const driver = await fleetDriver(api, x.sup.b);
  ok(await adv(x, { to: 'fulfilment_requested', fulfilmentMode: 'seller_delivery', tracked: true }));
  const sh = await shipmentFor(x.po.id);
  ok(await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/assign`, { courierUserId: driver.id }));
  const pc = ok(await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/codes`, { purpose: 'pickup' }));
  ok(await driver.call('POST', `logistics/shipments/${sh.id}/pickup`, { code: pc.code }));
  // Receiver issues the delivery code; it is bound to this courier.
  const other = await fleetDriver(api, x.sup.b);
  const dc = ok(await x.m.owner.call('POST', `logistics/shipments/${sh.id}/codes`, { purpose: 'delivery' }));
  assert.equal((await other.call('POST', `logistics/shipments/${sh.id}/deliver`, { code: dc.code })).status, 404, 'another driver cannot use it');
  const dl = ok(await driver.call('POST', `logistics/shipments/${sh.id}/deliver`, { code: dc.code }));
  assert.equal(dl.status, 'delivered');
  assert.equal(dl.deliveryProof, 'receiver_challenge');
  assert.equal((await driver.call('POST', `logistics/shipments/${sh.id}/deliver`, { code: dc.code })).body.replayed, true);
  assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: x.po.id } })).status, 'delivered');
  const shortcut = await x.m.owner.call('POST', `businesses/${x.m.b.id}/b2b/purchase-orders/${x.po.id}/buyer`, { action: 'receive' });
  assert.equal(shortcut.body.code, 'received_by_shipment');
  const rc = ok(await x.m.owner.call('POST', `logistics/shipments/${sh.id}/receiving`, { lines: [{ productId: x.sup.product.id, received: 12 }] }));
  assert.equal(rc.receiving.outcome, 'full');
  assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: x.po.id } })).status, 'received');
  assert.equal(await prisma.shipmentEvent.count({ where: { shipmentId: sh.id, toStatus: 'delivered' } }), 1);
});

test('untracked seller delivery keeps the J7 seller-recorded path (honestly labelled); third party never creates a shipment', async () => {
  const x = await readyPo(api, { packs: 1 });
  ok(await adv(x, { to: 'fulfilment_requested', fulfilmentMode: 'seller_delivery' }));
  assert.equal(await shipmentFor(x.po.id), null);
  const d = ok(await adv(x, { to: 'delivered' }));
  assert.equal(d.deliveryRecordedBy, 'seller');
  const y = await readyPo(api, { packs: 1 });
  ok(await adv(y, { to: 'fulfilment_requested', fulfilmentMode: 'third_party', tracked: true }));
  assert.equal(await shipmentFor(y.po.id), null);
  // Jokko Logistics stays not activated unless explicitly enabled.
  const z = await readyPo(api, { packs: 1 });
  assert.equal((await adv(z, { to: 'fulfilment_requested', fulfilmentMode: 'jokko_logistics' })).body.code, 'fulfilment_not_activated');
});

test('failed delivery → return to the depot with a source code → stock re-credited and re-reserved once → PO back to ready → new shipment', async () => {
  const x = await readyPo(api, { packs: 1, stock: 120 });
  const driver = await fleetDriver(api, x.sup.b);
  ok(await adv(x, { to: 'fulfilment_requested', fulfilmentMode: 'seller_delivery', tracked: true }));
  const afterDispatch = await stockAt(x.sup.depot.id, x.sup.product.id);
  assert.deepEqual([afterDispatch.onHand, afterDispatch.reserved], [108, 0]);
  const sh = await shipmentFor(x.po.id);
  ok(await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/assign`, { courierUserId: driver.id }));
  const pc = ok(await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/codes`, { purpose: 'pickup' }));
  ok(await driver.call('POST', `logistics/shipments/${sh.id}/pickup`, { code: pc.code }));
  assert.equal((await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/cancel`, { reason: 'trop tard' })).body.code, 'invalid_state', 'no cancel once the goods left');
  const f = ok(await driver.call('POST', `logistics/shipments/${sh.id}/fail`, { reason: 'merchant_closed' }));
  assert.equal(f.custody, 'courier', 'a failure keeps custody with the courier');
  ok(await driver.call('POST', `logistics/shipments/${sh.id}/return/start`, {}));
  assert.equal((await driver.call('POST', `logistics/shipments/${sh.id}/return/complete`, { code: 'ABCDEFGH' })).body.code, 'code_invalid');
  const rc = ok(await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/codes`, { purpose: 'return_delivery' }));
  const done = ok(await driver.call('POST', `logistics/shipments/${sh.id}/return/complete`, { code: rc.code }));
  assert.equal(done.status, 'returned');
  assert.equal(done.custody, 'source');
  assert.equal((await driver.call('POST', `logistics/shipments/${sh.id}/return/complete`, { code: rc.code })).body.replayed, true);
  const back = await stockAt(x.sup.depot.id, x.sup.product.id);
  assert.deepEqual([back.onHand, back.reserved], [120, 12], 'back on hand and re-reserved for this order, once');
  assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: x.po.id } })).status, 'ready');
  // A new hand-off creates a NEW shipment (per attempt), and dispatch decrements again.
  ok(await adv(x, { to: 'fulfilment_requested', fulfilmentMode: 'seller_delivery', tracked: true }));
  const sh2 = await shipmentFor(x.po.id);
  assert.notEqual(sh2.id, sh.id);
  assert.equal((await stockAt(x.sup.depot.id, x.sup.product.id)).onHand, 108);
  // Cancel before pickup: J7 undoes its dispatch, PO back to ready.
  ok(await x.sup.owner.call('POST', `logistics/shipments/${sh2.id}/cancel`, { reason: 'client a reporté' }));
  const c = await stockAt(x.sup.depot.id, x.sup.product.id);
  assert.deepEqual([c.onHand, c.reserved], [120, 12]);
  assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: x.po.id } })).status, 'ready');
});

test('J8.18 tracked return: seller fleet collects from the buyer with the buyer’s code; seller receives per line; restock of received units only, once', async () => {
  const x = await readyPo(api, { packs: 2, stock: 120 });
  const driver = await fleetDriver(api, x.sup.b);
  ok(await adv(x, { to: 'fulfilment_requested', fulfilmentMode: 'seller_delivery', tracked: true }));
  const sh = await shipmentFor(x.po.id);
  ok(await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/assign`, { courierUserId: driver.id }));
  const pc = ok(await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/codes`, { purpose: 'pickup' }));
  ok(await driver.call('POST', `logistics/shipments/${sh.id}/pickup`, { code: pc.code }));
  ok(await driver.call('POST', `logistics/shipments/${sh.id}/step`, { step: 'arrive_delivery' }));
  ok(await x.m.owner.call('POST', `logistics/shipments/${sh.id}/receiving`, { lines: [{ productId: x.sup.product.id, received: 24 }] }));
  // Return one pack (12 units).
  const ret = ok(await x.m.owner.call('POST', `businesses/${x.m.b.id}/b2b/purchase-orders/${x.po.id}/returns`, { lines: [{ listingId: x.sup.listing.id, packs: 1 }], reason: 'date courte' }, { headers: { 'idempotency-key': `ret-${x.po.id}` } }));
  ok(await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/b2b/returns/${ret.id}/decide`, { approve: true }));
  ok(await x.m.owner.call('POST', `businesses/${x.m.b.id}/b2b/returns/${ret.id}/ship`, { tracked: true }));
  const rreq = await prisma.fulfilmentRequest.findUnique({ where: { sourceKey: `j7_return:${ret.id}:return` } });
  assert.ok(rreq, 'return shipment created');
  assert.equal(rreq.originBusinessId, x.m.b.id);
  const rsh = await prisma.shipment.findFirst({ where: { requestId: rreq.id } });
  // The seller cannot shortcut the tracked return.
  assert.equal((await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/b2b/returns/${ret.id}/receive`, { restock: true })).body.code, 'received_by_shipment');
  ok(await x.sup.owner.call('POST', `logistics/shipments/${rsh.id}/assign`, { courierUserId: driver.id }), 'seller’s own driver collects (internal-bound movement)');
  assert.equal((await x.sup.owner.call('POST', `logistics/shipments/${rsh.id}/codes`, { purpose: 'pickup' })).status, 404, 'the buyer (source of the return) issues the pickup code');
  const rpc = ok(await x.m.owner.call('POST', `logistics/shipments/${rsh.id}/codes`, { purpose: 'pickup' }));
  ok(await driver.call('POST', `logistics/shipments/${rsh.id}/pickup`, { code: rpc.code }));
  ok(await driver.call('POST', `logistics/shipments/${rsh.id}/step`, { step: 'arrive_delivery' }));
  assert.equal((await driver.call('POST', `logistics/shipments/${rsh.id}/receiving`, { lines: [{ productId: x.sup.product.id, received: 12 }] })).status, 404);
  const before = await stockAt(x.sup.depot.id, x.sup.product.id);
  const rc = ok(await x.sup.owner.call('POST', `logistics/shipments/${rsh.id}/receiving`, { lines: [{ productId: x.sup.product.id, received: 10, damaged: 2 }] }));
  assert.equal(rc.receiving.outcome, 'damaged');
  assert.equal((await stockAt(x.sup.depot.id, x.sup.product.id)).onHand, before.onHand + 10, 'restocks received units only');
  const r = await prisma.commercialReturn.findUnique({ where: { id: ret.id } });
  assert.equal(r.status, 'received');
  assert.equal(r.restocked, true);
  // Resolution (money) stays a J7 seller decision.
  ok(await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/b2b/returns/${ret.id}/resolve`, { resolution: 'none', note: 'remplacé au prochain passage' }));
});
