/**
 * Phase 12 (commerce) + Phase 13 (delivery) — real HTTP, NODE_ENV=production.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

import { createUserWithWallet, createVerifiedDevice, prisma } from '../helpers/db.js';
import { freshIp, startApiServer } from '../helpers/http-harness.js';

const ACCESS_SECRET = 'http-test-access-secret-0123456789';
let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });

async function actor(koriBalance = 0) {
  const user = await createUserWithWallet({ koriBalance, tier: 2 });
  const device = await createVerifiedDevice(user.id);
  return { user, id: user.id, device, token: jwt.sign({ sub: user.id, type: 'access' }, ACCESS_SECRET), ip: freshIp() };
}
const as = (a) => ({ token: a.token, device: a.device, ip: a.ip, headers: { 'x-vercel-ip-country': 'SN' } });
const bal = async (a) => (await prisma.wallet.findUnique({ where: { userId: a.id } })).koriBalance;
const call = (m, p, a, body) => api.client(m, p, { ...as(a), body });

async function shop(inventory = 1, price = 300) {
  const owner = await actor();
  const biz = (await call('POST', 'businesses', owner, { name: `Shop ${crypto.randomBytes(3).toString('hex')}`, type: 'merchant' })).body;
  const prod = (await call('POST', 'products', owner, { businessId: biz.id, title: 'Item', price, inventory, trackInventory: true })).body;
  return { owner, biz, prod };
}
const order = (buyer, s, extra = {}) =>
  call('POST', 'marketplace/orders', buyer, { businessId: s.biz.id, items: [{ productId: s.prod.id, quantity: 1 }], fulfillmentType: 'pickup', ...extra });

test('last item: concurrent checkout sells it once; server price wins over client price', async () => {
  const s = await shop(1, 300);
  const [b1, b2] = [await actor(1000), await actor(1000)];
  const rs = await Promise.all([b1, b2].map((b) => call('POST', 'marketplace/orders', b, {
    businessId: s.biz.id, items: [{ productId: s.prod.id, quantity: 1, price: 1, unitPrice: 1 }], fulfillmentType: 'pickup',
  })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 400]);
  assert.equal(rs.find((r) => r.status === 201).body.totalKori, 300);
  assert.equal((await bal(b1)) + (await bal(b2)), 1700);
  assert.equal((await prisma.product.findUnique({ where: { id: s.prod.id } })).inventory, 0);
});

test('b2c buyer cannot self-grant credit (net30 / cod) — no unpaid order, no stock reserved', async () => {
  const s = await shop(5, 500);
  const broke = await actor(0);
  for (const paymentTerm of ['net30', 'net15', 'monthly', 'cod']) {
    const r = await order(broke, s, { paymentTerm });
    assert.equal(r.status, 400, `${paymentTerm}: ${JSON.stringify(r.body)}`);
  }
  assert.equal(await prisma.order.count({ where: { buyerId: broke.id } }), 0);
  assert.equal((await prisma.product.findUnique({ where: { id: s.prod.id } })).inventory, 5);
});

test('b2b net terms require an agreed trade account with a credit limit', async () => {
  const s = await shop(5, 500);
  const pro = await actor(0);
  const r = await order(pro, s, { channel: 'b2b', paymentTerm: 'net30' });
  assert.equal(r.status, 400);
  assert.equal(await prisma.order.count({ where: { buyerId: pro.id } }), 0);
});

test('order status: buyer cannot drive merchant transitions; stranger cannot read', async () => {
  const s = await shop(3, 100);
  const buyer = await actor(500);
  const o = await order(buyer, s, { fulfillmentType: 'delivery', dropoff: { area: 'Plateau', address: 'Rue 9' } });
  assert.equal(o.status, 201);
  assert.equal((await call('PATCH', `marketplace/orders/${o.body.orderId}/status`, buyer, { status: 'preparing' })).status, 403);
  const stranger = await actor();
  assert.equal((await call('GET', `marketplace/orders/${o.body.orderId}`, stranger)).status, 403);
  assert.equal((await call('PATCH', `marketplace/orders/${o.body.orderId}/status`, s.owner, { status: 'preparing' })).status, 200);
});

test('delivery: only an onboarded courier can accept; accepting never grants the role', async () => {
  const s = await shop(3, 100);
  const buyer = await actor(1000);
  const o = await order(buyer, s, { fulfillmentType: 'delivery', dropoff: { area: 'Plateau', address: 'Rue 9' } });
  const taskId = o.body.delivery.id;
  const random = await actor();
  const r = await call('POST', `deliveries/${taskId}/accept`, random);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'driver_required');
  assert.equal(await prisma.accountRole.count({ where: { userId: random.id, role: 'driver' } }), 0);
  assert.equal(await bal(buyer), 900, 'no escrow taken');

  const courier = await actor();
  await prisma.accountRole.create({ data: { userId: courier.id, role: 'personal' } }); // as every real signup
  assert.equal((await call('POST', 'workers/profile', courier, { modes: ['delivery'] })).status, 201);
  assert.equal((await call('POST', 'drivers/profile', courier, { vehicle: 'moto' })).status, 201);
  const ok = await call('POST', `deliveries/${taskId}/accept`, courier);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(await bal(buyer), 750, 'fee 1 500 XOF = 150 ₭ escrowed once');
  assert.equal((await call('POST', `deliveries/${taskId}/confirm`, courier)).status, 403, 'courier cannot release own escrow');
  assert.equal((await call('POST', `deliveries/${taskId}/deliver`, random)).status, 403);
});
