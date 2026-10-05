/**
 * J5 — the merchant operating loop over real HTTP: catalog → order (server
 * prices) → payment into the BUSINESS wallet → stock with history →
 * fulfilment state machine → cancellation / refund as J2 compensating
 * entries → history. Adversarial and concurrency cases inline.
 * J2 invariants after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { business, customer, signedIn } from '../j3/helpers.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const key = () => `intent-${crypto.randomBytes(8).toString('hex')}`;
const bizBalance = async (id) => Number((await prisma.ledgerAccount.findUnique({ where: { code: `business:${id}:wallet` } }))?.balance ?? 0);
const walletOf = async (userId) => (await prisma.wallet.findUnique({ where: { userId } })).koriBalance;

async function shop({ roles = ['manager', 'cashier', 'fulfillment', 'finance'], settlement } = {}) {
  const owner = await customer();
  const people = {};
  for (const r of roles) people[r] = await customer();
  const b = await business(owner.user, roles.map((r) => ({ user: people[r].user, role: r })));
  if (settlement) await prisma.business.update({ where: { id: b.id }, data: { settlementMode: settlement } });
  const s = { owner: await signedIn(api, owner) };
  for (const r of roles) s[r] = await signedIn(api, people[r]);
  const add = async (body) => {
    const r = await s.owner.call('POST', `businesses/${b.id}/os/catalog`, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  return { b, s, owner, add, P: `businesses/${b.id}/os` };
}

async function buyer(kori = 2000) {
  const c = await customer({ koriBalance: 0 });
  await fundUser(c.id, kori);
  return signedIn(api, c);
}

const order = (s, businessId, items, extra = {}) =>
  s.call('POST', 'marketplace/orders', { businessId, items, fulfillmentType: 'pickup', ...extra }, { headers: { 'idempotency-key': key() } });

test('catalog → order at SERVER prices → paid into the business wallet (not the owner) → stock decremented with history', async () => {
  const { b, s, owner, add, P } = await shop();
  const yassa = await add({ title: 'Yassa poulet', priceKori: 300, initialStock: 4, sku: 'YAS-1' });
  const coupe = await add({ kind: 'service', title: 'Coupe', priceKori: 200, trackInventory: true });
  assert.equal(coupe.trackInventory, false, 'a service never tracks stock');
  assert.equal((await s.owner.call('POST', `${P}/catalog`, { title: 'Doublon', priceKori: 1, sku: 'YAS-1' })).status, 409, 'SKU unique per business');
  assert.equal((await s.owner.call('PATCH', `${P}/catalog/${yassa.id}`, { inventory: 999 })).status, 400, 'stock is never set by a catalog edit');

  const u = await buyer();
  const ownerBefore = await walletOf(owner.id);
  // Client-sent prices / totals are ignored: the schema has no price field and lines are re-priced from the catalog.
  const r = await order(u, b.id, [{ productId: yassa.id, quantity: 2, unitPrice: 1 }, { productId: coupe.id, quantity: 1 }], { totalAmount: 1 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.totalKori, 800);
  assert.equal(r.body.status, 'confirmed', 'a paid order waits for the merchant');
  assert.equal(await walletOf(u.id), 1200);
  assert.equal(await bizBalance(b.id), 800, 'settled to the business wallet');
  assert.equal(await walletOf(owner.id), ownerBefore, 'the owner’s personal wallet is untouched');

  const stock = await prisma.product.findUnique({ where: { id: yassa.id } });
  assert.equal(stock.inventory, 2);
  const hist = await s.owner.call('GET', `${P}/stock/${yassa.id}/history`);
  assert.deepEqual(hist.body.map((m) => [m.reason, m.delta, m.balanceAfter]), [['sale', -2, 2], ['initial', 4, 4]]);
  assert.equal((await prisma.order.findUnique({ where: { id: r.body.orderId } })).settledTo, 'business');

  // Quantity manipulation.
  for (const q of [0, -1, 21, 1.5]) assert.equal((await order(u, b.id, [{ productId: yassa.id, quantity: q }])).status, 400, String(q));
  // Another business's product cannot be ordered through this shop.
  const other = await shop({ roles: [] });
  const foreign = await other.add({ title: 'Ailleurs', priceKori: 10, initialStock: 3 });
  assert.equal((await order(u, b.id, [{ productId: foreign.id, quantity: 1 }])).status, 400);
});

test('order state machine: only listed moves, by the right actor; no jumps; customer cannot drive merchant states', async () => {
  const { b, s, add, P } = await shop();
  const item = await add({ title: 'Bissap', priceKori: 50, initialStock: 10 });
  const u = await buyer();
  const { body: o } = await order(u, b.id, [{ productId: item.id, quantity: 1 }]);
  const move = (who, to) => s[who].call('POST', `${P}/orders/${o.orderId}/status`, { status: to });

  assert.equal((await move('fulfillment', 'completed')).status, 409, 'no jump confirmed → completed');
  assert.equal((await move('fulfillment', 'out_for_delivery')).status, 409, 'pickup order cannot go out for delivery');
  assert.equal((await move('cashier', 'preparing')).status, 404, 'a cashier does not fulfil');
  assert.ok([403, 404].includes((await u.call('POST', `${P}/orders/${o.orderId}/status`, { status: 'preparing' })).status), 'customer cannot use merchant routes');
  assert.equal((await move('fulfillment', 'preparing')).status, 200);
  assert.equal((await u.call('POST', `marketplace/orders/${o.orderId}/cancel`, { reason: 'trop tard' })).status, 409, 'customer cannot cancel once the merchant started');
  assert.equal((await move('fulfillment', 'ready_for_pickup')).status, 200);
  assert.ok([403, 404].includes((await s.fulfillment.call('POST', `marketplace/orders/${o.orderId}/confirm`, {})).status), 'merchant cannot do the customer’s confirmation');
  assert.equal((await u.call('POST', `marketplace/orders/${o.orderId}/confirm`, {})).status, 200);
  assert.equal((await prisma.order.findUnique({ where: { id: o.orderId } })).status, 'completed');
  assert.equal((await move('fulfillment', 'preparing')).status, 409, 'completed is final for fulfilment');

  // The legacy route uses the same locked state machine (staff with the capability, not only the owner).
  const { body: o2 } = await order(u, b.id, [{ productId: item.id, quantity: 1 }]);
  assert.equal((await s.fulfillment.call('PATCH', `marketplace/orders/${o2.orderId}/status`, { status: 'preparing' })).status, 200);
  assert.equal((await s.cashier.call('PATCH', `marketplace/orders/${o2.orderId}/status`, { status: 'ready_for_pickup' })).status, 404);
});

test('customer cancels before preparation → full refund from the business wallet + stock back; replay is a no-op', async () => {
  const { b, add } = await shop();
  const item = await add({ title: 'Fataya', priceKori: 100, initialStock: 3 });
  const u = await buyer(1000);
  const { body: o } = await order(u, b.id, [{ productId: item.id, quantity: 2 }]);
  assert.equal(await walletOf(u.id), 800);
  const c = await u.call('POST', `marketplace/orders/${o.orderId}/cancel`, { reason: 'erreur de commande' }, { headers: { 'idempotency-key': key() } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.refund.amountKori, 200);
  assert.equal(await walletOf(u.id), 1000);
  assert.equal(await bizBalance(b.id), 0);
  assert.equal((await prisma.product.findUnique({ where: { id: item.id } })).inventory, 3);
  const again = await u.call('POST', `marketplace/orders/${o.orderId}/cancel`, { reason: 'encore' });
  assert.equal(again.body.replayed, true);
  assert.equal(await walletOf(u.id), 1000, 'never refunded twice');
  const entries = await prisma.journalEntry.findMany({ where: { reference: `order-refund:${o.orderId}` } });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'merchant_refund');
  assert.equal(entries[0].metadata.orderId, o.orderId);
  // The customer's history shows the refund linked to the payment.
  const hist = await u.call('GET', 'money/activity');
  assert.ok(hist.body.items.some((i) => i.reference === `order-refund:${o.orderId}` && i.links?.refundOf));
});

test('merchant cancel (orders.cancel) and refund after completion (business.refund); permissions, duplicates, over-refund, other merchant', async () => {
  const { b, s, add, P } = await shop();
  const item = await add({ title: 'Pastels', priceKori: 120, initialStock: 10 });
  const u = await buyer(2000);
  const { body: o1 } = await order(u, b.id, [{ productId: item.id, quantity: 1 }]);
  await s.fulfillment.call('POST', `${P}/orders/${o1.orderId}/status`, { status: 'preparing' });
  assert.equal((await s.cashier.call('POST', `${P}/orders/${o1.orderId}/cancel`, { reason: 'rupture' })).status, 404, 'cashier cannot cancel');
  assert.equal((await s.fulfillment.call('POST', `${P}/orders/${o1.orderId}/cancel`, { reason: 'rupture' })).status, 404, 'fulfilment cannot cancel');
  const mc = await s.manager.call('POST', `${P}/orders/${o1.orderId}/cancel`, { reason: 'rupture de stock' });
  assert.equal(mc.status, 200, JSON.stringify(mc.body));
  assert.equal(mc.body.stockRestored[0].quantity, 1);

  // Refund only after delivery/completion; full amount; once.
  const { body: o2 } = await order(u, b.id, [{ productId: item.id, quantity: 2 }]);
  assert.equal((await s.finance.call('POST', `${P}/orders/${o2.orderId}/refund`, { reason: 'client mécontent' })).status, 409, 'refund is for fulfilled orders — cancel otherwise');
  for (const to of ['preparing', 'ready_for_pickup']) await s.fulfillment.call('POST', `${P}/orders/${o2.orderId}/status`, { status: to });
  await u.call('POST', `marketplace/orders/${o2.orderId}/confirm`, {});
  const before = await walletOf(u.id);
  assert.equal((await s.cashier.call('POST', `${P}/orders/${o2.orderId}/refund`, { reason: 'x'.repeat(5) })).status, 404);
  const twice = await Promise.all([1, 2].map(() => s.finance.call('POST', `${P}/orders/${o2.orderId}/refund`, { reason: 'produit abîmé', restock: true })));
  assert.ok(twice.every((r) => r.status === 200), JSON.stringify(twice.map((r) => r.body)));
  assert.equal(await walletOf(u.id), before + 240, 'concurrent duplicate refund pays once');
  assert.equal(twice.filter((r) => r.body.replayed).length, 1);
  assert.equal((await prisma.product.findUnique({ where: { id: item.id } })).inventory, 10, 'restocked once (10 − 1 + 1 cancelled − 2 sold + 2 restocked)');

  // Over-refund through the J4 payment primitive after the full order refund.
  const ref2 = (await prisma.order.findUnique({ where: { id: o2.orderId } })).orderReference;
  const pay = await prisma.journalEntry.findFirst({ where: { reference: { in: [ref2, `${ref2}-J`] } } });
  assert.equal((await s.finance.call('POST', `money/payments/${encodeURIComponent(pay.reference)}/refund`, { amountKori: 1, reason: 'encore un peu' })).status, 409);

  // Another merchant's staff cannot cancel/refund this business's order, even by guessing the path.
  const other = await shop();
  assert.equal((await other.s.manager.call('POST', `${other.P}/orders/${o2.orderId}/refund`, { reason: 'vol' })).status, 404);
  assert.equal((await other.s.manager.call('POST', `${P}/orders/${o2.orderId}/refund`, { reason: 'vol' })).status, 404);
});

test('oversell race: two customers buy the last unit at the same time → exactly one order, money and stock reconcile', async () => {
  const { b, add } = await shop({ roles: [] });
  const last = await add({ title: 'Dernier boubou', priceKori: 500, initialStock: 1 });
  const [u1, u2] = [await buyer(1000), await buyer(1000)];
  const rs = await Promise.all([order(u1, b.id, [{ productId: last.id, quantity: 1 }]), order(u2, b.id, [{ productId: last.id, quantity: 1 }])]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 400], JSON.stringify(rs.map((r) => r.body)));
  assert.equal((await prisma.product.findUnique({ where: { id: last.id } })).inventory, 0);
  assert.equal(await bizBalance(b.id), 500);
  assert.equal((await walletOf(u1.id)) + (await walletOf(u2.id)), 1500, 'the loser was not charged');
  assert.equal(await prisma.order.count({ where: { businessId: b.id } }), 1);
  assert.equal(await prisma.stockMovement.count({ where: { productId: last.id, reason: 'sale' } }), 1);
});

test('backorders only when allowed; stock adjustments need a reason, are attributed, and never go negative otherwise', async () => {
  const { b, s, add, P } = await shop({ roles: ['inventory', 'cashier'] });
  const strict = await add({ title: 'Mangue', priceKori: 10, initialStock: 1 });
  const back = await add({ title: 'Couscous sur commande', priceKori: 10, initialStock: 0, allowBackorder: true });
  const u = await buyer();
  assert.equal((await order(u, b.id, [{ productId: strict.id, quantity: 2 }])).status, 400);
  assert.equal((await order(u, b.id, [{ productId: back.id, quantity: 2 }])).status, 201);
  assert.equal((await prisma.product.findUnique({ where: { id: back.id } })).inventory, -2, 'a backorder is visible as negative stock, not lost');

  assert.equal((await s.inventory.call('POST', `${P}/stock/${strict.id}/adjust`, { delta: 5 })).status, 400, 'reason required');
  assert.equal((await s.inventory.call('POST', `${P}/stock/${strict.id}/adjust`, { delta: -5, note: 'casse' })).status, 409, 'never negative without backorder');
  assert.equal((await s.cashier.call('POST', `${P}/stock/${strict.id}/adjust`, { delta: 5, note: 'livraison' })).status, 403, 'a cashier does not adjust stock');
  const adj = await s.inventory.call('POST', `${P}/stock/${strict.id}/adjust`, { count: 12, note: 'inventaire du lundi' });
  assert.equal(adj.status, 200, JSON.stringify(adj.body));
  assert.equal(adj.body.balanceAfter, 12);
  const m = await prisma.stockMovement.findUnique({ where: { id: adj.body.movementId } });
  assert.equal(m.actorUserId, s.inventory.id);
  assert.equal(m.reason, 'adjustment');
  await assert.rejects(prisma.$executeRawUnsafe(`UPDATE "StockMovement" SET delta = 0 WHERE id = '${m.id}'`), /append-only/);

  // Concurrent adjustments + sales: final stock == initial + Σ movements.
  await Promise.all([
    ...Array.from({ length: 4 }, () => order(u, b.id, [{ productId: strict.id, quantity: 1 }])),
    ...Array.from({ length: 3 }, (_, i) => s.inventory.call('POST', `${P}/stock/${strict.id}/adjust`, { delta: 2, note: `réception ${i}` })),
  ]);
  const sum = await prisma.stockMovement.aggregate({ where: { productId: strict.id }, _sum: { delta: true } });
  assert.equal((await prisma.product.findUnique({ where: { id: strict.id } })).inventory, sum._sum.delta);
});

test('delivery interaction, legacy settlement and split payments: refuse what cannot be refunded correctly', async () => {
  const { b, s, add, P } = await shop();
  const item = await add({ title: 'Panier légumes', priceKori: 200, initialStock: 5 });
  const u = await buyer(3000);
  const del = await u.call('POST', 'marketplace/orders', { businessId: b.id, items: [{ productId: item.id, quantity: 1 }], fulfillmentType: 'delivery', dropoff: { area: 'Médina', address: 'Rue 11' } }, { headers: { 'idempotency-key': key() } });
  assert.equal(del.status, 201, JSON.stringify(del.body));
  const task = await prisma.deliveryTask.findFirst({ where: { orderId: del.body.orderId } });
  await prisma.deliveryTask.update({ where: { id: task.id }, data: { status: 'assigned' } }); // a rider took it
  const blocked = await s.manager.call('POST', `${P}/orders/${del.body.orderId}/cancel`, { reason: 'annulation' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'delivery_in_progress');
  assert.equal(await walletOf(u.id), 2800, 'nothing refunded, nothing changed');

  // Legacy owner-personal settlement: staff cannot debit the owner's personal wallet.
  const legacy = await shop({ settlement: 'owner' });
  const li = await legacy.add({ title: 'Ancien', priceKori: 100, initialStock: 5 });
  const { body: lo } = await order(u, legacy.b.id, [{ productId: li.id, quantity: 1 }]);
  assert.equal((await prisma.order.findUnique({ where: { id: lo.orderId } })).settledTo, 'owner');
  const staffTry = await legacy.s.manager.call('POST', `${legacy.P}/orders/${lo.orderId}/cancel`, { reason: 'test' });
  assert.equal(staffTry.status, 403, 'staff cannot debit the owner’s personal wallet');
  assert.equal((await prisma.order.findUnique({ where: { id: lo.orderId } })).status, 'confirmed', 'nothing changed');
  assert.equal((await legacy.s.owner.call('POST', `${legacy.P}/orders/${lo.orderId}/cancel`, { reason: 'test' })).status, 200, 'the owner refunds from what they received');
});
