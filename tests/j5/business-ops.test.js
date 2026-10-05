/**
 * J5 — business operations over real HTTP: money view by capability (no
 * salary leakage), analytics reconciled to the ledger, customer privacy,
 * merchant charges (QR) from the business side, payroll boundary, operator
 * support tooling. J2 invariants after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { fundBusiness, fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { business, customer, operator, signedIn, stepUp } from '../j3/helpers.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const key = () => `intent-${crypto.randomBytes(8).toString('hex')}`;
const PII = /@leak\.invalid|dateOfBirth|cniHash|cniNumber|"phone"|"email"|koriBalance|pinHash/;

async function shop(roles = ['manager', 'cashier', 'finance', 'fulfillment']) {
  const owner = await customer();
  const people = {};
  for (const r of roles) people[r] = await customer();
  const b = await business(owner.user, roles.map((r) => ({ user: people[r].user, role: r })));
  const s = { owner: await signedIn(api, owner) };
  for (const r of roles) s[r] = await signedIn(api, people[r]);
  return { b, s, people, P: `businesses/${b.id}/os` };
}
async function buyer(kori = 3000) {
  const c = await customer({ koriBalance: 0 });
  await fundUser(c.id, kori);
  return signedIn(api, c);
}

test('merchant charge (QR) from the business side: cashier creates with a reference, sees pending → paid; amount is server-owned; replay refused', async () => {
  const { b, s, P } = await shop();
  const o = await s.cashier.call('POST', 'money/charges', { businessId: b.id, amountKori: 350, label: 'Table 4', externalRef: 'TICKET-88' });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  assert.match(o.body.qrUrl, /^k21:\/\/charge\//);
  const list1 = await s.cashier.call('GET', `${P}/charges?status=open`);
  assert.ok(list1.body.some((c) => c.code === o.body.code && c.status === 'open' && c.externalRef === 'TICKET-88'));
  const u = await buyer();
  assert.equal((await u.call('POST', `money/charges/${o.body.code}/pay`, { expectedAmountKori: 300 })).status, 409, 'changed amount refused');
  const paid = await u.call('POST', `money/charges/${o.body.code}/pay`, { expectedAmountKori: 350 }, { headers: { 'idempotency-key': key() } });
  assert.equal(paid.status, 201);
  const list2 = await s.cashier.call('GET', `${P}/charges`);
  const row = list2.body.find((c) => c.code === o.body.code);
  assert.equal(row.status, 'paid');
  assert.ok(!JSON.stringify(row).match(/paidBy|payer|"handle"/), 'payer identity not shown in the charge list');
  const u2 = await buyer();
  assert.equal((await u2.call('POST', `money/charges/${o.body.code}/pay`, { expectedAmountKori: 350 })).status, 409, 'a screenshot/replay by someone else is refused');
  assert.equal((await s.cashier.call('POST', `money/charges`, { businessId: b.id, amountKori: 100, orderId: 'not-an-order-of-this-business' })).status, 404);
  // Cross-business: another merchant's cashier cannot list or cancel these charges.
  const other = await shop(['cashier']);
  assert.equal((await other.s.cashier.call('GET', `${P}/charges`)).status, 403);
  const open = await s.cashier.call('POST', 'money/charges', { businessId: b.id, amountKori: 10 });
  assert.equal((await other.s.cashier.call('POST', `money/charges/${open.body.code}/cancel`, {})).status, 403);
});

test('business money by capability: finance sees balance + payroll; manager sees sales/refunds but salaries are hidden; amounts reconcile', async () => {
  const { b, s, people, P } = await shop();
  await prisma.businessWallet.create({ data: { businessId: b.id } });
  await fundBusiness(b.id, 10_000);
  // A sale (charge) and a payroll payment.
  const ch = await s.cashier.call('POST', 'money/charges', { businessId: b.id, amountKori: 400 });
  const u = await buyer();
  await u.call('POST', `money/charges/${ch.body.code}/pay`, { expectedAmountKori: 400 }, { headers: { 'idempotency-key': key() } });
  const emp = await customer();
  assert.equal((await s.finance.call('POST', `businesses/${b.id}/payroll/employees`, { userHandle: emp.handle, payAmount: 1000, jobTitle: 'Caissière' })).status, 201);
  await stepUp(s.finance);
  const employees = await prisma.payrollEmployee.findFirst({ where: { businessId: b.id } });
  const pay = await s.finance.call('POST', `businesses/${b.id}/payroll/pay`, { employeeId: employees.id, amount: 1000 }, { headers: { 'idempotency-key': key() } });
  assert.ok([200, 201].includes(pay.status), JSON.stringify(pay.body));
  const run = await prisma.payrollRun.findFirst({ where: { businessId: b.id } });
  assert.ok(run, 'payroll run recorded with the payment');
  assert.ok(await prisma.journalEntry.findFirst({ where: { reference: { startsWith: run.reference } } }), 'and the ledger entry exists');

  const fin = await s.finance.call('GET', `${P}/money`);
  const ledger = Number((await prisma.ledgerAccount.findUnique({ where: { code: `business:${b.id}:wallet` } })).balance);
  assert.equal(fin.body.balance.availableKori, ledger);
  assert.ok(fin.body.items.some((i) => i.category === 'payroll' && i.amountKori > 0));
  const mgr = await s.manager.call('GET', `${P}/money`);
  assert.equal(mgr.body.balance, null);
  assert.ok(mgr.body.items.some((i) => i.category === 'sale' && i.amountKori === 400));
  const hidden = mgr.body.items.filter((i) => i.category === 'restricted');
  assert.ok(hidden.length >= 1, 'payroll / capital are listed as restricted');
  assert.ok(hidden.every((i) => i.amountKori === null && i.reference === null), 'no salary amount or reference leaks');
  // Salary detail endpoints refuse non-payroll roles.
  for (const who of ['manager', 'cashier', 'fulfillment']) assert.equal((await s[who].call('GET', `businesses/${b.id}/payroll/employees`)).status, 403, who);
  assert.ok(!JSON.stringify(mgr.body).includes(emp.handle));
});

test('analytics derive from real events and reconcile with the ledger; customers expose name/handle only', async () => {
  const { b, s, P } = await shop();
  const prod = await s.owner.call('POST', `${P}/catalog`, { title: 'Ndambé', priceKori: 100, initialStock: 50 });
  const users = [await buyer(), await buyer()];
  const orders = [];
  for (const u of users) {
    for (let i = 0; i < 2; i++) {
      const r = await u.call('POST', 'marketplace/orders', { businessId: b.id, items: [{ productId: prod.body.id, quantity: i + 1 }], fulfillmentType: 'pickup' }, { headers: { 'idempotency-key': key() } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      orders.push(r.body.orderId);
    }
  }
  // One cancellation (refunded) and one QR sale.
  await users[0].call('POST', `marketplace/orders/${orders[0]}/cancel`, { reason: 'changement' });
  const ch = await s.cashier.call('POST', 'money/charges', { businessId: b.id, amountKori: 250 });
  await users[1].call('POST', `money/charges/${ch.body.code}/pay`, { expectedAmountKori: 250 }, { headers: { 'idempotency-key': key() } });

  const a = await s.manager.call('GET', `${P}/analytics?period=30d`);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  // 4 orders: 100 + 200 + 100 + 200 = 600 gross; 100 refunded; + 250 QR.
  assert.equal(a.body.sales.grossKori, 850);
  assert.equal(a.body.sales.refundsKori, 100);
  assert.equal(a.body.sales.netKori, 750);
  assert.deepEqual(a.body.sales.bySource, { ordersKori: 600, qrChargesKori: 250, directPaymentsKori: 0 });
  assert.equal(a.body.orders.count, 4);
  assert.equal(a.body.orders.paidCount, 3);
  assert.equal(a.body.orders.averageOrderKori, Math.round(500 / 3));
  assert.equal(a.body.reconciliation.ok, true);
  assert.equal(a.body.reconciliation.ledgerSalesKori, a.body.reconciliation.sourcedSalesKori);
  const ledgerNet = Number((await prisma.ledgerAccount.findUnique({ where: { code: `business:${b.id}:wallet` } })).balance);
  assert.equal(ledgerNet, a.body.sales.netKori, 'analytics net == business wallet (no other movements)');
  assert.equal(a.body.topProducts[0].units, 5, '2+1+2 units on paid, non-cancelled orders');
  assert.ok(a.body.inventoryMovement.some((m) => m.reason === 'cancel_restore' && m.netUnits === 1));

  const c = await s.manager.call('GET', `${P}/customers`);
  assert.equal(c.status, 200);
  assert.equal(c.body.length, 2);
  assert.ok(!PII.test(JSON.stringify(c.body)), JSON.stringify(c.body));
  assert.deepEqual(Object.keys(c.body[0]).sort(), ['handle', 'lastAt', 'name', 'orders', 'payments', 'totalKori'].sort());
  // Merchant order view: no buyer id/phone; address only for fulfilment roles.
  const list = await s.fulfillment.call('GET', `${P}/orders`);
  assert.ok(!PII.test(JSON.stringify(list.body)) && !JSON.stringify(list.body).includes('buyerId'));
  const today = await s.cashier.call('GET', `${P}/today`);
  assert.equal(today.status, 200);
  assert.equal(today.body.salesToday, null, 'a cashier does not see sales totals');
  assert.equal(typeof today.body.openCharges, 'number');
});

test('support tooling: operators locate a business by order/charge reference and see states + authority history; read-only; users refused', async () => {
  const { b, s, P } = await shop(['cashier']);
  const prod = await s.owner.call('POST', `${P}/catalog`, { title: 'Café Touba', priceKori: 30, initialStock: 10 });
  const u = await buyer();
  const o = await u.call('POST', 'marketplace/orders', { businessId: b.id, items: [{ productId: prod.body.id, quantity: 1 }], fulfillmentType: 'pickup' }, { headers: { 'idempotency-key': key() } });
  await u.call('POST', `marketplace/orders/${o.body.orderId}/cancel`, { reason: 'erreur' });
  const ref = (await prisma.order.findUnique({ where: { id: o.body.orderId } })).orderReference;
  const support = await operator(api, ['support']);
  const r = await support.call('GET', `admin/businesses/lookup?q=${encodeURIComponent(ref)}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.business.id, b.id);
  assert.equal(r.body.orders.cancelled, 1);
  assert.equal(r.body.refunds[0].refundReference, `order-refund:${o.body.orderId}`);
  assert.equal(r.body.canSupportChangeAnything, false);
  assert.equal(r.body.settlementIntegrity.ok, true);
  assert.ok(r.body.staff.some((m) => m.role === 'cashier'));
  assert.ok(!PII.test(JSON.stringify(r.body)), 'no customer or owner PII');
  const sysadmin = await operator(api, ['sysadmin']);
  assert.equal((await sysadmin.call('GET', `admin/businesses/lookup?q=${b.id}`)).status, 403);
  assert.ok([401, 403].includes((await s.owner.call('GET', `admin/businesses/lookup?q=${b.id}`)).status));
});

test('a removed employee acting at the same moment as their removal: either the action commits before removal or it is refused — never after', async () => {
  const { b, s, people, P } = await shop(['manager', 'finance']);
  const prod = await s.owner.call('POST', `${P}/catalog`, { title: 'Thé', priceKori: 20, initialStock: 100 });
  const u = await buyer();
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const r = await (await buyer()).call('POST', 'marketplace/orders', { businessId: b.id, items: [{ productId: prod.body.id, quantity: 1 }], fulfillmentType: 'pickup' }, { headers: { 'idempotency-key': key() } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ids.push(r.body.orderId);
  }
  const row = await prisma.businessMember.findFirst({ where: { businessId: b.id, userId: people.manager.id, status: 'active' } });
  const results = await Promise.all([
    ...ids.map((id) => s.manager.call('POST', `${P}/orders/${id}/cancel`, { reason: 'test concurrence' })),
    s.owner.call('POST', `businesses/${b.id}/members/${row.id}/remove`, { reason: 'départ' }),
  ]);
  // Ordering is enforced by the in-transaction authority check (FOR SHARE on
  // the active membership vs the removal's UPDATE); app-side timestamps do
  // not reflect commit order, so assert the observable consequences instead.
  assert.equal((await prisma.businessMember.findUnique({ where: { id: row.id } })).status, 'removed');
  const cancelled = await prisma.order.findMany({ where: { id: { in: ids }, status: 'cancelled' }, select: { id: true, refundReference: true, cancelledBy: true } });
  for (const o of cancelled) {
    assert.equal(o.cancelledBy, people.manager.id);
    assert.equal(await prisma.journalEntry.count({ where: { reference: `order-refund:${o.id}` } }), 1, 'each cancellation refunded exactly once');
  }
  const untouched = await prisma.order.findMany({ where: { id: { in: ids }, status: { not: 'cancelled' } }, select: { id: true } });
  for (const o of untouched) assert.equal(await prisma.journalEntry.count({ where: { reference: `order-refund:${o.id}` } }), 0, 'refused cancellations moved no money');
  assert.ok(results.slice(0, 4).every((r) => [200, 404, 403].includes(r.status)), JSON.stringify(results.map((r) => r.status)));
  const late = await (await buyer()).call('POST', 'marketplace/orders', { businessId: b.id, items: [{ productId: prod.body.id, quantity: 1 }], fulfillmentType: 'pickup' }, { headers: { 'idempotency-key': key() } });
  assert.equal((await s.manager.call('POST', `${P}/orders/${late.body.orderId}/cancel`, { reason: 'après départ' })).status, 404, 'removed: no authority');
});
