/**
 * D44 — merchant-side return stock accounting, over HTTP.
 *
 * A return request changes no stock. Shipping it creates a ReturnStockHold per product:
 * sellable units leave the buyer's own (mapped) product into quarantine — never below zero;
 * damaged units (bounded by what receiving recorded) touch no stock. Handover is verified
 * (courier pickup with the buyer's code) or self-reported (untracked). A cancelled / failed
 * collection releases the hold once and the return can be shipped again.
 * J2 + J8 invariants (incl. L9) after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { assertLogisticsInvariants, checkLogisticsInvariants } from '../../lib/logistics/invariants.js';
import { customer, signedIn } from '../j3/helpers.js';
import { fleetDriver, readyPo, shipmentFor } from './fixture.js';
import { returnCollectionKey } from '../../lib/b2b/returns.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => {
  await assertInvariants(prisma);
  await assertLogisticsInvariants(prisma);
});

const ok = (r, what = '') => {
  assert.ok(r.status >= 200 && r.status < 300, `${what} ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const inv = async (id) => (await prisma.product.findUnique({ where: { id } })).inventory;
const holds = (returnId) => prisma.returnStockHold.findMany({ where: { returnId }, orderBy: [{ attempt: 'asc' }] });
let seq = 0;

/** A PO delivered over J8 and received into the buyer's OWN mapped product (2 packs × 12 = 24 units). */
async function delivered({ damaged = 0, map = true } = {}) {
  const x = await readyPo(api, { packs: 2, stock: 240 });
  const driver = await fleetDriver(api, x.sup.b);
  const mine = await prisma.product.create({ data: { businessId: x.m.b.id, title: 'Huile 1L (rayon)', price: 1700, inventory: 0, category: 'epicerie' } });
  if (map) ok(await x.m.owner.call('POST', `businesses/${x.m.b.id}/b2b/product-mappings`, { sellerProductId: x.sup.product.id, buyerProductId: mine.id }), 'map');
  ok(await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/b2b/purchase-orders/${x.po.id}/advance`, { to: 'fulfilment_requested', fulfilmentMode: 'seller_delivery', tracked: true }));
  const sh = await shipmentFor(x.po.id);
  ok(await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/assign`, { courierUserId: driver.id }));
  const pc = ok(await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/codes`, { purpose: 'pickup' }));
  ok(await driver.call('POST', `logistics/shipments/${sh.id}/pickup`, { code: pc.code }));
  ok(await driver.call('POST', `logistics/shipments/${sh.id}/step`, { step: 'arrive_delivery' }));
  ok(await x.m.owner.call('POST', `logistics/shipments/${sh.id}/receiving`, { lines: [{ productId: x.sup.product.id, received: 24 - damaged, damaged }] }), 'receiving');
  return { ...x, driver, mine };
}

async function approvedReturn(x, { packs = 1, fromDamagedUnits } = {}) {
  const line = { listingId: x.sup.listing.id, packs, ...(fromDamagedUnits !== undefined ? { fromDamagedUnits } : {}) };
  const ret = ok(await x.m.owner.call('POST', `businesses/${x.m.b.id}/b2b/purchase-orders/${x.po.id}/returns`, { lines: [line], reason: 'date courte' }, { headers: { 'idempotency-key': `ret-${x.po.id}-${(seq += 1)}` } }), 'request');
  ok(await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/b2b/returns/${ret.id}/decide`, { approve: true }), 'approve');
  return ret;
}
const ship = (x, ret, body = {}) => x.m.owner.call('POST', `businesses/${x.m.b.id}/b2b/returns/${ret.id}/ship`, body);
const collection = async (ret, attempt) => {
  const req = await prisma.fulfilmentRequest.findUnique({ where: { sourceKey: returnCollectionKey(ret.id, attempt) } });
  return req && prisma.shipment.findFirst({ where: { requestId: req.id } });
};

