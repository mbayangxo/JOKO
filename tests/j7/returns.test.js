/**
 * J7.16 — returns are not refunds: no restock without goods back, no refund
 * without payment, quantities bounded by the order, resolution once.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { bizBal, depotRow, grantTerms, idemH, key, merchant, submit, supplier, withStepUp } from './fixture.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

async function deliveredPo(sup, m, { term = 'due_now', packs = 5 } = {}) {
  const po = (await submit(m, sup, { term, packs })).body;
  await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}/accept`, {});
  if (term === 'due_now') await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.id}/pay`, { expectedAmountKori: po.totalKori }, await withStepUp(m.owner));
  for (const to of ['preparing', 'ready']) await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}/advance`, { to });
  await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}/advance`, { to: 'fulfilment_requested', fulfilmentMode: 'seller_delivery' });
  return (await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}/advance`, { to: 'delivered' })).body;
}
const S = (sup, path, body) => sup.owner.call('POST', `businesses/${sup.b.id}/b2b/returns/${path}`, body);

test('paid order return: bounded quantities, approve → ship → receive (restock once) → refund once; no restock before goods are back', async () => {
  const sup = await supplier(api, { unitsPerPack: 12, stock: 600 });
  const m = await merchant(api, sup);
  const po = await deliveredPo(sup, m);
  const before = (await depotRow(sup)).onHand;
  const tooMany = await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.id}/returns`, { lines: [{ listingId: sup.listing.id, packs: 6 }], reason: 'cartons écrasés' }, idemH());
  assert.equal(tooMany.body.code, 'exceeds_ordered');
  const k = key();
  const r = await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.id}/returns`, { lines: [{ listingId: sup.listing.id, packs: 2 }], reason: 'cartons écrasés' }, idemH(k));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.amountKori, 2000, 'amount from the PO snapshot, not the request');
  const dup = await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.id}/returns`, { lines: [{ listingId: sup.listing.id, packs: 2 }], reason: 'cartons écrasés' }, idemH(k));
  assert.equal(dup.body.id, r.body.id);
  // Remaining returnable = 3; asking 4 more is refused.
  const more = await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.id}/returns`, { lines: [{ listingId: sup.listing.id, packs: 4 }], reason: 'encore abîmés' }, idemH());
  assert.equal(more.body.code, 'exceeds_ordered');

  // Seller cannot receive (or restock) before approval + shipment; buyer cannot approve.
  assert.equal((await S(sup, `${r.body.id}/receive`, { restock: true })).body.code, 'invalid_state');
  assert.equal((await m.owner.call('POST', `businesses/${m.b.id}/b2b/returns/${r.body.id}/decide`, { approve: true })).status, 404);
  assert.equal((await S(sup, `${r.body.id}/decide`, { approve: true })).body.status, 'approved');
  assert.equal((await S(sup, `${r.body.id}/resolve`, { resolution: 'refund' })).body.code, 'invalid_state', 'no refund before the goods are received');
  assert.equal((await S(sup, `${r.body.id}/receive`, { restock: true })).body.code, 'invalid_state');
  assert.equal((await depotRow(sup)).onHand, before, 'no restock without goods');
  const ship = await m.owner.call('POST', `businesses/${m.b.id}/b2b/returns/${r.body.id}/ship`, {});
  assert.equal(ship.body.status, 'goods_returned');
  const [rc1, rc2] = await Promise.all([S(sup, `${r.body.id}/receive`, { restock: true }), S(sup, `${r.body.id}/receive`, { restock: true })]);
  assert.deepEqual([rc1.status, rc2.status].sort(), [200, 409]);
  assert.equal((await depotRow(sup)).onHand, before + 24, 'restocked exactly once');

  const bal = await bizBal(m.b.id);
  const [f1, f2] = await Promise.all([
    sup.owner.call('POST', `businesses/${sup.b.id}/b2b/returns/${r.body.id}/resolve`, { resolution: 'refund' }, idemH()),
    sup.owner.call('POST', `businesses/${sup.b.id}/b2b/returns/${r.body.id}/resolve`, { resolution: 'refund' }, idemH()),
  ]);
  assert.deepEqual([f1.status, f2.status].sort(), [200, 409], JSON.stringify([f1.body, f2.body]));
  assert.equal(await bizBal(m.b.id), bal + 2000, 'refunded once');
});

test('credit-term return resolves as a credit memo on the invoice; refund without payment is refused', async () => {
  const sup = await supplier(api);
  const m = await merchant(api, sup);
  await grantTerms(sup, m, { limit: 20_000 });
  const po = await deliveredPo(sup, m, { term: 'net30', packs: 5 });
  assert.ok(po.invoiceId);
  const r = (await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.id}/returns`, { lines: [{ listingId: sup.listing.id, packs: 1 }], reason: 'date courte' }, idemH())).body;
  await S(sup, `${r.id}/decide`, { approve: true });
  await m.owner.call('POST', `businesses/${m.b.id}/b2b/returns/${r.id}/ship`, {});
  await S(sup, `${r.id}/receive`, { restock: false });
  const refund = await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/returns/${r.id}/resolve`, { resolution: 'refund' }, idemH());
  assert.equal(refund.body.code, 'refund_exceeds_paid', 'nothing was paid on this invoice yet');
  const cm = await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/returns/${r.id}/resolve`, { resolution: 'credit_memo' }, idemH());
  assert.equal(cm.status, 200, JSON.stringify(cm.body));
  const inv = await prisma.tradeInvoice.findUnique({ where: { id: po.invoiceId } });
  assert.deepEqual({ principal: inv.amountKori, credited: inv.creditedKori }, { principal: 5000, credited: 1000 });
  const again = await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/returns/${r.id}/resolve`, { resolution: 'credit_memo' }, idemH());
  assert.equal(again.body.code, 'invalid_state', 'credit memo applied once');
  assert.equal(await prisma.creditMemo.count({ where: { invoiceId: po.invoiceId } }), 1);
  // Rejected return is final.
  const r2 = (await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.id}/returns`, { lines: [{ listingId: sup.listing.id, packs: 1 }], reason: 'autre souci' }, idemH())).body;
  assert.equal((await S(sup, `${r2.id}/decide`, { approve: false, note: 'non conforme' })).body.status, 'rejected');
  assert.equal((await m.owner.call('POST', `businesses/${m.b.id}/b2b/returns/${r2.id}/ship`, {})).body.code, 'invalid_state');
});

test('return before delivery is refused', async () => {
  const sup = await supplier(api);
  const m = await merchant(api, sup);
  const po = (await submit(m, sup, { packs: 2 })).body;
  const r = await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.id}/returns`, { lines: [{ listingId: sup.listing.id, packs: 1 }], reason: 'pas reçu' }, idemH());
  assert.equal(r.body.code, 'invalid_state');
});
