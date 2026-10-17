/**
 * J7.8–J7.10 — supplier-granted terms, available credit under concurrency,
 * invoices / receivables, payments and credit memos. Jokko never lends.
 * J2 invariants after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { creditSummary } from '../../lib/b2b/credit.js';
import { bizBal, grantTerms, idemH, key, member, merchant, submit, supplier, withStepUp } from './fixture.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const credit = (sup, m) => creditSummary(prisma, { supplierBusinessId: sup.b.id, buyerUserId: m.ownerC.id });
async function deliver(sup, poId) {
  await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${poId}/accept`, {});
  for (const to of ['preparing', 'ready']) await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${poId}/advance`, { to });
  await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${poId}/advance`, { to: 'fulfilment_requested', fulfilmentMode: 'buyer_pickup' });
  return sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${poId}/advance`, { to: 'delivered' });
}

test('terms exist only where the supplier granted them: no account → refused; self-granted Net 90 → refused; purchasing-only staff cannot commit credit', async () => {
  const sup = await supplier(api);
  const m = await merchant(api, sup);
  assert.equal((await submit(m, sup, { term: 'net30' })).body.code, 'no_credit');
  await grantTerms(sup, m, { term: 'net30', limit: 10_000 });
  assert.equal((await submit(m, sup, { term: 'net90' })).body.code, 'term_not_granted');
  const clerk = await member(api, m.b, 'inventory');
  const r = await submit(m, sup, { term: 'net30', as: clerk });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  const ok = await submit(m, sup, { term: 'net30', packs: 4 });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.creditReservedKori, 4000);
  assert.equal((await credit(sup, m)).availableKori, 6000);
  // The account is the supplier's: another supplier's grant does not apply.
  const sup2 = await supplier(api);
  await prisma.merchantRelationship.create({ data: { distributorBusinessId: sup2.b.id, merchantBusinessId: m.b.id, introducedByUserId: sup2.ownerC.id, status: 'active' } });
  assert.equal((await submit(m, sup2, { term: 'net30' })).body.code, 'no_credit');
});

test('concurrency: 8 Net-30 orders of 3,000 on a 10,000 limit → exactly 3; invoice + payment + memo keep exposure exact', async () => {
  const sup = await supplier(api);
  const m = await merchant(api, sup);
  await grantTerms(sup, m, { limit: 10_000 });
  const res = await Promise.all(Array.from({ length: 8 }, () => submit(m, sup, { term: 'net30', packs: 3 })));
  const ok = res.filter((r) => r.status === 201);
  assert.equal(ok.length, 3, JSON.stringify(res.map((r) => r.body.code ?? r.body.status)));
  assert.ok(res.filter((r) => r.status !== 201).every((r) => r.body.code === 'credit_limit_exceeded'));
  let c = await credit(sup, m);
  assert.deepEqual({ reserved: c.reservedKori, available: c.availableKori }, { reserved: 9000, available: 1000 });

  // Delivery converts the reservation into an invoice: exposure unchanged, never double-counted.
  const del = await deliver(sup, ok[0].body.id);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(del.body.paymentStatus, 'invoiced');
  c = await credit(sup, m);
  assert.deepEqual({ reserved: c.reservedKori, outstanding: c.outstandingKori, available: c.availableKori }, { reserved: 6000, outstanding: 3000, available: 1000 });
  const invId = del.body.invoiceId;

  // Partial payments from the business wallet (business.pay + step-up); overpayment refused; replay is free.
  const k1 = key();
  const p1 = await m.owner.call('POST', `businesses/${m.b.id}/b2b/invoices/${invId}/pay`, { amountKori: 1000 }, await withStepUp(m.owner, k1));
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.equal(p1.body.invoice.outstandingKori, 2000);
  const bal = await bizBal(m.b.id);
  const replay = await m.owner.call('POST', `businesses/${m.b.id}/b2b/invoices/${invId}/pay`, { amountKori: 1000 }, await withStepUp(m.owner, k1));
  assert.equal(replay.status, 200);
  assert.equal(await bizBal(m.b.id), bal, 'retry with the same key moves nothing');
  const over = await m.owner.call('POST', `businesses/${m.b.id}/b2b/invoices/${invId}/pay`, { amountKori: 2001 }, await withStepUp(m.owner));
  assert.equal(over.body.code, 'overpayment');

  // Credit memo (correction): once per reference, never above outstanding, principal untouched.
  const memo = { amountKori: 500, reason: 'emballage abîmé', reference: 'CORR-1' };
  const m1 = await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/invoices/${invId}/credit-memos`, memo);
  const m2 = await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/invoices/${invId}/credit-memos`, memo);
  assert.equal(m1.status, 201, JSON.stringify(m1.body));
  assert.equal(m2.body.replayed, true);
  assert.equal(await prisma.creditMemo.count({ where: { invoiceId: invId } }), 1);
  const big = await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/invoices/${invId}/credit-memos`, { ...memo, amountKori: 5000, reference: 'CORR-2' });
  assert.equal(big.body.code, 'credit_exceeds_outstanding');
  const buyerMemo = await m.owner.call('POST', `businesses/${m.b.id}/b2b/invoices/${invId}/credit-memos`, { ...memo, reference: 'CORR-3' });
  assert.equal(buyerMemo.status, 404, 'buyer cannot credit its own invoice');

  // Concurrent final payments: only one fits the 1,500 outstanding.
  const [a, b] = await Promise.all([
    m.owner.call('POST', `businesses/${m.b.id}/b2b/invoices/${invId}/pay`, { amountKori: 1500 }, await withStepUp(m.owner)),
    m.owner.call('POST', `businesses/${m.b.id}/b2b/invoices/${invId}/pay`, { amountKori: 1500 }, await withStepUp(m.owner)),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.body, b.body]));
  const inv = await prisma.tradeInvoice.findUnique({ where: { id: invId } });
  assert.deepEqual({ principal: inv.amountKori, paid: inv.amountPaid, credited: inv.creditedKori, status: inv.status }, { principal: 3000, paid: 2500, credited: 500, status: 'paid' });
  const rows = await prisma.tradeInvoicePayment.aggregate({ where: { invoiceId: invId }, _sum: { amountKori: true } });
  assert.equal(rows._sum.amountKori, inv.amountPaid, 'payment rows reconcile with amountPaid');
  const po = await prisma.purchaseOrder.findUnique({ where: { id: ok[0].body.id } });
  assert.equal(po.paymentStatus, 'paid');
  c = await credit(sup, m);
  assert.equal(c.availableKori, 4000, 'paid invoice frees headroom');
});

test('revocation races submit; revoked terms block acceptance of reserved orders; cancel restores credit once', async () => {
  const sup = await supplier(api);
  const m = await merchant(api, sup);
  const acct = await grantTerms(sup, m, { limit: 10_000 });
  const [s1, rev] = await Promise.all([
    submit(m, sup, { term: 'net30', packs: 4 }),
    prisma.tradeAccount.update({ where: { id: acct.id }, data: { active: false, revokedAt: new Date(), revokedBy: sup.ownerC.id } }),
  ]);
  assert.ok(rev);
  if (s1.status === 201) {
    const acc = await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${s1.body.id}/accept`, {});
    assert.equal(acc.body.code, 'term_revoked', 'a reservation made before revocation is not accepted on revoked terms');
    const [c1, c2] = await Promise.all([
      m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${s1.body.id}/cancel`, { reason: 'terms revoked' }, idemH()),
      m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${s1.body.id}/cancel`, { reason: 'terms revoked' }, idemH()),
    ]);
    assert.deepEqual([c1.status, c2.status].sort(), [200, 409]);
    const po = await prisma.purchaseOrder.findUnique({ where: { id: s1.body.id } });
    assert.equal(po.creditReservedKori, 0);
  } else {
    assert.equal(s1.body.code, 'no_credit');
  }
  assert.equal((await submit(m, sup, { term: 'net30' })).body.code, 'no_credit');
  const c = await credit(sup, m);
  assert.equal(c.reservedKori, 0);
  assert.equal(c.revoked, true);
});

test('credit reduction racing an order: never ends above the new limit', async () => {
  const sup = await supplier(api);
  const m = await merchant(api, sup);
  const acct = await grantTerms(sup, m, { limit: 10_000 });
  await submit(m, sup, { term: 'net30', packs: 5 });
  const [o, red] = await Promise.all([
    submit(m, sup, { term: 'net30', packs: 4 }),
    prisma.$transaction(async (tx) => {
      // The supplier-side reduction takes the same lock as orders.
      const { lockTradeExposure } = await import('../../lib/b2b/credit.js');
      await lockTradeExposure(tx, { supplierBusinessId: sup.b.id, buyerUserId: m.ownerC.id });
      return tx.tradeAccount.update({ where: { id: acct.id }, data: { creditLimitKori: 6000 } });
    }),
  ]);
  assert.ok(red);
  const c = await credit(sup, m);
  // Either the order committed before the reduction (9,000 exposure, available 0) or it was refused (5,000).
  assert.ok((o.status === 201 && c.reservedKori === 9000) || (o.status !== 201 && c.reservedKori === 5000), `${o.status} ${c.reservedKori}`);
  const more = await submit(m, sup, { term: 'net30', packs: 2 }); // 7,000 or 11,000 > 6,000
  assert.equal(more.body.code, 'credit_limit_exceeded');
});

test('rejection and buyer cancellation release the reservation; reject is seller-only', async () => {
  const sup = await supplier(api);
  const m = await merchant(api, sup);
  await grantTerms(sup, m, { limit: 5000 });
  const a = (await submit(m, sup, { term: 'net30', packs: 5 })).body;
  assert.equal((await credit(sup, m)).availableKori, 0);
  const buyerReject = await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${a.id}/reject`, { reason: 'pas moi' });
  assert.equal(buyerReject.status, 404);
  const rj = await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${a.id}/reject`, { reason: 'hors zone' });
  assert.equal(rj.body.status, 'rejected');
  assert.equal((await credit(sup, m)).availableKori, 5000);
  const b = (await submit(m, sup, { term: 'net30', packs: 5 })).body;
  const cx = await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${b.id}/cancel`, { reason: 'erreur' }, idemH());
  assert.equal(cx.body.status, 'cancelled');
  assert.equal((await credit(sup, m)).availableKori, 5000);
});
