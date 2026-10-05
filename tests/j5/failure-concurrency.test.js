/**
 * J5 — failure and concurrency (brief §P) plus the remaining adversarial
 * cases (§O): lost responses, retries, mid-order failure, duplicate
 * payments/refunds, offline merchant devices, wallet enumeration, media
 * hijacking. Money, order state and stock must reconcile after each.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { placeMarketplaceOrder } from '../../lib/marketplace-service.js';
import { business, customer, signedIn } from '../j3/helpers.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const key = () => `intent-${crypto.randomBytes(8).toString('hex')}`;
const walletOf = async (userId) => (await prisma.wallet.findUnique({ where: { userId } })).koriBalance;
const bizBalance = async (id) => Number((await prisma.ledgerAccount.findUnique({ where: { code: `business:${id}:wallet` } }))?.balance ?? 0);

async function shop(roles = ['manager', 'fulfillment']) {
  const owner = await customer();
  const people = {};
  for (const r of roles) people[r] = await customer();
  const b = await business(owner.user, roles.map((r) => ({ user: people[r].user, role: r })));
  const s = { owner: await signedIn(api, owner) };
  for (const r of roles) s[r] = await signedIn(api, people[r]);
  const add = async (body) => (await s.owner.call('POST', `businesses/${b.id}/os/catalog`, body)).body;
  return { b, s, add, P: `businesses/${b.id}/os` };
}
async function buyer(kori = 3000) {
  const c = await customer({ koriBalance: 0 });
  await fundUser(c.id, kori);
  return signedIn(api, c);
}

test('order retried with the same intent key (lost response, double tap, app restart) → one order, one debit, one stock decrement', async () => {
  const { b, add } = await shop([]);
  const p = await add({ title: 'Lait caillé', priceKori: 150, initialStock: 10 });
  const u = await buyer(1000);
  const k = key();
  const body = { businessId: b.id, items: [{ productId: p.id, quantity: 2 }], fulfillmentType: 'pickup' };
  const rs = await Promise.all([1, 2, 3].map(() => u.call('POST', 'marketplace/orders', body, { headers: { 'idempotency-key': k } })));
  const ok = rs.filter((r) => r.status === 201);
  assert.ok(ok.length >= 1, JSON.stringify(rs.map((r) => [r.status, r.body])));
  assert.ok(rs.every((r) => [201, 409].includes(r.status)), 'duplicates are either the replay or "in progress" — never a second order');
  const later = await u.call('POST', 'marketplace/orders', body, { headers: { 'idempotency-key': k } });
  assert.equal(later.status, 201);
  assert.equal(later.body.orderId, ok[0].body.orderId, 'the replay names the same order');
  assert.equal(await prisma.order.count({ where: { businessId: b.id } }), 1);
  assert.equal(await walletOf(u.id), 700);
  assert.equal((await prisma.product.findUnique({ where: { id: p.id } })).inventory, 8);
  const intent = await u.call('GET', `money/intents/${k}`);
  assert.equal(intent.body.state, 'completed');
});

test('failure in the middle of an order (second line out of stock after the payment step) rolls back everything', async () => {
  const { b, add } = await shop([]);
  const a = await add({ title: 'Article A', priceKori: 100, initialStock: 5 });
  const c = await add({ title: 'Article C', priceKori: 100, initialStock: 1 });
  const u = await buyer(1000);
  // Two lines of the same 1-unit product: each passes the pre-check, the
  // second guarded decrement fails INSIDE the transaction, after the payment
  // and the first line were applied — everything must roll back.
  await assert.rejects(
    placeMarketplaceOrder(prisma, { buyerId: u.id, businessId: b.id, items: [{ productId: a.id, quantity: 1 }, { productId: c.id, quantity: 1 }, { productId: c.id, quantity: 1 }], fulfillmentType: 'pickup', reference: `MID-${crypto.randomBytes(4).toString('hex')}` }),
  );
  assert.equal(await walletOf(u.id), 1000, 'no money moved');
  assert.equal(await bizBalance(b.id), 0);
  assert.equal(await prisma.order.count({ where: { businessId: b.id } }), 0, 'no order');
  assert.equal((await prisma.product.findUnique({ where: { id: a.id } })).inventory, 5, 'no stock moved');
  assert.equal(await prisma.stockMovement.count({ where: { productId: { in: [a.id, c.id] }, reason: 'sale' } }), 0);
});

test('refund response lost: retry with the same key replays; a fresh key is still one refund (deterministic reference)', async () => {
  const { b, s, add, P } = await shop();
  const p = await add({ title: 'Jus de gingembre', priceKori: 80, initialStock: 10 });
  const u = await buyer(1000);
  const o = await u.call('POST', 'marketplace/orders', { businessId: b.id, items: [{ productId: p.id, quantity: 1 }], fulfillmentType: 'pickup' }, { headers: { 'idempotency-key': key() } });
  for (const st of ['preparing', 'ready_for_pickup']) await s.fulfillment.call('POST', `${P}/orders/${o.body.orderId}/status`, { status: st });
  await u.call('POST', `marketplace/orders/${o.body.orderId}/confirm`, {});
  const k = key();
  const r1 = await s.manager.call('POST', `${P}/orders/${o.body.orderId}/refund`, { reason: 'bouteille cassée' }, { headers: { 'idempotency-key': k } });
  const r2 = await s.manager.call('POST', `${P}/orders/${o.body.orderId}/refund`, { reason: 'bouteille cassée' }, { headers: { 'idempotency-key': k } });
  const r3 = await s.manager.call('POST', `${P}/orders/${o.body.orderId}/refund`, { reason: 'bouteille cassée' }, { headers: { 'idempotency-key': key() } });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r2.status, 200);
  assert.equal(r2.body.refund.reference, r1.body.refund.reference, 'same-key retry replays the same refund');
  assert.equal(r3.body.replayed, true);
  assert.equal(await walletOf(u.id), 1000);
  assert.equal(await prisma.journalEntry.count({ where: { kind: 'merchant_refund', metadata: { path: ['orderId'], equals: o.body.orderId } } }), 1);
});

test('offline merchant device: a repeated status move cannot apply twice; stale state is refused, not re-applied', async () => {
  const { b, s, add, P } = await shop();
  const p = await add({ title: 'Beignets', priceKori: 10, initialStock: 100 });
  const u = await buyer();
  const o = await u.call('POST', 'marketplace/orders', { businessId: b.id, items: [{ productId: p.id, quantity: 1 }], fulfillmentType: 'pickup' }, { headers: { 'idempotency-key': key() } });
  const rs = await Promise.all([1, 2, 3].map(() => s.fulfillment.call('POST', `${P}/orders/${o.body.orderId}/status`, { status: 'preparing' })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs.map((r) => r.status)));
  assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409));
  // A queued "cancel" from a device that had not seen "preparing" is applied against the CURRENT state only.
  await s.fulfillment.call('POST', `${P}/orders/${o.body.orderId}/status`, { status: 'ready_for_pickup' });
  await u.call('POST', `marketplace/orders/${o.body.orderId}/confirm`, {});
  assert.equal((await s.manager.call('POST', `${P}/orders/${o.body.orderId}/cancel`, { reason: 'file hors ligne' })).status, 409, 'a completed order cannot be cancelled by a stale queued action');
});

test('duplicate payment of a QR charge by the same payer (two taps, two keys) debits once', async () => {
  const { b, s } = await shop(['manager']);
  const ch = await s.manager.call('POST', 'money/charges', { businessId: b.id, amountKori: 120 });
  const u = await buyer(500);
  const rs = await Promise.all([1, 2].map(() => u.call('POST', `money/charges/${ch.body.code}/pay`, { expectedAmountKori: 120 }, { headers: { 'idempotency-key': key() } })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 201]);
  assert.equal(await walletOf(u.id), 380);
  assert.equal(await bizBalance(b.id), 120);
});

test('business-wallet enumeration and media hijacking are refused', async () => {
  const mine = await shop(['manager']);
  const theirs = await shop([]);
  const snoop = mine.s.manager;
  for (const path of [`businesses/${theirs.b.id}/wallet`, `businesses/${theirs.b.id}/os/money`, `businesses/${theirs.b.id}/os/analytics`, `businesses/${theirs.b.id}/os/customers`, `businesses/${theirs.b.id}/os/orders`]) {
    const r = await snoop.call('GET', path);
    assert.ok([403, 404].includes(r.status), `${path} → ${r.status}`);
    assert.ok(!/availableKori|balance"/.test(JSON.stringify(r.body)), path);
  }
  for (const bad of ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'mbolo/private/user123/photo.jpg', 'http://insecure.example/x.png']) {
    assert.equal((await mine.s.owner.call('POST', `${mine.P}/catalog`, { title: 'Img', priceKori: 10, imageUrl: bad })).status, 400, bad);
    assert.equal((await mine.s.owner.call('PATCH', `${mine.P}/profile`, { imageUrl: bad })).status, 400, bad);
  }
  assert.equal((await mine.s.owner.call('POST', `${mine.P}/catalog`, { title: 'Img ok', priceKori: 10, imageUrl: 'https://cdn.example.com/a.png' })).status, 201);
  assert.equal((await mine.s.owner.call('POST', `${mine.P}/catalog`, { title: 'Img data', priceKori: 10, imageUrl: 'data:image/png;base64,iVBORw0KGgo=' })).status, 201);
  // Editing another business's product through my business path is refused.
  const foreign = await theirs.add({ title: 'Pas à moi', priceKori: 10, initialStock: 1 });
  assert.equal((await mine.s.owner.call('PATCH', `${mine.P}/catalog/${foreign.id}`, { priceKori: 1 })).status, 404);
  assert.equal((await mine.s.owner.call('POST', `${mine.P}/stock/${foreign.id}/adjust`, { delta: 100, note: 'vol' })).status, 404);
  assert.equal((await prisma.product.findUnique({ where: { id: foreign.id } })).price, 10);
});
