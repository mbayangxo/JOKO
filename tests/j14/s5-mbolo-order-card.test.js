/**
 * J14-S5 — Mbolo order-from-conversation (seller order card), real HTTP, production mode.
 * Seller confirmation by construction; server prices; stock committed; payment ONLY through the existing
 * charge flow (expected amount + idempotency key); the payment confirms the order atomically; only the buyer
 * of the thread can pay; cancellation closes the charge (unpaid) or refunds exactly once (paid).
 * J2 invariants after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { ensureBusinessWallet } from '../../lib/business-wallet-service.js';
import { business, customer, signedIn } from '../j3/helpers.js';
import { idemH } from '../j7/fixture.js';

let api;
before(async () => { api = await startApiServer({ MBOLO_ORDER_CARD_ENABLED: 'true' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const key = () => `req_${crypto.randomBytes(8).toString('hex')}`;
const kori = async (userId) => (await prisma.wallet.findUnique({ where: { userId } })).koriBalance;
const bizBal = async (id) => (await prisma.businessWallet.findUnique({ where: { businessId: id } }))?.balance ?? 0;

async function setup({ stock = 10, price = 700 } = {}) {
  const ownerC = await customer();
  const seller = await signedIn(api, ownerC);
  const shop = await business(ownerC.user);
  await ensureBusinessWallet(shop.id, prisma);
  const p = await prisma.product.create({ data: { businessId: shop.id, title: 'Bissap 1 L', price, inventory: stock, trackInventory: true } });
  const buyerC = await customer();
  await fundUser(buyerC.id, 10_000);
  const buyer = await signedIn(api, buyerC);
  const thread = await prisma.mboloThread.create({ data: { creatorId: ownerC.id, name: 'dm', type: 'direct', members: { create: [{ userId: ownerC.id }, { userId: buyerC.id }] } } });
  const card = (body = {}) => seller.call('POST', `mbolo/threads/${thread.id}/order-card`, { businessId: shop.id, lines: [{ productId: p.id, quantity: 2 }], requestKey: key(), ...body });
  return { ownerC, seller, shop, p, buyerC, buyer, thread, card };
}

test('disabled by default', async () => {
  const off = await startApiServer();
  try {
    const o = await customer();
    const s = await signedIn(off, o);
    const r = await s.call('POST', 'mbolo/threads/x/order-card', { businessId: 'b', lines: [{ productId: 'p', quantity: 1 }], requestKey: key() });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'disabled');
  } finally {
    await off.stop();
  }
});

test('seller composes → server-priced pending order + charge card (code only); buyer pays via the charge flow → order confirmed atomically', async () => {
  const x = await setup();
  const r = await x.card();
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.totalKori, 1400, 'server price × qty, never a client amount');
  const order = await prisma.order.findUnique({ where: { id: r.body.orderId } });
  assert.deepEqual([order.status, order.paymentStatus, order.sourceChannel, order.buyerId, order.mboloThreadId], ['pending_payment', 'pending', 'mbolo', x.buyerC.id, x.thread.id]);
  assert.equal((await prisma.product.findUnique({ where: { id: x.p.id } })).inventory, 8, 'stock committed by the seller');
  const msg = await prisma.mboloMessage.findUnique({ where: { id: r.body.messageId } });
  assert.deepEqual(JSON.parse(msg.mediaUrl), { type: 'charge_card', code: r.body.chargeCode, version: '2026-10-j14' }, 'the card carries the code only');

  const [b0, s0] = [await kori(x.buyerC.id), await bizBal(x.shop.id)];
  const wrong = await x.buyer.call('POST', `money/charges/${r.body.chargeCode}/pay`, { expectedAmountKori: 1000 }, idemH());
  assert.ok(wrong.status >= 400);
  assert.equal((await prisma.order.findUnique({ where: { id: order.id } })).status, 'pending_payment', 'a refused payment leaves the order unpaid');
  const h = idemH();
  const pay = await x.buyer.call('POST', `money/charges/${r.body.chargeCode}/pay`, { expectedAmountKori: 1400 }, h);
  assert.ok(pay.status < 300, JSON.stringify(pay.body));
  const replay = await x.buyer.call('POST', `money/charges/${r.body.chargeCode}/pay`, { expectedAmountKori: 1400 }, h);
  assert.ok(replay.status < 300);
  assert.equal(await kori(x.buyerC.id), b0 - 1400, 'paid exactly once');
  assert.equal(await bizBal(x.shop.id), s0 + 1400);
  const paid = await prisma.order.findUnique({ where: { id: order.id } });
  assert.deepEqual([paid.status, paid.paymentStatus, paid.paidAmount, paid.orderReference], ['confirmed', 'paid', 1400, `charge:${r.body.chargeCode}`]);
  assert.equal(await prisma.commerceEvent.count({ where: { type: 'order.paid', aggregateId: order.id } }), 1);
});

test('only the buyer of THIS conversation can pay; group threads and strangers are refused; no self-orders', async () => {
  const x = await setup();
  const r = await x.card();
  const otherC = await customer();
  await fundUser(otherC.id, 5000);
  const other = await signedIn(api, otherC);
  const p = await other.call('POST', `money/charges/${r.body.chargeCode}/pay`, { expectedAmountKori: 1400 }, idemH());
  assert.deepEqual([p.status, p.body.code], [403, 'not_your_order']);
  assert.equal(await kori(otherC.id), 5000, 'nothing taken');
  const group = await prisma.mboloThread.create({ data: { creatorId: x.ownerC.id, name: 'g', type: 'group', members: { create: [{ userId: x.ownerC.id }, { userId: x.buyerC.id }, { userId: otherC.id }] } } });
  const g = await x.seller.call('POST', `mbolo/threads/${group.id}/order-card`, { businessId: x.shop.id, lines: [{ productId: x.p.id, quantity: 1 }], requestKey: key() });
  assert.deepEqual([g.status, g.body.code], [409, 'direct_only']);
  const notMine = await other.call('POST', `mbolo/threads/${x.thread.id}/order-card`, { businessId: x.shop.id, lines: [{ productId: x.p.id, quantity: 1 }], requestKey: key() });
  assert.equal(notMine.status, 404, 'a non-member / non-staff cannot compose');
  const buyerAsSeller = await x.buyer.call('POST', `mbolo/threads/${x.thread.id}/order-card`, { businessId: x.shop.id, lines: [{ productId: x.p.id, quantity: 1 }], requestKey: key() });
  assert.equal(buyerAsSeller.status, 404, 'the buyer has no authority over the shop');
});

test('foreign / inactive products, out of stock and bad quantities are refused; nothing created, stock untouched', async () => {
  const x = await setup({ stock: 1 });
  const other = await setup();
  for (const lines of [[{ productId: other.p.id, quantity: 1 }], [{ productId: x.p.id, quantity: 0 }], [{ productId: x.p.id, quantity: 5 }]]) {
    const r = await x.card({ lines });
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(lines)} → ${r.status}`);
  }
  assert.equal(await prisma.order.count({ where: { businessId: x.shop.id } }), 0);
  assert.equal((await prisma.product.findUnique({ where: { id: x.p.id } })).inventory, 1);
});

test('idempotent on requestKey under a double tap: one order, one charge, one card', async () => {
  const x = await setup();
  const requestKey = key();
  const rs = await Promise.all([x.card({ requestKey }), x.card({ requestKey }), x.card({ requestKey })]);
  assert.ok(rs.every((r) => [200, 201].includes(r.status)), rs.map((r) => r.status).join(','));
  assert.equal(new Set(rs.map((r) => r.body.orderId)).size, 1);
  assert.equal(await prisma.order.count({ where: { businessId: x.shop.id } }), 1);
  assert.equal(await prisma.merchantCharge.count({ where: { businessId: x.shop.id } }), 1);
  assert.equal((await prisma.product.findUnique({ where: { id: x.p.id } })).inventory, 8, 'stock taken once');
});

test('an unpaid card order cannot be prepared; cancelling it closes the charge (never payable afterwards) and restores stock', async () => {
  const x = await setup();
  const r = await x.card();
  const prep = await x.seller.call('POST', `businesses/${x.shop.id}/os/orders/${r.body.orderId}/status`, { status: 'preparing' });
  assert.deepEqual([prep.status, prep.body.code], [409, 'payment_required']);
  const c = await x.buyer.call('POST', `marketplace/orders/${r.body.orderId}/cancel`, { reason: 'plus besoin' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const o = await prisma.order.findUnique({ where: { id: r.body.orderId } });
  assert.equal(o.status, 'cancelled');
  assert.equal((await prisma.merchantCharge.findUnique({ where: { code: r.body.chargeCode } })).status, 'cancelled');
  const b0 = await kori(x.buyerC.id);
  const late = await x.buyer.call('POST', `money/charges/${r.body.chargeCode}/pay`, { expectedAmountKori: 1400 }, idemH());
  assert.ok(late.status >= 400, 'a cancelled order is never paid');
  assert.equal(await kori(x.buyerC.id), b0);
  assert.equal((await prisma.product.findUnique({ where: { id: x.p.id } })).inventory, 10);
});

test('paid then cancelled by the seller → refunded exactly once through the J5 path; replays refund nothing more', async () => {
  const x = await setup();
  const r = await x.card();
  const b0 = await kori(x.buyerC.id);
  await x.buyer.call('POST', `money/charges/${r.body.chargeCode}/pay`, { expectedAmountKori: 1400 }, idemH());
  assert.equal(await kori(x.buyerC.id), b0 - 1400);
  const cancel = () => x.seller.call('POST', `businesses/${x.shop.id}/os/orders/${r.body.orderId}/cancel`, { reason: 'rupture de stock' });
  const out = await cancel();
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.ok(out.body.refund, JSON.stringify(out.body));
  assert.equal((await cancel()).body.replayed, true);
  assert.equal(await kori(x.buyerC.id), b0, 'refunded once');
  const o = await prisma.order.findUnique({ where: { id: r.body.orderId } });
  assert.deepEqual([o.status, o.paymentStatus], ['cancelled', 'refunded']);
  assert.equal((await prisma.product.findUnique({ where: { id: x.p.id } })).inventory, 10);
});

test('an expired card is re-shared for the SAME order: the old charge is cancelled, the new one pays it', async () => {
  const x = await setup();
  const r = await x.card();
  await prisma.merchantCharge.update({ where: { code: r.body.chargeCode }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const s = await x.seller.call('POST', `mbolo/threads/${x.thread.id}/order-card/${r.body.orderId}/reshare`, {});
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.notEqual(s.body.chargeCode, r.body.chargeCode);
  assert.equal((await prisma.merchantCharge.findUnique({ where: { code: r.body.chargeCode } })).status, 'cancelled', 'the old charge can never pay');
  const pay = await x.buyer.call('POST', `money/charges/${s.body.chargeCode}/pay`, { expectedAmountKori: 1400 }, idemH());
  assert.ok(pay.status < 300, JSON.stringify(pay.body));
  assert.equal((await prisma.order.findUnique({ where: { id: r.body.orderId } })).status, 'confirmed');
  const again = await x.seller.call('POST', `mbolo/threads/${x.thread.id}/order-card/${r.body.orderId}/reshare`, {});
  assert.deepEqual([again.status, again.body.code], [409, 'not_payable'], 'a paid order is never re-shared');
});

test('concurrency: the buyer pays while someone cancels — always one consistent outcome, never a paid cancelled order or a lost refund', async () => {
  for (let round = 0; round < 6; round += 1) {
    const x = await setup();
    const r = await x.card();
    const b0 = await kori(x.buyerC.id);
    const [pay, cancel] = await Promise.all([
      x.buyer.call('POST', `money/charges/${r.body.chargeCode}/pay`, { expectedAmountKori: 1400 }, idemH()),
      round % 2 ? x.buyer.call('POST', `marketplace/orders/${r.body.orderId}/cancel`, { reason: 'changé d’avis' }) : x.seller.call('POST', `businesses/${x.shop.id}/os/orders/${r.body.orderId}/cancel`, { reason: 'rupture' }),
    ]);
    assert.ok(pay.status !== 500 && cancel.status !== 500, `no server error: pay ${pay.status} ${JSON.stringify(pay.body)} / cancel ${cancel.status} ${JSON.stringify(cancel.body)}`);
    const o = await prisma.order.findUnique({ where: { id: r.body.orderId } });
    const ch = await prisma.merchantCharge.findUnique({ where: { code: r.body.chargeCode } });
    const bal = await kori(x.buyerC.id);
    if (o.status === 'cancelled') {
      assert.equal(bal, b0, `cancelled → buyer whole (round ${round}, pay ${pay.status})`);
      assert.ok(['cancelled', 'paid'].includes(ch.status));
      if (ch.status === 'paid') assert.equal(o.paymentStatus, 'refunded', 'paid then cancelled → refunded');
    } else {
      assert.deepEqual([o.status, o.paymentStatus, ch.status, bal], ['confirmed', 'paid', 'paid', b0 - 1400]);
    }
  }
});