test('request changes nothing; untracked ship quarantines sellable units once (self-reported handover); retries never deduct twice', async () => {
  const x = await delivered();
  assert.equal(await inv(x.mine.id), 24);
  const ret = await approvedReturn(x, { packs: 1 });
  assert.equal(await inv(x.mine.id), 24, 'a request / approval moves no stock');
  assert.equal((await holds(ret.id)).length, 0);

  const s = ok(await ship(x, ret));
  assert.equal(s.status, 'goods_returned');
  assert.equal(s.shipAttempts, 1);
  assert.equal(await inv(x.mine.id), 12);
  const [h] = await holds(ret.id);
  assert.deepEqual([h.state, h.handoverEvidence, h.sellableUnits, h.damagedUnits, h.buyerProductId], ['handed_over', 'self_reported', 12, 0, x.mine.id]);
  // Retry / double tap: refused, no second deduction.
  assert.equal((await ship(x, ret)).body.code, 'invalid_state');
  assert.equal(await inv(x.mine.id), 12);
  // Seller receives (untracked) with restock into the depot; the buyer's side does not move again.
  ok(await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/b2b/returns/${ret.id}/receive`, { restock: true }));
  assert.equal(await inv(x.mine.id), 12);
  const mv = await prisma.stockMovement.findMany({ where: { productId: x.mine.id, reason: { in: ['return_quarantine', 'return_release'] } } });
  assert.deepEqual(mv.map((m) => [m.reason, m.delta]), [['return_quarantine', -12]]);
});

test('tracked: quarantined at ship → handed_over only on the courier’s verified pickup → seller receiving does not touch buyer stock', async () => {
  const x = await delivered();
  const ret = await approvedReturn(x, { packs: 1 });
  ok(await ship(x, ret, { tracked: true }));
  assert.equal(await inv(x.mine.id), 12);
  assert.equal((await holds(ret.id))[0].state, 'quarantined');
  const rsh = await collection(ret, 1);
  ok(await x.sup.owner.call('POST', `logistics/shipments/${rsh.id}/assign`, { courierUserId: x.driver.id }));
  const bad = await x.driver.call('POST', `logistics/shipments/${rsh.id}/pickup`, { code: 'ABCDEFGH' });
  assert.equal(bad.body.code, 'code_invalid');
  assert.equal((await holds(ret.id))[0].state, 'quarantined', 'a wrong code is no handover');
  const pc = ok(await x.m.owner.call('POST', `logistics/shipments/${rsh.id}/codes`, { purpose: 'pickup' }));
  ok(await x.driver.call('POST', `logistics/shipments/${rsh.id}/pickup`, { code: pc.code }));
  assert.equal((await x.driver.call('POST', `logistics/shipments/${rsh.id}/pickup`, { code: pc.code })).body.replayed, true);
  const [h] = await holds(ret.id);
  assert.deepEqual([h.state, h.handoverEvidence], ['handed_over', 'courier_code']);
  // Once handed over, the buyer cannot cancel the collection (goods have left).
  assert.equal((await x.m.owner.call('POST', `logistics/shipments/${rsh.id}/cancel`, { reason: 'erreur' })).body.code, 'invalid_state');
  ok(await x.driver.call('POST', `logistics/shipments/${rsh.id}/step`, { step: 'arrive_delivery' }));
  ok(await x.sup.owner.call('POST', `logistics/shipments/${rsh.id}/receiving`, { lines: [{ productId: x.sup.product.id, received: 12 }] }));
  assert.equal(await inv(x.mine.id), 12, 'no buyer-side double deduction or restock');
  assert.equal((await prisma.commercialReturn.findUnique({ where: { id: ret.id } })).status, 'received');
});

test('cancelled collection releases once and the return can be shipped again (new attempt, new shipment); replays never restock twice', async () => {
  const x = await delivered();
  const ret = await approvedReturn(x, { packs: 2 });
  ok(await ship(x, ret, { tracked: true }));
  assert.equal(await inv(x.mine.id), 0);
  const rsh = await collection(ret, 1);
  ok(await x.m.owner.call('POST', `logistics/shipments/${rsh.id}/cancel`, { reason: 'pas prêt' }));
  assert.equal(await inv(x.mine.id), 24, 'sellable units back, once');
  assert.equal((await x.m.owner.call('POST', `logistics/shipments/${rsh.id}/cancel`, { reason: 'pas prêt' })).body.code, 'invalid_state');
  assert.equal(await inv(x.mine.id), 24);
  let r = await prisma.commercialReturn.findUnique({ where: { id: ret.id } });
  assert.deepEqual([r.status, r.shipAttempts], ['approved', 1]);
  assert.equal((await holds(ret.id))[0].state, 'released');
  // The seller cannot "receive" goods that never left.
  assert.equal((await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/b2b/returns/${ret.id}/receive`, { restock: true })).body.code, 'invalid_state');

  ok(await ship(x, ret, { tracked: true }));
  assert.equal(await inv(x.mine.id), 0);
  const rsh2 = await collection(ret, 2);
  assert.ok(rsh2 && rsh2.id !== rsh.id, 'attempt 2 has its own collection');
  const hs = await holds(ret.id);
  assert.deepEqual(hs.map((h) => [h.attempt, h.state]), [[1, 'released'], [2, 'quarantined']]);
  r = await prisma.commercialReturn.findUnique({ where: { id: ret.id } });
  assert.equal(r.shipAttempts, 2);
  assert.equal((await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/b2b/returns/${ret.id}/receive`, { restock: true })).body.code, 'received_by_shipment');
});

test('failed collection: goods back at the buyer with the buyer’s code → released once; return re-shippable', async () => {
  const x = await delivered();
  const ret = await approvedReturn(x, { packs: 1 });
  ok(await ship(x, ret, { tracked: true }));
  const rsh = await collection(ret, 1);
  ok(await x.sup.owner.call('POST', `logistics/shipments/${rsh.id}/assign`, { courierUserId: x.driver.id }));
  const pc = ok(await x.m.owner.call('POST', `logistics/shipments/${rsh.id}/codes`, { purpose: 'pickup' }));
  ok(await x.driver.call('POST', `logistics/shipments/${rsh.id}/pickup`, { code: pc.code }));
  ok(await x.driver.call('POST', `logistics/shipments/${rsh.id}/fail`, { reason: 'merchant_closed' }));
  ok(await x.driver.call('POST', `logistics/shipments/${rsh.id}/return/start`, {}));
  assert.equal(await inv(x.mine.id), 12, 'still out while the courier holds it');
  const rc = ok(await x.m.owner.call('POST', `logistics/shipments/${rsh.id}/codes`, { purpose: 'return_delivery' }));
  ok(await x.driver.call('POST', `logistics/shipments/${rsh.id}/return/complete`, { code: rc.code }));
  assert.equal((await x.driver.call('POST', `logistics/shipments/${rsh.id}/return/complete`, { code: rc.code })).body.replayed, true);
  assert.equal(await inv(x.mine.id), 24, 'released once');
  assert.equal((await holds(ret.id))[0].state, 'released');
  assert.equal((await prisma.commercialReturn.findUnique({ where: { id: ret.id } })).status, 'approved');
  ok(await ship(x, ret));
  assert.equal(await inv(x.mine.id), 12);
});

test('damaged units: bounded by the receiving record, never deducted from sellable stock, never reused across returns', async () => {
  const x = await delivered({ damaged: 3 }); // 21 credited, 3 recorded damaged (never credited)
  assert.equal(await inv(x.mine.id), 21);
  const over = await x.m.owner.call('POST', `businesses/${x.m.b.id}/b2b/purchase-orders/${x.po.id}/returns`, { lines: [{ listingId: x.sup.listing.id, packs: 1, fromDamagedUnits: 4 }], reason: 'abîmé' }, { headers: { 'idempotency-key': `ret-over-${x.po.id}` } });
  assert.equal(over.body.code, 'exceeds_damaged');
  const neg = await x.m.owner.call('POST', `businesses/${x.m.b.id}/b2b/purchase-orders/${x.po.id}/returns`, { lines: [{ listingId: x.sup.listing.id, packs: 1, fromDamagedUnits: -1 }], reason: 'abîmé' }, { headers: { 'idempotency-key': `ret-neg-${x.po.id}` } });
  assert.equal(neg.status, 400);
  const ret = await approvedReturn(x, { packs: 1, fromDamagedUnits: 2 });
  ok(await ship(x, ret));
  const [h] = await holds(ret.id);
  assert.deepEqual([h.sellableUnits, h.damagedUnits], [10, 2]);
  assert.equal(await inv(x.mine.id), 11, 'only the 10 sellable units leave stock');
  // Only 1 damaged unit remains on the receiving record.
  const again = await x.m.owner.call('POST', `businesses/${x.m.b.id}/b2b/purchase-orders/${x.po.id}/returns`, { lines: [{ listingId: x.sup.listing.id, packs: 1, fromDamagedUnits: 2 }], reason: 'abîmé encore' }, { headers: { 'idempotency-key': `ret-again-${x.po.id}` } });
  assert.equal(again.body.code, 'exceeds_damaged');
});

test('a rejected return creates no hold; a rejected return’s damaged units become available again', async () => {
  const x = await delivered({ damaged: 2 });
  const r1 = ok(await x.m.owner.call('POST', `businesses/${x.m.b.id}/b2b/purchase-orders/${x.po.id}/returns`, { lines: [{ listingId: x.sup.listing.id, packs: 1, fromDamagedUnits: 2 }], reason: 'abîmé' }, { headers: { 'idempotency-key': `ret-r1-${x.po.id}` } }));
  ok(await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/b2b/returns/${r1.id}/decide`, { approve: false, note: 'non' }));
  assert.equal((await ship(x, r1)).body.code, 'invalid_state');
  assert.equal((await holds(r1.id)).length, 0);
  assert.equal(await inv(x.mine.id), 22);
  const r2 = await approvedReturn(x, { packs: 1, fromDamagedUnits: 2 });
  ok(await ship(x, r2));
  assert.equal(await inv(x.mine.id), 12);
});

