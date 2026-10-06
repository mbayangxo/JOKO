/**
 * J7.9 on the LEGACY B2B marketplace channel: net-term orders are checked under
 * the (supplier, buyer) trade lock inside the order transaction, so concurrent
 * orders cannot overshoot the supplier-granted credit limit; revoked accounts
 * grant nothing; credit memos (not overwrites) correct invoices.
 */
import '../helpers/setup.js';
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createUserWithWallet, prisma } from '../helpers/db.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { placeMarketplaceOrder } from '../../lib/marketplace-service.js';
import { ensureBusinessWallet } from '../../lib/business-wallet-service.js';
import { resolveTradeInvoiceDispute, disputeTradeInvoice } from '../../lib/trade-service.js';

after(async () => { await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

async function setup({ limit = 10_000, term = 'net30' } = {}) {
  const supplier = await createUserWithWallet({ koriBalance: 0 });
  const buyer = await createUserWithWallet({ koriBalance: 0 });
  const tag = crypto.randomBytes(4).toString('hex');
  const brand = await prisma.business.create({ data: { ownerId: supplier.id, name: `Sup ${tag}`, type: 'brand', category: 'k21', distributionEnabled: true, lat: 14.6, lng: -17.4 } });
  const shop = await prisma.business.create({ data: { ownerId: buyer.id, name: `Shop ${tag}`, type: 'merchant', category: 'grocery', lat: 14.6, lng: -17.4 } });
  await ensureBusinessWallet(brand.id, prisma);
  await ensureBusinessWallet(shop.id, prisma);
  const product = await prisma.product.create({ data: { businessId: brand.id, title: 'Riz 25kg', price: 1100, b2bPrice: 1000, b2bMinQty: 1, saleChannel: 'both', inventory: 1000, category: 'agro', active: true } });
  const account = await prisma.tradeAccount.create({ data: { supplierBusinessId: brand.id, buyerUserId: buyer.id, buyerBusinessId: shop.id, paymentTerm: term, creditLimitKori: limit } });
  return { supplier, buyer, brand, shop, product, account };
}
const order = (s, qty) => placeMarketplaceOrder(prisma, {
  buyerId: s.buyer.id, businessId: s.brand.id, items: [{ productId: s.product.id, quantity: qty }],
  fulfillmentType: 'pickup', channel: 'b2b', paymentTerm: 'net30', paymentSource: 'personal', buyerBusinessId: s.shop.id,
  reference: `T-${crypto.randomBytes(6).toString('hex')}`,
});
const owed = async (s) => {
  const rows = await prisma.tradeInvoice.findMany({ where: { supplierBusinessId: s.brand.id, buyerUserId: s.buyer.id } });
  return rows.reduce((a, r) => a + r.amountKori - r.amountPaid - r.creditedKori, 0);
};

test('8 concurrent net-30 orders of 3,000 on a 10,000 limit: at most 3 succeed; outstanding never exceeds the limit', async () => {
  const s = await setup();
  const res = await Promise.allSettled(Array.from({ length: 8 }, () => order(s, 3)));
  const ok = res.filter((r) => r.status === 'fulfilled').length;
  assert.equal(ok, 3, res.map((r) => r.reason?.message ?? 'ok').join(' | '));
  assert.ok(res.filter((r) => r.status === 'rejected').every((r) => /crédit/i.test(r.reason.message)));
  assert.equal(await owed(s), 9000);
  assert.ok((await owed(s)) <= s.account.creditLimitKori);
});

test('order racing a limit reduction / revocation: the account change and the order serialize', async () => {
  const s = await setup({ limit: 5000 });
  const [o, rev] = await Promise.allSettled([
    order(s, 4),
    prisma.tradeAccount.update({ where: { id: s.account.id }, data: { active: false, revokedAt: new Date(), revokedBy: s.supplier.id } }),
  ]);
  assert.equal(rev.status, 'fulfilled');
  // Either the order committed first (4,000 owed, then revoked) or it was refused.
  const total = await owed(s);
  assert.ok((o.status === 'fulfilled' && total === 4000) || (o.status === 'rejected' && total === 0), `${o.status} ${total}`);
  await assert.rejects(order(s, 1), /crédit/i, 'revoked account grants nothing');
});

test('net order on a term the supplier did not grant is refused (no self-granted Net 90)', async () => {
  const s = await setup({ term: 'net15' });
  await assert.rejects(order(s, 1), /Conditions convenues/);
});

test('dispute waive/adjust are credit memos: principal preserved, memo rows explain the change, credit headroom restored once', async () => {
  const s = await setup({ limit: 10_000 });
  const o1 = await order(s, 6);
  const inv = await prisma.tradeInvoice.findFirst({ where: { supplierBusinessId: s.brand.id, buyerUserId: s.buyer.id } });
  assert.equal(inv.amountKori, 6000);
  await disputeTradeInvoice(prisma, { invoiceId: inv.id, buyerUserId: s.buyer.id, reason: 'quantité livrée inférieure' });
  const adj = await resolveTradeInvoiceDispute(prisma, { invoiceId: inv.id, supplierOwnerId: s.supplier.id, action: 'adjust', newAmountKori: 4000, note: 'deux sacs manquants' });
  assert.equal(adj.amountKori, 4000, 'net shown');
  const row = await prisma.tradeInvoice.findUnique({ where: { id: inv.id } });
  assert.equal(row.amountKori, 6000, 'principal immutable');
  assert.equal(row.creditedKori, 2000);
  const memos = await prisma.creditMemo.findMany({ where: { invoiceId: inv.id } });
  assert.equal(memos.length, 1);
  assert.equal(memos[0].amountKori, 2000);
  // Headroom now 6,000: a 6,000 order fits, 7,000 would not.
  await assert.rejects(order(s, 7), /crédit/i);
  await order(s, 6);
  // DB refuses deletion and principal rewrites.
  await assert.rejects(prisma.tradeInvoice.delete({ where: { id: inv.id } }));
  await assert.rejects(prisma.tradeInvoice.update({ where: { id: inv.id }, data: { amountKori: 1 } }));
  await assert.rejects(prisma.creditMemo.update({ where: { id: memos[0].id }, data: { amountKori: 1 } }));
  assert.ok(o1);
});
