/**
 * Found by the authorization-boundary gate: the business order-cancel route
 * answered an idempotent REPLAY (200, order status / refund / stock) for an
 * already-cancelled order before checking the caller's authority. Authority
 * now comes first; only someone who may cancel the order sees the replay.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { business, customer, signedIn } from '../j3/helpers.js';
import { ensureBusinessWallet } from '../../lib/business-wallet-service.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
const key = () => ({ headers: { 'idempotency-key': `k-${crypto.randomBytes(8).toString('hex')}` } });

test('cancel replay on someone else’s cancelled order: 404 for strangers and other merchants, replay only for the owner', async () => {
  const ownerC = await customer();
  const owner = await signedIn(api, ownerC);
  const shop = await business(ownerC.user);
  await ensureBusinessWallet(shop.id, prisma);
  const buyerC = await customer();
  await fundUser(buyerC.id, 5000);
  const buyer = await signedIn(api, buyerC);
  const prod = await owner.call('POST', `businesses/${shop.id}/os/catalog`, { title: 'Savon', priceKori: 200, initialStock: 5 });
  const o = await buyer.call('POST', 'marketplace/orders', { businessId: shop.id, items: [{ productId: prod.body.id, quantity: 1 }], fulfillmentType: 'pickup' }, key());
  assert.equal(o.status, 201, JSON.stringify(o.body));
  const c = await owner.call('POST', `businesses/${shop.id}/os/orders/${o.body.orderId}/cancel`, { reason: 'rupture de stock' }, key());
  assert.ok(c.status < 300, JSON.stringify(c.body));

  const otherC = await customer();
  const other = await signedIn(api, otherC);
  const otherShop = await business(otherC.user);
  for (const path of [`businesses/${shop.id}/os/orders/${o.body.orderId}/cancel`, `businesses/${otherShop.id}/os/orders/${o.body.orderId}/cancel`]) {
    const r = await other.call('POST', path, { reason: 'tentative de rejeu' }, key());
    assert.equal(r.status, 404, `${path}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(!JSON.stringify(r.body).includes('replayed'));
  }
  const replay = await owner.call('POST', `businesses/${shop.id}/os/orders/${o.body.orderId}/cancel`, { reason: 'rupture de stock' }, key());
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
});