test('no negative stock: shipping more sellable units than the buyer holds is refused atomically (no hold, status unchanged)', async () => {
  const x = await delivered();
  await prisma.product.update({ where: { id: x.mine.id }, data: { inventory: 5 } }); // sold most of it
  const ret = await approvedReturn(x, { packs: 1 });
  const r = await ship(x, ret);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'insufficient_stock');
  assert.equal(await inv(x.mine.id), 5);
  assert.equal((await holds(ret.id)).length, 0);
  assert.equal((await prisma.commercialReturn.findUnique({ where: { id: ret.id } })).status, 'approved');
});

test('concurrency: 6 simultaneous ships of one return and two returns racing for the same stock never over-deduct', async () => {
  const x = await delivered();
  const ret = await approvedReturn(x, { packs: 1 });
  const res = await Promise.all(Array.from({ length: 6 }, () => ship(x, ret)));
  assert.equal(res.filter((r) => r.status === 200).length, 1);
  assert.equal(await inv(x.mine.id), 12);
  assert.equal((await holds(ret.id)).length, 1);
  // 12 left; two 1-pack returns race; then one more that cannot fit.
  await prisma.product.update({ where: { id: x.mine.id }, data: { inventory: 12 } });
  const y = await delivered();
  await prisma.product.update({ where: { id: y.mine.id }, data: { inventory: 12 } });
  const a = await approvedReturn(y, { packs: 1 });
  const b = await approvedReturn(y, { packs: 1 });
  const both = await Promise.all([ship(y, a), ship(y, b)]);
  assert.equal(both.filter((r) => r.status === 200).length, 1, 'only one fits in 12 units');
  assert.equal(await inv(y.mine.id), 0);
});

