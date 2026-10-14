/**
 * J14-F2 — chat orders: stock reserved 30 minutes; unpaid orders expire SAFELY.
 * Deterministic: order creation times are set explicitly and the expiry pass takes an injected clock.
 *   - payable only inside the reservation (hard deadline, under the order lock);
 *   - expiry releases stock exactly once, closes the charge, cancels the order; idempotent on retry;
 *   - an in-flight (unknown-outcome) payment defers expiry; a stale one does not block forever;
 *   - a paid charge on an unconfirmed order is a reconciliation exception, never released;
 *   - payment vs expiry race: always one consistent outcome; J2 invariants hold;
 *   - other orders / businesses untouched.
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

process.env.MBOLO_ORDER_EXPIRY_ENABLED = 'true';
const M = await import('../../lib/commerce/mbolo-orders.js');
const MIN = 60_000;
let api;
before(async () => { api = await startApiServer({ MBOLO_ORDER_CARD_ENABLED: 'true' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const key = () => `req_${crypto.randomBytes(8).toString('hex')}`;
const kori = async (id) => (await prisma.wallet.findUnique({ where: { userId: id } })).koriBalance;
const stock = async (id) => (await prisma.product.findUnique({ where: { id } })).inventory;

async function cardOrder({ ageMin = 0 } = {}) {
  const ownerC = await customer();
  const seller = await signedIn(api, ownerC);
  const shop = await business(ownerC.user);
  await ensureBusinessWallet(shop.id, prisma);
  const p = await prisma.product.create({ data: { businessId: shop.id, title: 'Thiouraye', price: 500, inventory: 10, trackInventory: true } });
  const buyerC = await customer();
  await fundUser(buyerC.id, 10_000);
  const buyer = await signedIn(api, buyerC);
  const thread = await prisma.mboloThread.create({ data: { creatorId: ownerC.id, name: 'dm', type: 'direct', members: { create: [{ userId: ownerC.id }, { userId: buyerC.id }] } } });
  const r = await seller.call('POST', `mbolo/threads/${thread.id}/order-card`, { businessId: shop.id, lines: [{ productId: p.id, quantity: 3 }], requestKey: key() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  if (ageMin) await prisma.order.update({ where: { id: r.body.orderId }, data: { createdAt: new Date(Date.now() - ageMin * MIN) } });
  const pay = (h = idemH()) => buyer.call('POST', `money/charges/${r.body.chargeCode}/pay`, { expectedAmountKori: 1500 }, h);
  return { ...r.body, p, shop, seller, buyerC, buyer, thread, pay };
}
const order = (id) => prisma.order.findUnique({ where: { id } });

test('disabled by default: without MBOLO_ORDER_EXPIRY_ENABLED the pass does nothing', async () => {
  const o = await cardOrder({ ageMin: 45 });
  process.env.MBOLO_ORDER_EXPIRY_ENABLED = 'false';
  try {
    assert.deepEqual(await M.expireMboloCardOrders(prisma), { enabled: false });
    assert.equal((await order(o.orderId)).status, 'pending_payment');
  } finally {
    process.env.MBOLO_ORDER_EXPIRY_ENABLED = 'true';
  }
});

test('reservation: stock held for 30 min; at 29 min still payable; after 30 min payment is refused even before the expiry pass runs', async () => {
  const a = await cardOrder({ ageMin: 29 });
  assert.equal(await stock(a.p.id), 7, 'stock reserved');
  assert.ok((await a.pay()).status < 300, 'paid inside the reservation');
  assert.equal((await order(a.orderId)).status, 'confirmed');
  const b = await cardOrder({ ageMin: 31 });
  const b0 = await kori(b.buyerC.id);
  const late = await b.pay();
  assert.equal(late.status, 409, JSON.stringify(late.body));
  assert.equal(late.body.code, 'reservation_expired');
  assert.equal(await kori(b.buyerC.id), b0, 'no debit');
  const reshare = await b.seller.call('POST', `mbolo/threads/${b.thread.id}/order-card/${b.orderId}/reshare`, {});
  assert.equal(reshare.body.code, 'reservation_expired', 'a re-share never extends the reservation');
  const c = await cardOrder({ ageMin: 0 });
  const charge = await prisma.merchantCharge.findUnique({ where: { code: c.chargeCode } });
  assert.ok(charge.expiresAt.getTime() <= (await order(c.orderId)).createdAt.getTime() + M.RESERVATION_MS + 1000, 'a charge never outlives the reservation');
});

test('expiry: releases stock exactly once, expires the charge, cancels the order; a retry is a no-op; payment afterwards refused', async () => {
  const o = await cardOrder({ ageMin: 31 });
  const r1 = await M.expireMboloCardOrders(prisma);
  assert.ok(r1.expired >= 1, JSON.stringify(r1));
  const ord = await order(o.orderId);
  assert.deepEqual([ord.status, ord.cancelReason, ord.paymentStatus], ['cancelled', 'payment_window_expired', 'pending']);
  assert.equal(await stock(o.p.id), 10, 'stock back');
  assert.equal((await prisma.merchantCharge.findUnique({ where: { code: o.chargeCode } })).status, 'expired');
  await M.expireMboloCardOrders(prisma);
  assert.equal(await stock(o.p.id), 10, 'never restored twice');
  assert.equal(await prisma.commerceEvent.count({ where: { type: 'order.cancelled', aggregateId: o.orderId } }), 1);
  const b0 = await kori(o.buyerC.id);
  assert.ok((await o.pay()).status >= 400);
  assert.equal(await kori(o.buyerC.id), b0);
});

test('an UNKNOWN payment outcome (pay request in flight) defers expiry; once stale, the authoritative charge state decides', async () => {
  const o = await cardOrder({ ageMin: 31 });
  const row = await prisma.apiIdempotency.create({ data: { key: `api:${o.buyerC.id}:POST money/charges/${o.chargeCode}/pay:${key()}`, provider: 'api', userId: o.buyerC.id, operation: `POST money/charges/${o.chargeCode}/pay`, reference: 'fp', status: 'in_progress' } });
  const r = await M.expireMboloCardOrders(prisma);
  assert.ok(r.deferred >= 1, JSON.stringify(r));
  assert.equal((await order(o.orderId)).status, 'pending_payment', 'nothing released while the outcome is unknown');
  assert.equal(await stock(o.p.id), 7);
  // The request died (no commit): the in-progress row ages out; the charge is still open → expire.
  await prisma.$executeRaw`UPDATE "ApiIdempotency" SET "updatedAt" = now() - interval '10 minutes' WHERE id = ${row.id}`;
  await M.expireMboloCardOrders(prisma);
  assert.equal((await order(o.orderId)).status, 'cancelled');
  assert.equal(await stock(o.p.id), 10);
});

test('a charge recorded PAID on an unconfirmed order → reconciliation exception; never released', async () => {
  const o = await cardOrder({ ageMin: 31 });
  await prisma.merchantCharge.update({ where: { code: o.chargeCode }, data: { status: 'paid' } }); // anomaly by construction
  const r = await M.expireMboloCardOrders(prisma);
  assert.ok(r.exceptions >= 1, JSON.stringify(r));
  assert.equal((await order(o.orderId)).status, 'pending_payment');
  assert.equal(await stock(o.p.id), 7, 'stock not released');
  const ex = await prisma.reconciliationException.findFirst({ where: { kind: 'mbolo_order_paid_unconfirmed', providerReference: o.orderId } });
  assert.ok(ex);
  await M.expireMboloCardOrders(prisma);
  assert.equal(await prisma.reconciliationException.count({ where: { kind: 'mbolo_order_paid_unconfirmed', providerReference: o.orderId } }), 1, 'one exception, not one per pass');
  await prisma.merchantCharge.update({ where: { code: o.chargeCode }, data: { status: 'cancelled' } }); // leave fixtures sane
});

test('race: payment and expiry at the same moment — paid & kept XOR expired & whole, never both, over many rounds', async () => {
  let paidWins = 0;
  let expiryWins = 0;
  for (let i = 0; i < 8; i += 1) {
    const o = await cardOrder({ ageMin: 0 });
    const b0 = await kori(o.buyerC.id);
    // The expiry pass runs with a clock past the deadline while the buyer pays inside it (their clock).
    const [pay, exp] = await Promise.all([o.pay(), M.expireMboloCardOrders(prisma, { now: Date.now() + 31 * MIN })]);
    assert.notEqual(pay.status, 500, JSON.stringify(pay.body));
    const ord = await order(o.orderId);
    const ch = await prisma.merchantCharge.findUnique({ where: { code: o.chargeCode } });
    if (ord.status === 'confirmed') {
      paidWins += 1;
      assert.deepEqual([ord.paymentStatus, ch.status, await kori(o.buyerC.id), await stock(o.p.id)], ['paid', 'paid', b0 - 1500, 7]);
    } else {
      expiryWins += 1;
      assert.deepEqual([ord.status, ch.status, await kori(o.buyerC.id), await stock(o.p.id)], ['cancelled', 'expired', b0, 10], JSON.stringify({ pay: pay.status, exp }));
    }
  }
  assert.equal(paidWins + expiryWins, 8);
});

test('isolation: only expired, unpaid CARD orders are touched — paid card orders, fresh ones and other orders are not', async () => {
  const paid = await cardOrder({ ageMin: 10 });
  await paid.pay();
  await prisma.order.update({ where: { id: paid.orderId }, data: { createdAt: new Date(Date.now() - 60 * MIN) } });
  const fresh = await cardOrder({ ageMin: 5 });
  const ownerC = await customer();
  const shop = await business(ownerC.user);
  const other = await prisma.order.create({ data: { buyerId: (await customer()).id, businessId: shop.id, status: 'pending_payment', paymentStatus: 'pending', paymentTerm: 'net_30', totalAmount: 1000, createdAt: new Date(Date.now() - 120 * MIN) } });
  await M.expireMboloCardOrders(prisma);
  assert.equal((await order(paid.orderId)).status, 'confirmed');
  assert.equal((await order(fresh.orderId)).status, 'pending_payment');
  assert.equal((await order(other.id)).status, 'pending_payment', 'a B2B credit order is not a card order');
});
