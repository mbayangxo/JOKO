/**
 * A4 — refund-aware affiliate commissions (deferred mode; inactive in production by default).
 * Commission is held at purchase, earned only after the order is completed and the settlement
 * window passes, scaled down by refunds, reversed on cancellation / full refund, never silently
 * clawed back after earning, and refused for self-dealing / velocity abuse. Legacy immediate mode
 * stays unchanged when the flag is off. J2 + affiliate invariants after every test.
 */
import '../helpers/setup.js';
import { test, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createUserWithWallet, fundUser, prisma } from '../helpers/db.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { placeMarketplaceOrder } from '../../lib/marketplace-service.js';
import { merchantTransition, cancelOrder, refundOrder } from '../../lib/commerce/orders.js';
import { orderPaymentEntry } from '../../lib/commerce/payments.js';
import { refundReceivedPayment } from '../../lib/money/refunds.js';
import { createAffiliateLink, registerAffiliate } from '../../lib/affiliate-service.js';
import { checkAffiliateInvariants, payoutAffiliateEarnings, settleAffiliateCommissions } from '../../lib/affiliate-settlement.js';
import { business } from '../j3/helpers.js';
import { ensureBusinessWallet } from '../../lib/business-wallet-service.js';

beforeEach(() => { process.env.AFFILIATE_DEFERRED_SETTLEMENT = 'true'; });
afterEach(async () => {
  delete process.env.AFFILIATE_DEFERRED_SETTLEMENT;
  await assertInvariants(prisma);
  const a = await checkAffiliateInvariants(prisma);
  assert.ok(a.ok, JSON.stringify(a.violations));
});
after(async () => { await prisma.$disconnect(); });

const kori = async (userId) => (await prisma.wallet.findUnique({ where: { userId } })).koriBalance;
const DAY = 86_400_000;

async function setup({ price = 10_000 } = {}) {
  const owner = await createUserWithWallet({ tier: 3, koriBalance: 0 });
  const b = await business(owner);
  await ensureBusinessWallet(b.id, prisma);
  const product = await prisma.product.create({ data: { businessId: b.id, title: `Pagne ${crypto.randomBytes(2).toString('hex')}`, price, inventory: 50, active: true, category: 'mode' } });
  const aff = await createUserWithWallet({ tier: 2, koriBalance: 0 });
  await registerAffiliate(prisma, aff.id, 'Awa partage');
  const link = await createAffiliateLink(prisma, aff.id, { productId: product.id });
  const buyer = await createUserWithWallet({ tier: 2, koriBalance: 0 });
  await fundUser(buyer.id, 100_000);
  return { owner, b, product, aff, link, buyer };
}
const buy = (x, buyerId = x.buyer.id) => placeMarketplaceOrder(prisma, { buyerId, businessId: x.b.id, items: [{ productId: x.product.id, quantity: 1 }], fulfillmentType: 'pickup', reference: `ORD-${crypto.randomBytes(5).toString('hex')}`, affiliateLinkCode: x.link.linkCode ?? x.link.link?.linkCode });
const commissionOf = (orderId) => prisma.affiliateCommission.findFirst({ where: { orderId } });
async function complete(x, orderId) {
  for (const to of ['preparing', 'ready_for_pickup', 'completed']) await merchantTransition(x.owner.id, orderId, to);
}
const passWindow = (id) => prisma.affiliateCommission.update({ where: { id }, data: { eligibleAt: new Date(Date.now() - 1000) } });

test('purchase → provisional (held, nothing to the affiliate) → completed → window → earned → paid once', async () => {
  const x = await setup();
  const r = await buy(x);
  const order = r.order ?? r;
  const c = await commissionOf(order.id);
  assert.equal(c.status, 'provisional');
  assert.equal(c.settlementMode, 'deferred');
  assert.equal(await kori(x.aff.id), 0, 'no commission paid at purchase');
  assert.equal(Number((await prisma.ledgerAccount.findUnique({ where: { code: `escrow:affiliate:${c.id}` } })).balance), c.amount);
  await settleAffiliateCommissions(prisma);
  assert.deepEqual([(await commissionOf(order.id)).status, (await commissionOf(order.id)).eligibleAt], ['provisional', null], 'not eligible before completion');
  await complete(x, order.id);
  await settleAffiliateCommissions(prisma); // starts the window
  assert.equal((await commissionOf(order.id)).status, 'provisional');
  await passWindow(c.id);
  const s = await settleAffiliateCommissions(prisma);
  assert.equal(s.earned, 1);
  const e = await commissionOf(order.id);
  assert.deepEqual([e.status, e.earnedKori], ['earned', c.amount]);
  const k = `aff-${crypto.randomBytes(6).toString('hex')}`;
  assert.equal((await payoutAffiliateEarnings(x.aff.id, { idempotencyKey: k })).paidKori, c.amount);
  assert.equal((await payoutAffiliateEarnings(x.aff.id, { idempotencyKey: k })).replayed, true);
  assert.equal((await payoutAffiliateEarnings(x.aff.id, { idempotencyKey: `${k}-2` })).paidKori, 0);
  assert.equal(await kori(x.aff.id), c.amount, 'paid exactly once');
});

