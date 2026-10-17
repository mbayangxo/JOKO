/**
 * J14-S0 — the approved J13-4 recipient-binding policy applied to the two places that STORE a recipient for
 * later payments: payroll enrolment and scheduled-payment creation. Real HTTP (production mode), real OTP
 * sessions, J2 invariants after every test.
 *
 *   - enrolment / creation bind the immutable ACCOUNT confirmed on screen (recipientRef); every later payment
 *     goes to that stored account id — a renamed and reclaimed handle never redirects it
 *   - a reclaimed handle between lookup and save → 409, nothing stored; forged / foreign refs refused
 *   - older clients: allowed only while the handle is stable; after a real rename + reclaim → 426
 *   - the old "OR(handle, userId)" enrolment lookup is gone: a client-chosen userId is ignored
 *   - authorization unchanged (non-admin cannot enrol); exactly-once money
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fundBusiness, fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { runDueScheduledPayments } from '../../lib/scheduled-payment-service.js';
import { legacyNationalToKori } from '../../lib/kori-primary.js';
import { business, customer, signedIn } from '../j3/helpers.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const hex = () => crypto.randomBytes(3).toString('hex');
const key = () => `intent-${crypto.randomBytes(8).toString('hex')}`;
const bal = async (id) => {
  const w = await prisma.wallet.findUnique({ where: { userId: id } });
  return w.balance + w.koriBalance;
};
const lookup = (S, h) => S.call('GET', `users/lookup?q=${encodeURIComponent(h)}&mode=handle`);
const enrol = (S, bizId, body) => S.call('POST', `businesses/${bizId}/payroll/employees`, body);
/** B renames (logged as a release, like the real endpoint) and C takes B's old handle. */
async function renameAndReclaim(b, c, handle) {
  await prisma.user.update({ where: { id: b.id }, data: { handle: `old_${hex()}` } });
  await prisma.handleRelease.create({ data: { handle, userId: b.id } });
  await prisma.user.update({ where: { id: c.id }, data: { handle } });
}

async function owner() {
  const o = await customer();
  const O = await signedIn(api, o);
  const biz = await business(o);
  await prisma.businessWallet.create({ data: { businessId: biz.id } });
  await fundBusiness(biz.id, 200_000);
  return { O, biz };
}

// ── Payroll ─────────────────────────────────────────────────────────────────────────────────────────────

