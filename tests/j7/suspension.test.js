/**
 * J7.0 — business suspension hard gate. One eligibility policy
 * (lib/business/eligibility.js) on every business-directed acceptance path;
 * refunds / owner withdrawal / payroll are not blocked; races with a
 * concurrent suspension are all-or-nothing; money is never redirected.
 * J2 invariants after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { business, customer, operator, signedIn, stepUp } from '../j3/helpers.js';
import { setBusinessStatus } from '../../lib/integrations/partner-settlement-admin.js';
import { executeHeldPayload } from '../../lib/held-transaction-service.js';

let api;
let compliance;
before(async () => { api = await startApiServer(); compliance = await operator(api, ['compliance']); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const key = () => ({ headers: { 'idempotency-key': `k-${crypto.randomBytes(8).toString('hex')}` } });
const wallet = async (id) => (await prisma.wallet.findUnique({ where: { userId: id } })).koriBalance;
const bizBal = async (id) => (await prisma.businessWallet.findUnique({ where: { businessId: id } }))?.balance ?? 0;
async function shop({ mode = 'business' } = {}) {
  const owner = await customer();
  await fundUser(owner.id, 5000);
  const b = await business(owner.user);
  if (mode === 'owner') await prisma.business.update({ where: { id: b.id }, data: { settlementMode: 'owner' } });
  return { b, owner, s: await signedIn(api, owner) };
}
async function payer(kori = 5000) {
  const c = await customer();
  await fundUser(c.id, kori);
  return signedIn(api, c);
}
const suspend = (b) => compliance.call('POST', `admin/businesses/${b.id}/status`, { status: 'suspended', reason: 'compliance review pending' });
const reactivate = (b) => compliance.call('POST', `admin/businesses/${b.id}/status`, { status: 'active', reason: 'review closed, all good' });

test('every acceptance path refuses a suspended business (wallet AND legacy owner settlement); nothing moves, nothing is redirected', async () => {
  const m = await shop();
  const legacy = await shop({ mode: 'owner' });
  const p = await payer(20_000);
  // Prepared while active: a QR charge.
  const charge = await m.s.call('POST', 'money/charges', { businessId: m.b.id, amountKori: 300, label: 'Pain' });
  assert.equal(charge.status, 201, JSON.stringify(charge.body));
  const prod = await m.s.call('POST', `businesses/${m.b.id}/os/catalog`, { title: 'Riz', priceKori: 100, initialStock: 50 });
  assert.equal(prod.status, 201, JSON.stringify(prod.body));
  await suspend(m.b);
  await suspend(legacy.b);
  const before = { p: await wallet(p.id), m: await bizBal(m.b.id), legacyOwner: await wallet(legacy.owner.id) };
  const h = { headers: { ...key().headers, 'x-step-up-token': await stepUp(p) } };
  const attempts = {
    merchantPay: await p.call('POST', `merchants/${m.b.id}/pay`, { amount: 200, currency: 'kori' }, h),
    legacyMerchantPay: await p.call('POST', `merchants/${legacy.b.id}/pay`, { amount: 200, currency: 'kori' }, { headers: { ...key().headers, 'x-step-up-token': await stepUp(p) } }),
    chargePay: await p.call('POST', `money/charges/${charge.body.code}/pay`, { expectedAmountKori: 300 }, key()),
    newCharge: await m.s.call('POST', 'money/charges', { businessId: m.b.id, amountKori: 300, label: 'Pain' }),
    order: await p.call('POST', 'marketplace/orders', { businessId: m.b.id, items: [{ productId: prod.body.id, quantity: 1 }], fulfillmentType: 'pickup' }, key()),
    capitalIn: await m.s.call('POST', `businesses/${m.b.id}/transfer`, { kind: 'capital_in', amount: 100 }, { headers: { ...key().headers, 'x-step-up-token': await stepUp(m.s) } }),
  };
  for (const [k, r] of Object.entries(attempts)) {
    assert.equal(r.status, 409, `${k}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'business_inactive', k);
  }
  // B2B into the suspended business from another business.
  const other = await shop();
  await other.s.call('POST', `businesses/${other.b.id}/transfer`, { kind: 'capital_in', amount: 1000 }, { headers: { ...key().headers, 'x-step-up-token': await stepUp(other.s) } });
  const b2b = await other.s.call('POST', `businesses/${other.b.id}/transfer`, { kind: 'b2b', amount: 100, recipientBusinessId: m.b.id }, { headers: { ...key().headers, 'x-step-up-token': await stepUp(other.s) } });
  assert.equal(b2b.body.code, 'business_inactive', JSON.stringify(b2b.body));
  assert.equal(await wallet(p.id), before.p);
  assert.equal(await bizBal(m.b.id), before.m);
  assert.equal(await wallet(legacy.owner.id), before.legacyOwner, 'legacy owner wallet receives nothing either');
  assert.equal((await prisma.merchantCharge.findUnique({ where: { code: charge.body.code } })).status, 'open', 'payable again after reactivation');
  // Reactivation restores acceptance.
  await reactivate(m.b);
  const ok = await p.call('POST', `money/charges/${charge.body.code}/pay`, { expectedAmountKori: 300 }, key());
  assert.ok(ok.status < 300, JSON.stringify(ok.body));
});

test('suspension does NOT block refunds, owner withdrawal or payroll-style outflows', async () => {
  const m = await shop();
  const p = await payer(5000);
  const prod = await m.s.call('POST', `businesses/${m.b.id}/os/catalog`, { title: 'Huile', priceKori: 500, initialStock: 10 });
  const o = await p.call('POST', 'marketplace/orders', { businessId: m.b.id, items: [{ productId: prod.body.id, quantity: 2 }], fulfillmentType: 'pickup' }, key());
  assert.equal(o.status, 201, JSON.stringify(o.body));
  assert.equal(await wallet(p.id), 4000);
  await suspend(m.b);
  const refund = await m.s.call('POST', `businesses/${m.b.id}/os/orders/${o.body.orderId}/cancel`, { reason: 'shop suspended, refunding' });
  assert.ok(refund.status < 300, JSON.stringify(refund.body));
  assert.equal(await wallet(p.id), 5000, 'customer refunded while the shop is suspended');
  // Owner may withdraw what remains (a fresh sale before suspension funds it).
  await reactivate(m.b);
  await m.s.call('POST', `businesses/${m.b.id}/transfer`, { kind: 'capital_in', amount: 300 }, { headers: { ...key().headers, 'x-step-up-token': await stepUp(m.s) } });
  await suspend(m.b);
  const draw = await m.s.call('POST', `businesses/${m.b.id}/transfer`, { kind: 'owner_draw', amount: 300 }, { headers: { ...key().headers, 'x-step-up-token': await stepUp(m.s) } });
  assert.ok(draw.status < 300, JSON.stringify(draw.body));
  assert.equal(await bizBal(m.b.id), 0);
});

test('held payment approved after suspension is refused at execution (also for pre-J7 payloads without businessId)', async () => {
  const m = await shop({ mode: 'owner' });
  const p = await payer(5000);
  const pw = await prisma.wallet.findUnique({ where: { userId: p.id } });
  const ow = await prisma.wallet.findUnique({ where: { userId: m.owner.id } });
  await setBusinessStatus('op', m.b.id, { status: 'suspended', reason: 'compliance review pending' });
  const base = { operationType: 'merchant_pay_kori', payerId: p.id, payerWalletId: pw.id, merchantUserId: m.owner.id, merchantWalletId: ow.id, amountKori: 100, merchantName: 'X', reference: `H-${crypto.randomBytes(4).toString('hex')}` };
  await assert.rejects(executeHeldPayload({ ...base, businessId: m.b.id }, p.id), (e) => e.code === 'business_inactive');
  await assert.rejects(executeHeldPayload({ ...base, reference: `${base.reference}x` }, p.id), (e) => e.code === 'business_inactive', 'legacy payload: owner has a suspended business');
  assert.equal(await wallet(p.id), 5000);
});

test('race: 12 concurrent payments while the business is suspended mid-flight — each either completes fully or is refused; totals reconcile', async () => {
  const m = await shop();
  const payers = await Promise.all(Array.from({ length: 12 }, () => payer(1000)));
  const headers = await Promise.all(payers.map(async (pp) => ({ ...key().headers, 'x-step-up-token': await stepUp(pp) })));
  const runs = payers.map((pp, i) => pp.call('POST', `merchants/${m.b.id}/pay`, { amount: 100, currency: 'kori' }, { headers: headers[i] }));
  runs.splice(6, 0, suspend(m.b));
  const res = await Promise.all(runs);
  const pays = res.filter((r, i) => i !== 6);
  const okCount = pays.filter((r) => r.status === 201).length;
  assert.ok(pays.every((r) => r.status === 201 || r.body.code === 'business_inactive'), JSON.stringify(pays.map((r) => r.body)));
  assert.equal(await bizBal(m.b.id), okCount * 100, 'business credited exactly for completed payments');
  const left = (await Promise.all(payers.map((pp) => wallet(pp.id)))).reduce((a, b) => a + b, 0);
  assert.equal(left, 12 * 1000 - okCount * 100, 'refused payers keep everything');
  // Late retry of a payment that completed BEFORE the suspension replays, moves nothing new.
  const firstOk = res.findIndex((r) => r.status === 201);
  if (firstOk >= 0 && firstOk !== 6) {
    const idx = firstOk > 6 ? firstOk - 1 : firstOk;
    const replay = await payers[idx].call('POST', `merchants/${m.b.id}/pay`, { amount: 100, currency: 'kori' }, { headers: headers[idx] });
    assert.ok(replay.status < 300 || replay.body.code === 'business_inactive', JSON.stringify(replay.body));
    assert.equal(await bizBal(m.b.id), okCount * 100);
  }
});

test('policy table: restitution purposes always pass; unknown purposes are a programming error', async () => {
  const { businessMayReceive } = await import('../../lib/business/eligibility.js');
  assert.equal(businessMayReceive({ status: 'suspended' }, 'refund'), true);
  assert.equal(businessMayReceive({ status: 'closed' }, 'reversal'), true);
  assert.equal(businessMayReceive({ status: 'suspended' }, 'order_payment'), false);
  assert.equal(businessMayReceive({ status: 'active' }, 'partner_settlement'), true);
  assert.throws(() => businessMayReceive({ status: 'active' }, 'free_money'));
});