test('cancelled before eligibility → the whole commission returns to the merchant; nothing to the affiliate', async () => {
  const x = await setup();
  const order = (await buy(x)).order ?? (await prisma.order.findFirst({ where: { buyerId: x.buyer.id }, orderBy: { createdAt: 'desc' } }));
  const c = await commissionOf(order.id);
  await cancelOrder(x.owner.id, order.id, { as: 'merchant', reason: 'Rupture de stock' });
  // Reversed atomically inside the cancellation (the merchant can always refund); the job then has nothing to do.
  assert.equal((await settleAffiliateCommissions(prisma)).reversed, 0);
  const r = await commissionOf(order.id);
  assert.deepEqual([r.status, r.reversedKori], ['reversed', c.amount]);
  assert.equal(await kori(x.aff.id), 0);
});

test('full refund after completion but before the window ends → reversed; refund AFTER earning → flagged for review, never clawed back', async () => {
  const x = await setup();
  const o1 = (await buy(x)).order ?? (await prisma.order.findFirst({ where: { buyerId: x.buyer.id }, orderBy: { createdAt: 'desc' } }));
  await complete(x, o1.id);
  await settleAffiliateCommissions(prisma);
  await refundOrder(x.owner.id, o1.id, { reason: 'Article défectueux' });
  const c1 = await commissionOf(o1.id);
  await passWindow(c1.id);
  await settleAffiliateCommissions(prisma);
  assert.equal((await commissionOf(o1.id)).status, 'reversed');
  // Second order: earned, then refunded.
  const o2 = (await buy(x)).order ?? (await prisma.order.findFirst({ where: { buyerId: x.buyer.id }, orderBy: { createdAt: 'desc' } }));
  await complete(x, o2.id);
  await settleAffiliateCommissions(prisma);
  await passWindow((await commissionOf(o2.id)).id);
  await settleAffiliateCommissions(prisma);
  const earned = await commissionOf(o2.id);
  assert.equal(earned.status, 'earned');
  // A refund after earning is borne by the merchant (the commission is not clawed back): give the
  // merchant other sales revenue first, through a normal sale with no affiliate.
  await placeMarketplaceOrder(prisma, { buyerId: x.buyer.id, businessId: x.b.id, items: [{ productId: x.product.id, quantity: 1 }], fulfillmentType: 'pickup', reference: `ORD-${crypto.randomBytes(5).toString('hex')}` });
  await refundOrder(x.owner.id, o2.id, { reason: 'Retour client tardif' });
  await settleAffiliateCommissions(prisma);
  const flagged = await commissionOf(o2.id);
  assert.deepEqual([flagged.status, flagged.reviewReason, flagged.earnedKori], ['earned', 'refunded_after_earned', earned.earnedKori], 'kept, not debited');
  assert.equal((await payoutAffiliateEarnings(x.aff.id, { idempotencyKey: `aff-${crypto.randomBytes(6).toString('hex')}` })).paidKori, 0, 'held for review, not paid out');
});

test('fraud controls: affiliate owning or working for the business, and velocity, get no commission', async () => {
  const x = await setup();
  // The affiliate buys from a business they work for.
  await prisma.businessMember.create({ data: { businessId: x.b.id, userId: x.aff.id, role: 'cashier', status: 'active', acceptedAt: new Date() } });
  await fundUser(x.aff.id, 50_000);
  const self = (await buy(x, x.aff.id)).order ?? (await prisma.order.findFirst({ where: { buyerId: x.aff.id }, orderBy: { createdAt: 'desc' } }));
  assert.equal(await commissionOf(self.id), null);
  await prisma.businessMember.updateMany({ where: { businessId: x.b.id, userId: x.aff.id }, data: { status: 'removed' } });
  // Velocity: 3 attributions per buyer per 24 h, then none.
  for (let i = 0; i < 4; i += 1) await buy(x);
  const n = await prisma.affiliateCommission.count({ where: { buyerId: x.buyer.id } });
  assert.equal(n, 3);
});