test('unmapped goods: hold recorded with no buyer product and no stock effect', async () => {
  const x = await delivered({ map: false });
  assert.equal(await inv(x.mine.id), 0);
  const ret = await approvedReturn(x, { packs: 1 });
  ok(await ship(x, ret, { tracked: true }));
  const [h] = await holds(ret.id);
  assert.deepEqual([h.buyerProductId, h.sellableUnits, h.state], [null, 12, 'quarantined']);
  const rsh = await collection(ret, 1);
  ok(await x.m.owner.call('POST', `logistics/shipments/${rsh.id}/cancel`, { reason: 'pas prêt' }));
  assert.equal(await inv(x.mine.id), 0);
  assert.equal((await holds(ret.id))[0].state, 'released');
});

test('authorization: only the buyer with purchasing authority ships; seller, its driver and outsiders are refused with no stock effect', async () => {
  const x = await delivered();
  const ret = await approvedReturn(x, { packs: 1 });
  const outsider = await signedIn(api, await customer());
  // Non-members of the buyer business are stopped at the J3 route gate (403); the seller acting via its own business id sees nothing (404).
  for (const s2 of [outsider, x.sup.owner, x.driver]) assert.equal((await s2.call('POST', `businesses/${x.m.b.id}/b2b/returns/${ret.id}/ship`, {})).status, 403);
  assert.equal((await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/b2b/returns/${ret.id}/ship`, {})).status, 404);
  assert.equal(await inv(x.mine.id), 24);
  assert.equal((await holds(ret.id)).length, 0);
});

test('DB guard: holds are append-only — no delete, immutable quantities, state only forward; L9 detects a tampered movement', async () => {
  const x = await delivered();
  const ret = await approvedReturn(x, { packs: 1 });
  ok(await ship(x, ret, { tracked: true }));
  const [h] = await holds(ret.id);
  await assert.rejects(prisma.returnStockHold.delete({ where: { id: h.id } }));
  await assert.rejects(prisma.returnStockHold.update({ where: { id: h.id }, data: { sellableUnits: 1 } }));
  await assert.rejects(prisma.returnStockHold.create({ data: { returnId: ret.id, attempt: 9, buyerBusinessId: x.m.b.id, sellerProductId: 'p', sellableUnits: 0, damagedUnits: 0 } }));
  const rsh = await collection(ret, 1);
  ok(await x.m.owner.call('POST', `logistics/shipments/${rsh.id}/cancel`, { reason: 'pas prêt' }));
  await assert.rejects(prisma.returnStockHold.update({ where: { id: h.id }, data: { state: 'quarantined' } }), 'released is final');
  // Detection: a forged extra release movement is caught by L9.
  const m = await prisma.stockMovement.create({ data: { productId: x.mine.id, businessId: x.m.b.id, delta: 12, balanceAfter: 36, reason: 'return_release', note: `hold:${h.id}` } });
  const chk = await checkLogisticsInvariants(prisma);
  assert.ok(chk.violations.some((v) => v.id === 'L9'), 'L9 flags the double restock');
  await prisma.$executeRawUnsafe('ALTER TABLE "StockMovement" DISABLE TRIGGER USER');
  try { await prisma.stockMovement.delete({ where: { id: m.id } }); } finally { await prisma.$executeRawUnsafe('ALTER TABLE "StockMovement" ENABLE TRIGGER USER'); }
});
