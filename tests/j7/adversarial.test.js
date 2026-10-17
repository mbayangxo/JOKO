/**
 * J7 adversarial lab (the cases not already covered by the lifecycle, credit,
 * returns and privacy suites). J2 invariants after every test.
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

const S = (sup, po, action, body = {}) => sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po}/${action}`, body, idemH());
const B = (m, po, action, body = {}) => m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po}/${action}`, body, idemH());

test('ended / invited / replayed relationship cannot order; a relationship of another pair cannot be borrowed', async () => {
  const sup = await supplier(api);
  const m = await merchant(api, sup);
  assert.equal((await submit(m, sup)).status, 201);
  await prisma.merchantRelationship.update({ where: { id: m.rel.id }, data: { status: 'ended', endedAt: new Date() } });
  assert.equal((await submit(m, sup)).status, 404, 'ended relationship: no ordering');
  assert.equal((await m.owner.call('GET', `businesses/${m.b.id}/b2b/suppliers/${sup.b.id}/catalog`)).status, 404);
  const invited = await merchant(api, sup, { connect: false });
  await prisma.merchantRelationship.create({ data: { distributorBusinessId: sup.b.id, merchantBusinessId: invited.b.id, introducedByUserId: sup.ownerC.id, status: 'invited' } });
  assert.equal((await submit(invited, sup)).status, 404, 'invitation is not access');
  // Scope without wholesale_ordering: catalog only.
  const catOnly = await merchant(api, sup, { connect: false });
  await prisma.merchantRelationship.create({ data: { distributorBusinessId: sup.b.id, merchantBusinessId: catOnly.b.id, introducedByUserId: sup.ownerC.id, status: 'active', scopesJson: '["wholesale_catalog"]' } });
  assert.equal((await catOnly.owner.call('GET', `businesses/${catOnly.b.id}/b2b/suppliers/${sup.b.id}/catalog`)).status, 200);
  assert.equal((await submit(catOnly, sup)).status, 404);
});

test('relationship ended racing a submit: all-or-nothing', async () => {
  const sup = await supplier(api);
  const m = await merchant(api, sup);
  const [s, end] = await Promise.all([
    submit(m, sup, { packs: 1 }),
    sup.owner.call('POST', `businesses/${sup.b.id}/os/relationships/${m.rel.id}/end`, {}),
  ]);
  assert.ok(end.status < 300 || end.status === 404, JSON.stringify(end.body));
  const n = await prisma.purchaseOrder.count({ where: { buyerBusinessId: m.b.id } });
  assert.ok((s.status === 201 && n === 1) || (s.status === 404 && n === 0), `${s.status} ${n}`);
});

test('10 concurrent submits with ONE idempotency key (double tap / timeout retry / app restart) → one PO, one reservation', async () => {
  const sup = await supplier(api);
  const m = await merchant(api, sup);
  await grantTerms(sup, m, { limit: 10_000 });
  const k = key();
  const res = await Promise.all(Array.from({ length: 10 }, () => submit(m, sup, { term: 'net30', packs: 3, k })));
  assert.ok(res.every((r) => r.status < 300 || r.body.code === 'idempotency_in_progress'), JSON.stringify(res.map((r) => [r.status, r.body.code])));
  assert.equal(await prisma.purchaseOrder.count({ where: { buyerBusinessId: m.b.id } }), 1);
  const po = await prisma.purchaseOrder.findFirst({ where: { buyerBusinessId: m.b.id } });
  assert.equal(po.creditReservedKori, 3000);
  // Response lost, retried later from a "restarted app" with the same key: same PO.
  const later = await submit(m, sup, { term: 'net30', packs: 3, k });
  assert.equal(later.body.id, po.id);
});

test('accept racing a buyer cancel; concurrent dispatch; pay after cancel; cancel of an unpaid order moves no money', async () => {
  const sup = await supplier(api, { unitsPerPack: 10, stock: 500 });
  const m = await merchant(api, sup);
  const po = (await submit(m, sup, { packs: 2 })).body;
  const [a, c] = await Promise.all([S(sup, po.id, 'accept'), B(m, po.id, 'cancel', { reason: 'changé d’avis' })]);
  const st = (await prisma.purchaseOrder.findUnique({ where: { id: po.id } })).status;
  assert.ok((a.status === 200 && ['accepted', 'cancelled'].includes(st)) || (c.status === 200 && st === 'cancelled'), `${a.status} ${c.status} ${st}`);
  const d = await depotRow(sup);
  assert.equal(d.reserved, st === 'accepted' ? 20 : 0, 'reservation consistent with the final state');
  const bal = await bizBal(m.b.id);
  if (st === 'accepted') {
    const cx = await B(m, po.id, 'cancel', { reason: 'pas payé, annulation' });
    assert.equal(cx.status, 200, JSON.stringify(cx.body));
    assert.equal((await depotRow(sup)).reserved, 0);
  }
  assert.equal(await bizBal(m.b.id), bal, 'unpaid cancel moves no money');
  const pay = await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.id}/pay`, { expectedAmountKori: 2000 }, await withStepUp(m.owner));
  assert.equal(pay.body.code, 'invalid_state', 'no payment on a cancelled order');

  const po2 = (await submit(m, sup, { packs: 3 })).body;
  await S(sup, po2.id, 'accept');
  await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po2.id}/pay`, { expectedAmountKori: 3000 }, await withStepUp(m.owner));
  await S(sup, po2.id, 'advance', { to: 'preparing' });
  await S(sup, po2.id, 'advance', { to: 'ready' });
  const before = await depotRow(sup);
  const [x, y] = await Promise.all([
    S(sup, po2.id, 'advance', { to: 'fulfilment_requested', fulfilmentMode: 'seller_delivery' }),
    S(sup, po2.id, 'advance', { to: 'fulfilment_requested', fulfilmentMode: 'seller_delivery' }),
  ]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  const after = await depotRow(sup);
  assert.equal(before.onHand - after.onHand, 30, 'stock decremented exactly once');
});

test('credit memo issued twice concurrently with one reference → once; two references racing the outstanding → never above it', async () => {
  const sup = await supplier(api);
  const m = await merchant(api, sup);
  await grantTerms(sup, m, { limit: 50_000 });
  const po = (await submit(m, sup, { term: 'net30', packs: 4 })).body;
  await S(sup, po.id, 'accept');
  for (const to of ['preparing', 'ready']) await S(sup, po.id, 'advance', { to });
  await S(sup, po.id, 'advance', { to: 'fulfilment_requested', fulfilmentMode: 'buyer_pickup' });
  const inv = (await S(sup, po.id, 'advance', { to: 'delivered' })).body.invoiceId;
  const memo = (ref, amountKori) => sup.owner.call('POST', `businesses/${sup.b.id}/b2b/invoices/${inv}/credit-memos`, { amountKori, reason: 'correction prix', reference: ref });
  const same = await Promise.all([memo('SAME-1', 500), memo('SAME-1', 500), memo('SAME-1', 500)]);
  assert.deepEqual(same.map((x) => x.body.replayed).sort(), [false, true, true]);
  assert.equal(await prisma.creditMemo.count({ where: { invoiceId: inv } }), 1);
  const r = await Promise.all([memo('RACE-A', 3000), memo('RACE-B', 3000)]);
  assert.equal(r.filter((x) => x.status === 201).length, 1, JSON.stringify(r.map((x) => x.body.code)));
  const row = await prisma.tradeInvoice.findUnique({ where: { id: inv } });
  assert.ok(row.creditedKori + row.amountPaid <= row.amountKori);
  assert.equal(row.creditedKori, 3500);
});

test('refund to a suspended BUYER business still lands (restitution is never blocked); seller funds missing → refund fails atomically', async () => {
  const sup = await supplier(api);
  const m = await merchant(api, sup);
  const po = (await submit(m, sup, { packs: 2 })).body;
  await S(sup, po.id, 'accept');
  await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.id}/pay`, { expectedAmountKori: 2000 }, await withStepUp(m.owner));
  await prisma.business.update({ where: { id: m.b.id }, data: { status: 'suspended' } });
  const bal = await bizBal(m.b.id);
  const cx = await S(sup, po.id, 'cancel', { reason: 'rupture fournisseur' });
  assert.equal(cx.status, 200, JSON.stringify(cx.body));
  assert.equal(await bizBal(m.b.id), bal + 2000);
  await prisma.business.update({ where: { id: m.b.id }, data: { status: 'active' } });

  // Seller has spent the money: the refund cannot be invented; the PO stays as it was.
  const po2 = (await submit(m, sup, { packs: 3 })).body;
  await S(sup, po2.id, 'accept');
  await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po2.id}/pay`, { expectedAmountKori: 3000 }, await withStepUp(m.owner));
  const sb = await bizBal(sup.b.id);
  await sup.owner.call('POST', `businesses/${sup.b.id}/transfer`, { kind: 'owner_draw', amount: sb }, await withStepUp(sup.owner));
  const fail = await S(sup, po2.id, 'cancel', { reason: 'rupture fournisseur' });
  assert.ok(fail.status >= 400, JSON.stringify(fail.body));
  const v = await prisma.purchaseOrder.findUnique({ where: { id: po2.id } });
  assert.deepEqual({ status: v.status, paymentStatus: v.paymentStatus }, { status: 'confirmed', paymentStatus: 'paid' });
});