test('legacy immediate mode is unchanged when the flag is off (production default)', async () => {
  delete process.env.AFFILIATE_DEFERRED_SETTLEMENT;
  const x = await setup();
  const order = (await buy(x)).order ?? (await prisma.order.findFirst({ where: { buyerId: x.buyer.id }, orderBy: { createdAt: 'desc' } }));
  const c = await commissionOf(order.id);
  assert.deepEqual([c.status, c.settlementMode], ['paid', 'immediate']);
  assert.equal(await kori(x.aff.id), c.amount, 'legacy: paid at purchase (owner decision pending, P-J9-4)');
  process.env.AFFILIATE_DEFERRED_SETTLEMENT = 'true';
});

test('partial refund before eligibility scales the commission; the unearned part returns to the merchant', async () => {
  const x = await setup();
  const order = (await buy(x)).order ?? (await prisma.order.findFirst({ where: { buyerId: x.buyer.id }, orderBy: { createdAt: 'desc' } }));
  const c = await commissionOf(order.id);
  await complete(x, order.id);
  await settleAffiliateCommissions(prisma);
  const pay = await orderPaymentEntry(prisma, order.orderReference);
  await refundReceivedPayment(x.owner.id, pay.reference, { amountKori: order.totalAmount / 2, reason: 'Un article manquant' });
  await passWindow(c.id);
  const s = await settleAffiliateCommissions(prisma);
  assert.equal(s.partiallyReversed, 1);
  const e = await commissionOf(order.id);
  assert.equal(e.earnedKori, Math.floor(c.amount / 2));
  assert.equal(e.earnedKori + e.reversedKori, c.amount, 'nothing created or lost');
});

test('races: concurrent settlement jobs earn once; concurrent payouts with different keys pay once; refund racing the job stays consistent', async () => {
  const x = await setup();
  const o1 = (await buy(x)).order ?? (await prisma.order.findFirst({ where: { buyerId: x.buyer.id }, orderBy: { createdAt: 'desc' } }));
  const c1 = await commissionOf(o1.id);
  await complete(x, o1.id);
  await settleAffiliateCommissions(prisma);
  await passWindow(c1.id);
  await Promise.all([1, 2, 3].map(() => settleAffiliateCommissions(prisma)));
  const e1 = await commissionOf(o1.id);
  assert.deepEqual([e1.status, e1.earnedKori], ['earned', c1.amount]);
  const res = await Promise.allSettled([1, 2, 3].map((i) => payoutAffiliateEarnings(x.aff.id, { idempotencyKey: `race-${i}-${crypto.randomBytes(4).toString('hex')}` })));
  const paid = res.filter((r) => r.status === 'fulfilled').reduce((s, r) => s + r.value.paidKori, 0);
  assert.equal(paid, c1.amount);
  assert.equal(await kori(x.aff.id), c1.amount, 'paid exactly once');
  // Refund racing the settlement job on a second order.
  const o2 = (await buy(x)).order ?? (await prisma.order.findFirst({ where: { buyerId: x.buyer.id }, orderBy: { createdAt: 'desc' } }));
  const c2 = await commissionOf(o2.id);
  await complete(x, o2.id);
  await settleAffiliateCommissions(prisma);
  await passWindow(c2.id);
  await placeMarketplaceOrder(prisma, { buyerId: x.buyer.id, businessId: x.b.id, items: [{ productId: x.product.id, quantity: 1 }], fulfillmentType: 'pickup', reference: `ORD-${crypto.randomBytes(5).toString('hex')}` });
  await Promise.allSettled([refundOrder(x.owner.id, o2.id, { reason: 'Retour client' }), settleAffiliateCommissions(prisma)]);
  await settleAffiliateCommissions(prisma);
  const f = await commissionOf(o2.id);
  assert.ok(f.status === 'reversed' || (f.status === 'earned' && f.reviewReason === 'refunded_after_earned'), `${f.status}/${f.reviewReason}`);
});
