/**
 * D41 — the legacy open-claim courier marketplace is closed to NEW usage by default:
 * no new task, no open claim, no listing, no hub last-mile. New consumer delivery
 * orders travel as VERIFIED J8 merchant-fulfilled shipments (the customer's code).
 * In-flight legacy tasks (fee already in escrow) still complete. Historical rows kept.
 */
import '../helpers/setup.js';
import crypto from 'node:crypto';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { assertLogisticsInvariants } from '../../lib/logistics/invariants.js';
import { business, customer, signedIn } from '../j3/helpers.js';

delete process.env.LEGACY_CONSUMER_DELIVERY_ENABLED;
let api;
before(async () => { api = await startApiServer({ LEGACY_CONSUMER_DELIVERY_ENABLED: '' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => {
  await assertInvariants(prisma);
  await assertLogisticsInvariants(prisma);
});

const ok = (r, what = '') => {
  assert.ok(r.status >= 200 && r.status < 300, `${what} ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const key = () => ({ headers: { 'idempotency-key': `k-${crypto.randomBytes(8).toString('hex')}` } });
async function driverUser() {
  const c = await customer();
  await prisma.accountRole.upsert({ where: { userId_role: { userId: c.id, role: 'driver' } }, create: { userId: c.id, role: 'driver', status: 'active' }, update: { status: 'active' } });
  return signedIn(api, c);
}

test('new legacy usage is refused: create, open claim, nearby listing; a historical open task stays untouched', async () => {
  const buyerC = await customer();
  await fundUser(buyerC.id, 5000);
  const buyer = await signedIn(api, buyerC);
  const r = await buyer.call('POST', 'deliveries', { pickupLabel: 'Boutique', pickupAddress: 'Rue 1', dropoffArea: 'Plateau', dropoffAddress: 'Rue 2' });
  assert.equal(r.status, 410);
  assert.equal(r.body.code, 'legacy_delivery_retired');
  // A historical open task (pre-D41 row).
  const order = await prisma.order.create({ data: { buyerId: buyerC.id, status: 'pending_delivery', totalAmount: 1500 } });
  const task = await prisma.deliveryTask.create({ data: { orderId: order.id, buyerId: buyerC.id, dropoffArea: 'Plateau', dropoffAddress: 'Rue 2', deliveryFeeNational: 1500, status: 'open' } });
  const rider = await driverUser();
  const before = (await prisma.wallet.findUnique({ where: { userId: buyerC.id } })).koriBalance;
  for (const p of [`deliveries/${task.id}/accept`, `deliveries/${task.id}/claim`]) {
    const a = await rider.call('POST', p, {}, key());
    assert.equal(a.status, 410, JSON.stringify(a.body));
  }
  assert.deepEqual(ok(await rider.call('GET', 'deliveries/nearby')), []);
  assert.equal((await prisma.wallet.findUnique({ where: { userId: buyerC.id } })).koriBalance, before, 'nothing taken into escrow');
  assert.equal((await prisma.deliveryTask.findUnique({ where: { id: task.id } })).status, 'open', 'history preserved');
});

test('an IN-FLIGHT legacy task (fee already in escrow) still completes: pickup → deliver → buyer confirms → rider paid once', async () => {
  process.env.LEGACY_CONSUMER_DELIVERY_ENABLED = 'true';
  const { createDeliveryTask, acceptDelivery } = await import('../../lib/delivery-service.js');
  const buyerC = await customer();
  await fundUser(buyerC.id, 5000);
  const buyer = await signedIn(api, buyerC);
  const rider = await driverUser();
  const order = await prisma.order.create({ data: { buyerId: buyerC.id, status: 'pending_delivery', totalAmount: 1500 } });
  const task = await prisma.$transaction((tx) => createDeliveryTask(tx, { orderId: order.id, buyerId: buyerC.id, dropoffArea: 'Plateau', dropoffAddress: 'Rue 2', deliveryFeeNational: 1500 }));
  await acceptDelivery(prisma, { taskId: task.id, riderId: rider.id, reference: `DACC-${crypto.randomBytes(4).toString('hex')}` });
  delete process.env.LEGACY_CONSUMER_DELIVERY_ENABLED; // the switch is off from here on: only the in-flight obligation remains
  const w0 = (await prisma.wallet.findUnique({ where: { userId: rider.id } })).koriBalance;
  ok(await rider.call('POST', `deliveries/${task.id}/pickup`, {}));
  ok(await rider.call('POST', `deliveries/${task.id}/deliver`, {}));
  ok(await buyer.call('POST', `deliveries/${task.id}/confirm`, {}));
  assert.equal((await prisma.wallet.findUnique({ where: { userId: rider.id } })).koriBalance, w0 + 150, 'paid exactly the escrowed fee, once');
  assert.equal((await buyer.call('POST', `deliveries/${task.id}/confirm`, {})).status >= 400, true);
});

test('new consumer delivery order → verified J8 merchant-fulfilled shipment; merchant cannot self-declare delivered; customer code delivers; cancel before pickup cancels the shipment', async () => {
  const ownerC = await customer();
  const fulfil = await customer();
  const b = await business(ownerC.user, [{ user: fulfil.user, role: 'fulfillment' }]);
  const owner = await signedIn(api, ownerC);
  const staff = await signedIn(api, fulfil);
  const item = ok(await owner.call('POST', `businesses/${b.id}/os/catalog`, { title: 'Thiéboudienne', priceKori: 300, initialStock: 10 }));
  const buyerC = await customer();
  await fundUser(buyerC.id, 3000);
  const buyer = await signedIn(api, buyerC);
  const o = ok(await buyer.call('POST', 'marketplace/orders', { businessId: b.id, items: [{ productId: item.id, quantity: 2 }], fulfillmentType: 'delivery', dropoff: { area: 'Médina', address: 'Rue 11 x 6' } }, key()));
  assert.equal(await prisma.deliveryTask.count({ where: { orderId: o.orderId } }), 0, 'no legacy open-claim task');
  const req = await prisma.fulfilmentRequest.findFirst({ where: { sourceSystem: 'jokko_order', sourceId: o.orderId } });
  assert.equal(req.fulfilmentOwner, 'MERCHANT_FULFILLED');
  assert.equal(req.feeKori, 0, 'no courier fee taken');
  const sh = await prisma.shipment.findFirst({ where: { requestId: req.id } });
  // The customer sees it (area only).
  const mine = ok(await buyer.call('GET', 'logistics/shipments/mine'));
  assert.equal(mine.items[0].id, sh.id);
  assert.equal(mine.items[0].destination.precise, undefined);
  const P = `businesses/${b.id}/os/orders/${o.orderId}/status`;
  ok(await staff.call('POST', P, { status: 'preparing' }));
  ok(await staff.call('POST', P, { status: 'out_for_delivery' }));
  assert.equal((await staff.call('POST', P, { status: 'delivered' })).body.code, 'delivered_by_shipment', 'D34: the merchant’s word is not proof');
  ok(await owner.call('POST', `logistics/shipments/${sh.id}/assign`, { courierUserId: staff.id }));
  const pc = ok(await owner.call('POST', `logistics/shipments/${sh.id}/codes`, { purpose: 'pickup' }));
  ok(await staff.call('POST', `logistics/shipments/${sh.id}/pickup`, { code: pc.code }));
  const dc = ok(await buyer.call('POST', `logistics/shipments/${sh.id}/codes`, { purpose: 'delivery' }));
  ok(await staff.call('POST', `logistics/shipments/${sh.id}/deliver`, { code: dc.code }));
  assert.equal((await prisma.order.findUnique({ where: { id: o.orderId } })).status, 'delivered');
  // Cancel before pickup cancels the shipment with the order (refund + stock back as before).
  const o2 = ok(await buyer.call('POST', 'marketplace/orders', { businessId: b.id, items: [{ productId: item.id, quantity: 1 }], fulfillmentType: 'delivery', dropoff: { area: 'Médina', address: 'Rue 11 x 6' } }, key()));
  ok(await owner.call('POST', `businesses/${b.id}/os/orders/${o2.orderId}/cancel`, { reason: 'rupture' }));
  const r2 = await prisma.fulfilmentRequest.findFirst({ where: { sourceSystem: 'jokko_order', sourceId: o2.orderId } });
  assert.equal(r2.status, 'cancelled');
  assert.equal((await prisma.shipment.findFirst({ where: { requestId: r2.id } })).status, 'cancelled');
});

test('hub parcel last mile is closed (pickup at the point stays)', async () => {
  const ownerC = await customer();
  const owner = await signedIn(api, ownerC);
  const hc = crypto.randomBytes(3).toString('hex');
  const hub = await prisma.deliveryHub.create({ data: { name: `Point ${hc}`, code: `PT-${hc}`, address: 'Rue 3', city: 'Dakar', lat: 14.7, lng: -17.4 } });
  const parcel = await prisma.hubParcel.create({ data: { reference: `HP-${crypto.randomBytes(3).toString('hex')}`, ownerId: ownerC.id, hubId: hub.id, status: 'at_hub', originCountry: 'FR', description: 'Colis', pickupCode: '123456' } });
  const r = await owner.call('POST', `hubs/parcels/${parcel.id}/last-mile`, { area: 'Plateau', address: 'Rue 4' });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'last_mile_not_available');
  const stranger = await signedIn(api, await customer());
  assert.equal((await stranger.call('POST', `hubs/parcels/${parcel.id}/last-mile`, { area: 'Plateau', address: 'Rue 4' })).status, 403, 'authorization still comes first');
});