test('payroll: enrol the CONFIRMED account; a later rename + reclaim never redirects pay (paid by employee id)', async () => {
  const { O, biz } = await owner();
  const b = await customer();
  const c = await customer();
  const h = `emp${hex()}`;
  await prisma.user.update({ where: { id: b.id }, data: { handle: h } });
  const look = await lookup(O, h);
  const r = await enrol(O, biz.id, { userHandle: h, recipientRef: look.body.recipientRef, payAmount: 1000 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const emp = await prisma.payrollEmployee.findFirst({ where: { businessId: biz.id } });
  assert.equal(emp.userId, b.id);
  await renameAndReclaim(b, c, h);
  const [b0, c0] = [await bal(b.id), await bal(c.id)];
  const pay = await O.call('POST', `businesses/${biz.id}/payroll/pay`, { employeeId: emp.id, amount: 1000 }, { headers: { 'idempotency-key': key() } });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  // Payroll amounts are national currency (XOF), credited in ₭ through the same conversion the ledger uses.
  assert.equal(await bal(b.id), b0 + legacyNationalToKori(1000), 'the enrolled account is paid');
  assert.equal(await bal(c.id), c0, 'the new holder of the handle is never paid');
});

test('payroll: handle reclaimed between lookup and enrolment → 409, nobody enrolled', async () => {
  const { O, biz } = await owner();
  const b = await customer();
  const c = await customer();
  const h = `emp${hex()}`;
  await prisma.user.update({ where: { id: b.id }, data: { handle: h } });
  const look = await lookup(O, h);
  await renameAndReclaim(b, c, h);
  const r = await enrol(O, biz.id, { userHandle: h, recipientRef: look.body.recipientRef });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'recipient_changed');
  assert.equal(await prisma.payrollEmployee.count({ where: { businessId: biz.id } }), 0);
});

test('payroll: forged and foreign (another actor\'s) refs are refused', async () => {
  const { O, biz } = await owner();
  const { O: M } = await owner();
  const b = await customer();
  const foreign = (await lookup(M, b.handle)).body.recipientRef; // issued to another actor
  for (const recipientRef of [foreign, 'rr2.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB', 'x']) {
    const r = await enrol(O, biz.id, { userHandle: b.handle, recipientRef });
    assert.equal(r.status, 409, `${recipientRef.slice(0, 8)}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  assert.equal(await prisma.payrollEmployee.count({ where: { businessId: biz.id } }), 0);
});

test('payroll: a client-chosen userId is no longer an identity (the old OR lookup could enrol either account)', async () => {
  const { O, biz } = await owner();
  const b = await customer();
  const victim = await customer();
  const look = await lookup(O, b.handle);
  const r = await enrol(O, biz.id, { userHandle: b.handle, userId: victim.id, recipientRef: look.body.recipientRef });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const rows = await prisma.payrollEmployee.findMany({ where: { businessId: biz.id } });
  assert.deepEqual(rows.map((x) => x.userId), [b.id]);
});

test('payroll legacy clients: stable handle → enrolled (compat window); after a real rename + reclaim → 426', async () => {
  const { O, biz } = await owner();
  const b = await customer();
  assert.equal((await enrol(O, biz.id, { userHandle: b.handle })).status, 201);
  const d = await customer();
  const e = await customer();
  const h = `emp${hex()}`;
  await prisma.user.update({ where: { id: d.id }, data: { handle: h } });
  await renameAndReclaim(d, e, h);
  const r = await enrol(O, biz.id, { userHandle: h });
  assert.equal(r.status, 426, JSON.stringify(r.body));
  assert.equal(r.body.code, 'update_required');
  assert.equal(await prisma.payrollEmployee.count({ where: { businessId: biz.id, userId: e.id } }), 0);
});

test('payroll legacy pay-by-handle: a handle that changed owner recently → 426, no money moves', async () => {
  const { O, biz } = await owner();
  const b = await customer();
  const c = await customer();
  const h = `emp${hex()}`;
  await prisma.user.update({ where: { id: b.id }, data: { handle: h } });
  await enrol(O, biz.id, { userHandle: h, recipientRef: (await lookup(O, h)).body.recipientRef });
  await renameAndReclaim(b, c, h);
  // C is also enrolled by the same business (the worst case for a handle-based lookup).
  await enrol(O, biz.id, { userHandle: h, recipientRef: (await lookup(O, h)).body.recipientRef });
  const [b0, c0] = [await bal(b.id), await bal(c.id)];
  const r = await O.call('POST', `businesses/${biz.id}/payroll/pay`, { employeeHandle: h, amount: 500 }, { headers: { 'idempotency-key': key() } });
  assert.equal(r.status, 426, JSON.stringify(r.body));
  assert.deepEqual([await bal(b.id), await bal(c.id)], [b0, c0]);
});

test('payroll authorization unchanged: a stranger or plain customer cannot enrol into someone else\'s business', async () => {
  const { biz } = await owner();
  const X = await signedIn(api, await customer());
  const b = await customer();
  const r = await enrol(X, biz.id, { userHandle: b.handle, recipientRef: (await lookup(X, b.handle)).body.recipientRef });
  assert.ok([403, 404].includes(r.status), `${r.status}`);
  assert.equal(await prisma.payrollEmployee.count({ where: { businessId: biz.id } }), 0);
});

// ── Scheduled payments ─────────────────────────────────────────────────────────────────────────────────

async function scheduler(kori = 50_000) {
  const a = await customer({ koriBalance: 0 });
  await fundUser(a.id, kori);
  return signedIn(api, a);
}
const createSchedule = (S, body) => S.call('POST', 'scheduled-payments', { kind: 'send', amountKori: 700, scheduleType: 'monthly', scheduleDay: 5, ...body });

test('scheduled: created for the CONFIRMED account; a later rename + reclaim never redirects a run', async () => {
  const A = await scheduler();
  const b = await customer();
  const c = await customer();
  const h = `sch${hex()}`;
  await prisma.user.update({ where: { id: b.id }, data: { handle: h } });
  const r = await createSchedule(A, { recipientHandle: h, recipientRef: (await lookup(A, h)).body.recipientRef });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = await prisma.scheduledPayment.findFirst({ where: { userId: A.id } });
  assert.equal(row.recipientId, b.id);
  await renameAndReclaim(b, c, h);
  await prisma.scheduledPayment.update({ where: { id: row.id }, data: { nextRunAt: new Date(Date.now() - 60_000) } });
  const [b0, c0] = [await bal(b.id), await bal(c.id)];
  await runDueScheduledPayments(prisma);
  assert.equal(await bal(b.id), b0 + 700, 'the confirmed account is paid');
  assert.equal(await bal(c.id), c0, 'the new holder of the handle is never paid');
  await runDueScheduledPayments(prisma);
  assert.equal(await bal(b.id), b0 + 700, 'one run → one payment (not due again)');
});

test('scheduled: handle reclaimed between lookup and creation → 409, nothing stored; forged refs refused', async () => {
  const A = await scheduler();
  const b = await customer();
  const c = await customer();
  const h = `sch${hex()}`;
  await prisma.user.update({ where: { id: b.id }, data: { handle: h } });
  const look = await lookup(A, h);
  await renameAndReclaim(b, c, h);
  const r = await createSchedule(A, { recipientHandle: h, recipientRef: look.body.recipientRef });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  const f = await createSchedule(A, { recipientHandle: h, recipientRef: 'rr2.x.y' });
  assert.equal(f.status, 409);
  assert.equal(await prisma.scheduledPayment.count({ where: { userId: A.id } }), 0);
});

test('scheduled legacy clients: stable handle → created; recently reassigned handle → 426; never to oneself', async () => {
  const A = await scheduler();
  const b = await customer();
  assert.equal((await createSchedule(A, { recipientHandle: b.handle })).status, 201);
  const d = await customer();
  const e = await customer();
  const h = `sch${hex()}`;
  await prisma.user.update({ where: { id: d.id }, data: { handle: h } });
  await renameAndReclaim(d, e, h);
  const r = await createSchedule(A, { recipientHandle: h });
  assert.equal(r.status, 426, JSON.stringify(r.body));
  const self = await createSchedule(A, { recipientHandle: A.handle, recipientRef: (await lookup(A, A.handle)).body?.recipientRef });
  assert.ok(self.status >= 400 && self.status < 500, `self: ${self.status}`);
  assert.equal(await prisma.scheduledPayment.count({ where: { userId: A.id } }), 1);
});
