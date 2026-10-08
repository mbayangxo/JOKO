/**
 * J7.5–J7.7, J7.14, J7.15 — wholesale catalog, server pricing and the B2B
 * purchase-order lifecycle over HTTP (production-mode server). J2 invariants
 * after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { bizBal, depotRow, idemH, key, member, merchant, submit, supplier, withStepUp } from './fixture.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

test('due-now PO: server price, idempotent submit, accept reserves depot stock, pay ≠ deliver, seller-recorded delivery, buyer receives', async () => {
  const sup = await supplier(api, { priceKori: 1000, tiers: [{ minPacks: 10, priceKori: 900 }] });
  const m = await merchant(api, sup);
  const clerk = await member(api, m.b, 'inventory'); // business.purchasing, NOT business.pay

  // Catalog: only for connected buyers; tier pricing shown.
  const cat = await m.owner.call('GET', `businesses/${m.b.id}/b2b/suppliers/${sup.b.id}/catalog`);
  assert.equal(cat.status, 200, JSON.stringify(cat.body));
  assert.equal(cat.body.items[0].priceKori, 1000);
  assert.deepEqual(cat.body.items[0].tiers, [{ minPacks: 10, priceKori: 900 }]);

  // Quote uses the tier at 10 packs.
  const q = await clerk.call('POST', `businesses/${m.b.id}/b2b/quote`, { sellerBusinessId: sup.b.id, lines: [{ listingId: sup.listing.id, packs: 10 }] });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.totalKori, 9000);
  assert.equal(q.body.lines[0].priceSource, 'tier');

  // Manipulated requests: a client price field is rejected outright; a forged total is refused.
  const forged = await clerk.call('POST', `businesses/${m.b.id}/b2b/purchase-orders`, { sellerBusinessId: sup.b.id, lines: [{ listingId: sup.listing.id, packs: 10, unitPriceKori: 1 }], expectedTotalKori: 10 }, idemH());
  assert.equal(forged.status, 400, JSON.stringify(forged.body));
  const lowTotal = await submit(m, sup, { packs: 10, expected: 100, as: clerk });
  assert.equal(lowTotal.status, 409);
  assert.equal(lowTotal.body.code, 'price_changed');
  assert.equal(lowTotal.body.totalKori, 9000);

  const k = key();
  const po = await submit(m, sup, { packs: 10, expected: 9000, k, as: clerk });
  assert.equal(po.status, 201, JSON.stringify(po.body));
  assert.equal(po.body.status, 'submitted');
  assert.equal(po.body.lines[0].unitPriceKori, 900);
  const again = await submit(m, sup, { packs: 10, expected: 9000, k, as: clerk });
  assert.equal(again.body.id, po.body.id, 'retry with the same key returns the same PO');
  assert.equal(await prisma.purchaseOrder.count({ where: { buyerBusinessId: m.b.id } }), 1);
  const reuse = await submit(m, sup, { packs: 11, expected: 9900, k, as: clerk });
  assert.ok([409, 422].includes(reuse.status), JSON.stringify(reuse.body));

  // Buyer cannot accept its own order; seller accepts (reserves 10 × 12 units).
  const selfAccept = await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.body.id}/accept`, {});
  assert.equal(selfAccept.status, 404);
  const acc = await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.body.id}/accept`, {});
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  assert.equal(acc.body.status, 'accepted');
  assert.equal((await depotRow(sup)).reserved, 120);

  // Pay: needs business.pay + step-up + exact amount.
  const noStep = await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.body.id}/pay`, { expectedAmountKori: 9000 }, idemH());
  assert.equal(noStep.status, 403);
  assert.equal(noStep.body.code, 'step_up_required');
  const clerkPay = await clerk.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.body.id}/pay`, { expectedAmountKori: 9000 }, await withStepUp(clerk));
  assert.equal(clerkPay.status, 403, JSON.stringify(clerkPay.body));
  const wrong = await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.body.id}/pay`, { expectedAmountKori: 8999 }, await withStepUp(m.owner));
  assert.equal(wrong.body.code, 'amount_mismatch');
  const before = { buyer: await bizBal(m.b.id), seller: await bizBal(sup.b.id) };
  const paid = await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.body.id}/pay`, { expectedAmountKori: 9000 }, await withStepUp(m.owner));
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.status, 'confirmed', 'payment confirms — it does not deliver');
  assert.equal(paid.body.deliveredAt, null);
  const payAgain = await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.body.id}/pay`, { expectedAmountKori: 9000 }, await withStepUp(m.owner));
  assert.equal(payAgain.status, 200);
  assert.equal(await bizBal(m.b.id), before.buyer - 9000, 'buyer debited once');
  assert.equal(await bizBal(sup.b.id), before.seller + 9000, 'seller credited once');
  assert.equal(await prisma.paymentRecord.count({ where: { businessId: sup.b.id, sourceChannel: 'b2b_purchase_order' } }), 1);

  // Seller flow; transitions cannot be skipped; Jokko Logistics is dormant.
  const skip = await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.body.id}/advance`, { to: 'delivered' });
  assert.equal(skip.body.code, 'invalid_transition');
  const buyerAdv = await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.body.id}/advance`, { to: 'preparing' });
  assert.equal(buyerAdv.status, 404, 'buyer cannot drive seller transitions');
  for (const to of ['preparing', 'ready']) {
    const r = await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.body.id}/advance`, { to });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const jl = await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.body.id}/advance`, { to: 'fulfilment_requested', fulfilmentMode: 'jokko_logistics' });
  assert.equal(jl.body.code, 'fulfilment_not_activated');
  const fr = await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.body.id}/advance`, { to: 'fulfilment_requested', fulfilmentMode: 'seller_delivery' });
  assert.equal(fr.status, 200, JSON.stringify(fr.body));
  const d = await depotRow(sup);
  assert.deepEqual({ onHand: d.onHand, reserved: d.reserved }, { onHand: 1200 - 120, reserved: 0 }, 'dispatch decrements once');
  // Buyer cannot receive before the seller records delivery.
  const early = await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.body.id}/buyer`, { action: 'receive' });
  assert.equal(early.body.code, 'invalid_state');
  const del = await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.body.id}/advance`, { to: 'delivered' });
  assert.equal(del.body.deliveryRecordedBy, 'seller_self_reported');
  assert.equal(del.body.deliveryVerified, false, 'D34: a seller’s own record is never presented as proof');
  const rcv = await clerk.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.body.id}/buyer`, { action: 'receive' });
  assert.equal(rcv.body.status, 'received');
  const done = await clerk.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.body.id}/buyer`, { action: 'complete' });
  assert.equal(done.body.status, 'completed');

  const detail = await m.owner.call('GET', `businesses/${m.b.id}/b2b/purchase-orders/${po.body.id}`);
  assert.deepEqual(detail.body.history.map((h) => h.to), ['submitted', 'accepted', 'confirmed', 'preparing', 'ready', 'fulfilment_requested', 'delivered', 'received', 'completed']);
  // History is append-only.
  await assert.rejects(prisma.purchaseOrderEvent.deleteMany({ where: { purchaseOrderId: po.body.id } }));
  await assert.rejects(prisma.purchaseOrder.update({ where: { id: po.body.id }, data: { totalKori: 1 } }));
  const outbox = await prisma.commerceEvent.findMany({ where: { aggregateType: 'purchase_order', aggregateId: po.body.id } });
  assert.ok(outbox.some((e) => e.type === 'fulfillment.requested'));
});

test('MOQ / step / out-of-stock / inactive listing / unknown listing are enforced server-side', async () => {
  const sup = await supplier(api, { moqPacks: 5, stepPacks: 5 });
  const m = await merchant(api, sup);
  const below = await submit(m, sup, { packs: 3 });
  assert.equal(below.body.code, 'below_moq');
  const step = await submit(m, sup, { packs: 7 });
  assert.equal(step.body.code, 'bad_step');
  assert.equal((await submit(m, sup, { packs: 10 })).status, 201);
  await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/listings`, { sku: sup.listing.sku, title: sup.listing.title, priceKori: 1000, moqPacks: 5, stepPacks: 5, availability: 'out_of_stock' });
  assert.equal((await submit(m, sup, { packs: 10 })).body.code, 'out_of_stock');
  await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/listings`, { sku: sup.listing.sku, title: sup.listing.title, priceKori: 1000, status: 'inactive' });
  assert.equal((await submit(m, sup, { packs: 10 })).status, 404);
  const other = await supplier(api);
  const foreign = await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders`, { sellerBusinessId: sup.b.id, lines: [{ listingId: other.listing.id, packs: 1 }], expectedTotalKori: 1000 }, idemH());
  assert.equal(foreign.status, 404, 'another supplier’s listing cannot be ordered through this supplier');
});

test('depot cannot be oversold: accepts beyond available stock are refused; reservations are exact under concurrency', async () => {
  const sup = await supplier(api, { unitsPerPack: 10, stock: 100 });
  const buyers = await Promise.all(Array.from({ length: 6 }, () => merchant(api, sup)));
  const pos = [];
  for (const m of buyers) pos.push((await submit(m, sup, { packs: 3 })).body); // 30 units each, 180 demanded vs 100
  const res = await Promise.all(pos.map((po) => sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}/accept`, {})));
  const ok = res.filter((r) => r.status === 200).length;
  assert.equal(ok, 3, JSON.stringify(res.map((r) => r.body.code ?? r.body.status)));
  assert.ok(res.filter((r) => r.status !== 200).every((r) => r.body.code === 'insufficient_stock'));
  const d = await depotRow(sup);
  assert.equal(d.reserved, 90);
  assert.equal(d.onHand, 100);
  const moves = await prisma.depotStockMovement.aggregate({ where: { locationId: sup.depot.id, productId: sup.product.id }, _sum: { deltaReserved: true, deltaOnHand: true } });
  assert.equal(moves._sum.deltaReserved, d.reserved, 'movements reconcile with the position');
  assert.equal(moves._sum.deltaOnHand, d.onHand);
  await assert.rejects(prisma.depotStock.update({ where: { id: d.id }, data: { reserved: 1000 } }), 'DB check refuses over-reservation');
});

test('cancellation: once only (concurrent), releases stock once, refunds a paid order from the seller (business.refund), seller suspension does not block the refund', async () => {
  const sup = await supplier(api);
  const m = await merchant(api, sup);
  const fulfil = await member(api, sup.b, 'fulfillment'); // can accept, cannot cancel/refund
  const po = (await submit(m, sup, { packs: 5 })).body;
  await fulfil.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}/accept`, {});
  await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.id}/pay`, { expectedAmountKori: 5000 }, await withStepUp(m.owner));
  const buyerBal = await bizBal(m.b.id);
  // Buyer can no longer cancel a confirmed order.
  const late = await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.id}/cancel`, { reason: 'changed my mind' }, idemH());
  assert.equal(late.body.code, 'invalid_state');
  const noCap = await fulfil.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}/cancel`, { reason: 'stock error' }, idemH());
  assert.equal(noCap.status, 403, JSON.stringify(noCap.body));
  await prisma.business.update({ where: { id: sup.b.id }, data: { status: 'suspended' } });
  const [c1, c2] = await Promise.all([
    sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}/cancel`, { reason: 'stock error' }, idemH()),
    sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}/cancel`, { reason: 'stock error' }, idemH()),
  ]);
  assert.deepEqual([c1.status, c2.status].sort(), [200, 409], JSON.stringify([c1.body, c2.body]));
  assert.equal(await bizBal(m.b.id), buyerBal + 5000, 'refunded exactly once');
  const d = await depotRow(sup);
  assert.equal(d.reserved, 0, 'reservation released once');
  const v = await m.owner.call('GET', `businesses/${m.b.id}/b2b/purchase-orders/${po.id}`);
  assert.equal(v.body.paymentStatus, 'refunded');
  await prisma.business.update({ where: { id: sup.b.id }, data: { status: 'active' } });
});

test('suspended supplier takes no new PO and no PO payment; nothing moves', async () => {
  const sup = await supplier(api);
  const m = await merchant(api, sup);
  const po = (await submit(m, sup, { packs: 1 })).body;
  await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}/accept`, {});
  await prisma.business.update({ where: { id: sup.b.id }, data: { status: 'suspended' } });
  const bal = await bizBal(m.b.id);
  const fresh = await submit(m, sup, { packs: 1 });
  assert.equal(fresh.body.code, 'business_inactive');
  const pay = await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.id}/pay`, { expectedAmountKori: 1000 }, await withStepUp(m.owner));
  assert.equal(pay.body.code, 'business_inactive');
  assert.equal(await bizBal(m.b.id), bal);
  await prisma.business.update({ where: { id: sup.b.id }, data: { status: 'active' } });
});
