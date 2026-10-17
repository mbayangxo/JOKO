/**
 * J8.0 legacy courier-marketplace fixes (the pre-J8 delivery engine stays in
 * service for consumer orders, so its unsafe primitives are replaced):
 *  1. a courier's own "delivered" tap + silence no longer pays the courier;
 *  2. the delivery fee is server-authoritative;
 *  3. a courier cannot carry a delivery they are a party to;
 *  6. a merchant cannot declare delivery while a courier holds the order.
 * (4 and 5, hub parcels, are in tests/integration/hub-parcel-flow.test.js.)
 * D31: new legacy-channel B2B orders are refused by default.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { business, customer, signedIn } from '../j3/helpers.js';
import { ensureBusinessWallet } from '../../lib/business-wallet-service.js';
import { processAutoReleases } from '../../lib/delivery-service.js';
// D41: the legacy open-claim courier marketplace is off by default; these tests cover it explicitly re-enabled.
process.env.LEGACY_CONSUMER_DELIVERY_ENABLED = 'true';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const key = () => ({ headers: { 'idempotency-key': `k-${crypto.randomBytes(8).toString('hex')}` } });
const bal = async (id) => (await prisma.wallet.findUnique({ where: { userId: id } })).koriBalance;
async function courier() {
  const c = await customer();
  await prisma.accountRole.upsert({ where: { userId_role: { userId: c.id, role: 'driver' } }, create: { userId: c.id, role: 'driver', status: 'active' }, update: { status: 'active' } });
  return signedIn(api, c);
}
async function buyer(kori = 5000) {
  const c = await customer();
  await fundUser(c.id, kori);
  return signedIn(api, c);
}

test('fee is server-authoritative: a client-sent fee is refused; the server fee is what the courier is held/paid', async () => {
  const b = await buyer();
  const forged = await b.call('POST', 'deliveries', { pickupLabel: 'Boutique', pickupAddress: 'Rue 1', dropoffArea: 'Plateau', dropoffAddress: 'Rue 2', deliveryFeeNational: 1 });
  assert.equal(forged.status, 400);
  assert.equal(forged.body.code, 'fee_not_client_settable');
  const big = await b.call('POST', 'deliveries', { pickupLabel: 'Boutique', pickupAddress: 'Rue 1', dropoffArea: 'Plateau', dropoffAddress: 'Rue 2', deliveryFeeNational: 999_999 });
  assert.equal(big.status, 400);
  const ok = await b.call('POST', 'deliveries', { pickupLabel: 'Boutique', pickupAddress: 'Rue 1', dropoffArea: 'Plateau', dropoffAddress: 'Rue 2' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((await prisma.deliveryTask.findUnique({ where: { id: ok.body.id } })).deliveryFeeNational, 1500);
});

test('courier self-dealing refused: the buyer cannot carry their own delivery; the seller (owner or staff) cannot carry their own order', async () => {
  const b = await buyer();
  await prisma.accountRole.create({ data: { userId: b.id, role: 'driver', status: 'active' } });
  const d = await b.call('POST', 'deliveries', { pickupLabel: 'Boutique', pickupAddress: 'Rue 1', dropoffArea: 'Plateau', dropoffAddress: 'Rue 2' });
  const self = await b.call('POST', `deliveries/${d.body.id}/accept`, {}, key());
  assert.equal(self.status, 403, JSON.stringify(self.body));
  assert.equal(await prisma.deliveryEscrow.count({ where: { deliveryTaskId: d.body.id } }), 0);

  const ownerC = await customer();
  const owner = await signedIn(api, ownerC);
  const shop = await business(ownerC.user);
  await ensureBusinessWallet(shop.id, prisma);
  const prod = await owner.call('POST', `businesses/${shop.id}/os/catalog`, { title: 'Riz', priceKori: 100, initialStock: 10 });
  const b2 = await buyer();
  const o = await b2.call('POST', 'marketplace/orders', { businessId: shop.id, items: [{ productId: prod.body.id, quantity: 1 }], fulfillmentType: 'delivery', dropoff: { area: 'Médina', address: 'Rue 22' } }, key());
  assert.equal(o.status, 201, JSON.stringify(o.body));
  const task = await prisma.deliveryTask.findUnique({ where: { orderId: o.body.orderId } });
  await prisma.accountRole.create({ data: { userId: ownerC.id, role: 'driver', status: 'active' } });
  assert.equal((await owner.call('POST', `deliveries/${task.id}/accept`, {}, key())).status, 403, 'seller owner');
  const staffC = await customer();
  await prisma.businessMember.create({ data: { businessId: shop.id, userId: staffC.id, role: 'fulfillment', status: 'active', acceptedAt: new Date() } });
  await prisma.accountRole.create({ data: { userId: staffC.id, role: 'driver', status: 'active' } });
  const staff = await signedIn(api, staffC);
  assert.equal((await staff.call('POST', `deliveries/${task.id}/accept`, {}, key())).status, 403, 'seller staff');
  const c = await courier();
  assert.equal((await c.call('POST', `deliveries/${task.id}/accept`, {}, key())).status, 201, 'an independent courier can');

  // 6. The merchant can no longer declare it out for delivery / delivered while the courier holds it.
  assert.equal((await owner.call('POST', `businesses/${shop.id}/os/orders/${o.body.orderId}/status`, { status: 'preparing' })).status, 200);
  const ofd = await owner.call('POST', `businesses/${shop.id}/os/orders/${o.body.orderId}/status`, { status: 'out_for_delivery' });
  assert.equal(ofd.status, 409, JSON.stringify(ofd.body));
  assert.equal(ofd.body.code, 'courier_custody');
  await c.call('POST', `deliveries/${task.id}/pickup`, {}); // the courier's pickup moves the order out for delivery
  assert.equal((await prisma.order.findUnique({ where: { id: o.body.orderId } })).status, 'out_for_delivery');
  const del = await owner.call('POST', `businesses/${shop.id}/os/orders/${o.body.orderId}/status`, { status: 'delivered' });
  assert.equal(del.status, 409, JSON.stringify(del.body));
  assert.equal(del.body.code, 'courier_custody');
});

test('no payment on the courier’s own "delivered" tap: silence escalates to operator review, escrow stays held; buyer confirmation still pays once', async () => {
  const b = await buyer();
  const c = await courier();
  const d = await b.call('POST', 'deliveries', { pickupLabel: 'Boutique', pickupAddress: 'Rue 1', dropoffArea: 'Plateau', dropoffAddress: 'Rue 2' });
  await c.call('POST', `deliveries/${d.body.id}/accept`, {}, key());
  await c.call('POST', `deliveries/${d.body.id}/pickup`, {});
  const del = await c.call('POST', `deliveries/${d.body.id}/deliver`, {});
  assert.equal(del.status, 200);
  const before = await bal(c.id);
  await prisma.deliveryTask.update({ where: { id: d.body.id }, data: { autoReleaseAt: new Date(Date.now() - 1000) } });
  const res = await processAutoReleases(prisma);
  assert.ok(res.some((r) => r.taskId === d.body.id && r.action === 'escalated_to_review'));
  assert.equal(await bal(c.id), before, 'courier NOT paid on self-report + silence');
  const t = await prisma.deliveryTask.findUnique({ where: { id: d.body.id }, include: { escrow: true, dispute: true } });
  assert.deepEqual({ task: t.status, escrow: t.escrow.status, dispute: t.dispute.status }, { task: 'disputed', escrow: 'disputed_held', dispute: 'under_review' });
  await processAutoReleases(prisma);
  assert.equal(await prisma.deliveryDispute.count({ where: { deliveryTaskId: d.body.id } }), 1, 'escalated once');

  // A confirmed delivery still pays the courier exactly once.
  const d2 = await b.call('POST', 'deliveries', { pickupLabel: 'Boutique', pickupAddress: 'Rue 1', dropoffArea: 'Plateau', dropoffAddress: 'Rue 2' });
  await c.call('POST', `deliveries/${d2.body.id}/accept`, {}, key());
  await c.call('POST', `deliveries/${d2.body.id}/pickup`, {});
  await c.call('POST', `deliveries/${d2.body.id}/deliver`, {});
  const before2 = await bal(c.id);
  const conf = await b.call('POST', `deliveries/${d2.body.id}/confirm`, {});
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  assert.equal(await bal(c.id), before2 + 150);
  assert.ok((await b.call('POST', `deliveries/${d2.body.id}/confirm`, {})).status >= 400, 'paid once');
});

test('D31: new legacy-channel B2B orders are refused (purchase orders are the canonical path)', async () => {
  const ownerC = await customer();
  const owner = await signedIn(api, ownerC);
  const shop = await business(ownerC.user);
  const prod = await owner.call('POST', `businesses/${shop.id}/os/catalog`, { title: 'Huile', priceKori: 100, initialStock: 10 });
  const b = await buyer();
  const r = await b.call('POST', 'marketplace/orders', { businessId: shop.id, items: [{ productId: prod.body.id, quantity: 1 }], fulfillmentType: 'pickup', channel: 'b2b', paymentTerm: 'immediate' }, key());
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'b2b_use_purchase_orders');
  const consumer = await b.call('POST', 'marketplace/orders', { businessId: shop.id, items: [{ productId: prod.body.id, quantity: 1 }], fulfillmentType: 'pickup' }, key());
  assert.equal(consumer.status, 201, 'consumer orders unaffected');
});
