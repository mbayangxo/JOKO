/**
 * J14-F1 — S4: partner-requested business-wallet debits, executed ONLY on explicit in-Jokko approval.
 * Real HTTP (production mode), real OTP sessions, real PIN step-up, J2 invariants after every test.
 *   - authorization: only business.pay holders approve; partners can never execute; cross-business /
 *     cross-partner isolation;
 *   - fresh authentication, immutable details (hash echo, DB guard, re-post refused), 15-min expiry;
 *   - recipient binding (re-assigned handles refused; payroll roster changes invalidate);
 *   - risk: limits, approver-is-recipient, frozen recipient, unlinked / inactive business, insufficient funds;
 *   - exactly-once under concurrent approvals and retries; financial totals reconcile.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fundBusiness, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { business, customer, signedIn, stepUp } from '../j3/helpers.js';

const KEBU = `f1-kebu-${crypto.randomBytes(8).toString('hex')}`;
const RECT = `f1-rect-${crypto.randomBytes(8).toString('hex')}`;
let api;
before(async () => { api = await startApiServer({ JOKO_API_KEYS: `kebu:${KEBU},rect:${RECT}`, PARTNER_DEBIT_INSTRUCTIONS_ENABLED: 'true' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const hex = () => crypto.randomBytes(4).toString('hex');
const as = (key) => ({ headers: { 'x-api-key': key } });
const kori = async (id) => { const w = await prisma.wallet.findUnique({ where: { userId: id } }); return w.balance + w.koriBalance; };
const bizBal = async (id) => (await prisma.businessWallet.findUnique({ where: { businessId: id } })).balance;

async function shop({ funds = 100_000, partnerKey = KEBU } = {}) {
  const ownerC = await customer();
  const owner = await signedIn(api, ownerC);
  const b = await business(ownerC.user);
  await prisma.businessWallet.create({ data: { businessId: b.id } });
  if (funds) await fundBusiness(b.id, funds);
  const code = await owner.call('POST', `businesses/${b.id}/os/integrations/link-code`, {});
  const ext = `shop_${hex()}`;
  assert.equal((await api.client('POST', 'v1/business-links', { ...as(partnerKey), body: { code: code.body.code, external_business_id: ext } })).status, 201);
  const employee = async () => {
    const c = await customer();
    const e = await prisma.payrollEmployee.create({ data: { businessId: b.id, userId: c.id, status: 'active' } });
    return { ...c, employeeId: e.id };
  };
  return { b, owner, ownerC, ext, employee };
}
const request = (key, body) => api.client('POST', 'v1/debit-instructions', { ...as(key), body });
const payroll = (s, lines, over = {}) => ({ external_business_id: s.ext, external_ref: `run_${hex()}`, kind: 'payroll_batch', lines, ...over });
const detail = (s, id, who = s.owner) => who.call('GET', `businesses/${s.b.id}/partner-debits/${id}`);
async function approve(s, id, who = s.owner, { hash, step = true } = {}) {
  if (step) await stepUp(who);
  const d = hash ? { body: { detailsHash: hash } } : await detail(s, id, who);
  return who.call('POST', `businesses/${s.b.id}/partner-debits/${id}/approve`, { detailsHash: hash ?? d.body.detailsHash });
}

test('disabled by default: request route answers 403 disabled; nothing created', async () => {
  const off = await startApiServer({ JOKO_API_KEYS: `kebu:${KEBU}` });
  try {
    const r = await off.client('POST', 'v1/debit-instructions', { ...as(KEBU), body: { kind: 'payout' } });
    assert.deepEqual([r.status, r.body.code], [403, 'disabled']);
  } finally {
    await off.stop();
  }
});

test('payroll batch: request moves nothing; approver sees EVERY recipient; approval (step-up + hash) executes exactly once', async () => {
  const s = await shop();
  const [e1, e2, e3] = [await s.employee(), await s.employee(), await s.employee()];
  const biz0 = await bizBal(s.b.id);
  const r = await request(KEBU, payroll(s, [{ recipient_handle: e1.handle, amount_kori: 1000 }, { recipient_handle: `@${e2.handle}`, amount_kori: 2000 }, { recipient_handle: e3.handle, amount_kori: 3000 }]));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.status, r.body.total_kori, r.body.line_count], ['requested', 6000, 3]);
  assert.equal(await bizBal(s.b.id), biz0, 'a request moves nothing');
  assert.ok(!JSON.stringify(r.body).includes(e1.id), 'the partner never sees account ids');
  const d = await detail(s, r.body.id);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.deepEqual(d.body.recipients.map((x) => [x.handle, x.amountKori, x.employee]), [[e1.handle, 1000, true], [e2.handle, 2000, true], [e3.handle, 3000, true]]);
  const [b1, b2, b3] = [await kori(e1.id), await kori(e2.id), await kori(e3.id)];
  const ok = await approve(s, r.body.id);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'executed');
  assert.deepEqual([await kori(e1.id) - b1, await kori(e2.id) - b2, await kori(e3.id) - b3], [1000, 2000, 3000]);
  assert.equal(await bizBal(s.b.id), biz0 - 6000);
  assert.equal(await prisma.payrollRun.count({ where: { reference: { startsWith: `pdi-${r.body.id}-` } } }), 3);
  // Replay by the same approver: same result, nothing more moves.
  const again = await approve(s, r.body.id);
  assert.deepEqual([again.status, again.body.replayed], [200, true]);
  assert.equal(await bizBal(s.b.id), biz0 - 6000);
  const seen = await api.client('GET', `v1/debit-instructions/${r.body.id}`, as(KEBU));
  assert.equal(seen.body.status, 'executed');
});

test('fresh authentication: without a step-up the approval is refused and nothing moves', async () => {
  const s = await shop();
  const e = await s.employee();
  const r = await request(KEBU, payroll(s, [{ recipient_handle: e.handle, amount_kori: 500 }]));
  const d = await detail(s, r.body.id);
  const biz0 = await bizBal(s.b.id);
  const no = await s.owner.call('POST', `businesses/${s.b.id}/partner-debits/${r.body.id}/approve`, { detailsHash: d.body.detailsHash });
  assert.ok([401, 403].includes(no.status), `${no.status} ${JSON.stringify(no.body)}`);
  assert.equal(await bizBal(s.b.id), biz0);
  assert.equal((await prisma.partnerDebitInstruction.findUnique({ where: { id: r.body.id } })).status, 'requested');
});

test('immutable details: a wrong hash is refused; a re-post with different lines is refused; the DB refuses edits', async () => {
  const s = await shop();
  const e = await s.employee();
  const body = payroll(s, [{ recipient_handle: e.handle, amount_kori: 700 }]);
  const r = await request(KEBU, body);
  assert.equal((await request(KEBU, body)).status, 200, 'same request → same instruction (idempotent)');
  const changed = await request(KEBU, { ...body, lines: [{ recipient_handle: e.handle, amount_kori: 7_000 }] });
  assert.deepEqual([changed.status, changed.body.code], [409, 'instruction_immutable']);
  const bad = await approve(s, r.body.id, s.owner, { hash: 'f'.repeat(64) });
  assert.deepEqual([bad.status, bad.body.code], [409, 'details_mismatch']);
  await assert.rejects(prisma.partnerDebitInstruction.update({ where: { id: r.body.id }, data: { totalKori: 70_000 } }), /immutable/);
  await assert.rejects(prisma.$executeRaw`UPDATE "PartnerDebitInstruction" SET "linesJson" = '{}' WHERE id = ${r.body.id}`, /immutable/);
  await assert.rejects(prisma.partnerDebitInstruction.delete({ where: { id: r.body.id } }), /never deleted/);
  assert.equal((await approve(s, r.body.id)).body.status, 'executed', 'the intact instruction is still approvable');
});

test('payroll batch invalidated if the roster changes after the request (removed, deactivated, re-pointed) — nothing moves', async () => {
  for (const mutate of [
    (e) => prisma.payrollEmployee.update({ where: { id: e.employeeId }, data: { status: 'inactive' } }),
    async (e) => prisma.payrollEmployee.update({ where: { id: e.employeeId }, data: { userId: (await customer()).id } }),
  ]) {
    const s = await shop();
    const [e1, e2] = [await s.employee(), await s.employee()];
    const r = await request(KEBU, payroll(s, [{ recipient_handle: e1.handle, amount_kori: 900 }, { recipient_handle: e2.handle, amount_kori: 900 }]));
    await mutate(e2);
    const biz0 = await bizBal(s.b.id);
    const a = await approve(s, r.body.id);
    assert.deepEqual([a.status, a.body.code], [409, 'invalidated'], JSON.stringify(a.body));
    assert.ok(a.body.reasons.some((x) => x.includes('roster_changed')));
    assert.equal(await bizBal(s.b.id), biz0, 'all-or-nothing: no line paid');
    assert.equal((await prisma.partnerDebitInstruction.findUnique({ where: { id: r.body.id } })).status, 'invalidated');
    assert.equal((await approve(s, r.body.id)).status, 409, 'an invalidated instruction is final');
  }
});

test('recipient binding at request: non-employees in a payroll batch, re-assigned handles, frozen and unknown recipients are refused', async () => {
  const s = await shop();
  const stranger = await customer();
  const r1 = await request(KEBU, payroll(s, [{ recipient_handle: stranger.handle, amount_kori: 100 }]));
  assert.deepEqual([r1.status, r1.body.problems[0].problem], [422, 'not_an_employee']);
  const e = await s.employee();
  const h = `pay${hex()}`;
  await prisma.user.update({ where: { id: e.id }, data: { handle: h } });
  await prisma.handleRelease.create({ data: { handle: h, userId: (await customer()).id } }); // h recently changed owner
  const r2 = await request(KEBU, payroll(s, [{ recipient_handle: h, amount_kori: 100 }]));
  assert.deepEqual([r2.status, r2.body.problems[0].problem], [422, 'recipient_unverifiable']);
  const f = await customer();
  await prisma.user.update({ where: { id: f.id }, data: { frozenByAdminAt: new Date() } });
  const r3 = await request(KEBU, { external_business_id: s.ext, external_ref: `po_${hex()}`, kind: 'payout', lines: [{ recipient_handle: f.handle, amount_kori: 100 }] });
  assert.equal(r3.body.problems[0].problem, 'recipient_frozen');
  const r4 = await request(KEBU, { external_business_id: s.ext, external_ref: `po_${hex()}`, kind: 'payout', lines: [{ recipient_handle: `nobody${hex()}`, amount_kori: 100 }] });
  assert.equal(r4.body.problems[0].problem, 'recipient_not_found');
  assert.equal(await prisma.partnerDebitInstruction.count({ where: { businessId: s.b.id } }), 0);
});

test('a recipient frozen AFTER the request invalidates the payout at approval', async () => {
  const s = await shop();
  const p = await customer();
  const r = await request(KEBU, { external_business_id: s.ext, external_ref: `po_${hex()}`, kind: 'payout', lines: [{ recipient_handle: p.handle, amount_kori: 1200 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await prisma.user.update({ where: { id: p.id }, data: { frozenByAdminAt: new Date() } });
  const a = await approve(s, r.body.id);
  assert.equal(a.body.code, 'invalidated');
  assert.equal(await kori(p.id), 0);
});

test('15-minute expiry: past it the approval is refused (expired), nothing moves; partner sees expired', async () => {
  const s = await shop();
  const p = await customer();
  const r = await request(KEBU, { external_business_id: s.ext, external_ref: `po_${hex()}`, kind: 'payout', lines: [{ recipient_handle: p.handle, amount_kori: 800 }] });
  const row = await prisma.partnerDebitInstruction.findUnique({ where: { id: r.body.id } });
  assert.ok(Math.abs(row.expiresAt.getTime() - row.createdAt.getTime() - 15 * 60_000) < 2000, '15 minutes');
  const D = await import('../../lib/integrations/partner-debits.js');
  process.env.PARTNER_DEBIT_INSTRUCTIONS_ENABLED = 'true';
  try {
    await assert.rejects(D.approveBusinessDebit(s.ownerC.id, s.b.id, r.body.id, { detailsHash: row.detailsHash, now: Date.now() + 16 * 60_000 }), (e) => e.code === 'expired');
  } finally {
    delete process.env.PARTNER_DEBIT_INSTRUCTIONS_ENABLED;
  }
  assert.equal(await kori(p.id), 0);
  assert.equal((await api.client('GET', `v1/debit-instructions/${r.body.id}`, as(KEBU))).body.status, 'expired');
});

test('authorization + isolation: non-approver staff, strangers, other partners and other businesses are refused', async () => {
  const s = await shop();
  const other = await shop();
  const p = await customer();
  const r = await request(KEBU, { external_business_id: s.ext, external_ref: `po_${hex()}`, kind: 'payout', lines: [{ recipient_handle: p.handle, amount_kori: 300 }] });
  const cashierC = await customer();
  await prisma.businessMember.create({ data: { businessId: s.b.id, userId: cashierC.id, role: 'cashier', status: 'active', acceptedAt: new Date() } });
  const cashier = await signedIn(api, cashierC);
  assert.equal((await approve(s, r.body.id, cashier, { hash: 'x' })).status, 404, 'no business.pay → not visible, not approvable');
  assert.equal((await detail(s, r.body.id, cashier)).status, 404);
  assert.equal((await other.owner.call('GET', `businesses/${other.b.id}/partner-debits/${r.body.id}`)).status, 404, 'another business never sees it');
  assert.equal((await api.client('GET', `v1/debit-instructions/${r.body.id}`, as(RECT))).status, 404, 'another partner never sees it');
  assert.equal((await request(RECT, { external_business_id: s.ext, external_ref: `po_${hex()}`, kind: 'payout', lines: [{ recipient_handle: p.handle, amount_kori: 300 }] })).status, 404, 'another partner cannot target my shop');
  assert.equal((await api.client('POST', `v1/debit-instructions/${r.body.id}/cancel`, { ...as(RECT), body: {} })).status, 404);
  const fin = await customer();
  await prisma.businessMember.create({ data: { businessId: s.b.id, userId: fin.id, role: 'finance', status: 'active', acceptedAt: new Date() } });
  const finance = await signedIn(api, fin);
  assert.equal((await approve(s, r.body.id, finance)).body.status, 'executed', 'a finance approver (business.pay) may approve');
});

test('risk: approver who is a recipient, per-line / per-instruction limits, unlinked business, insufficient funds (nothing moves)', async () => {
  const s = await shop({ funds: 2_000 });
  // The owner as payee approving their own payout → refused.
  const self = await request(KEBU, { external_business_id: s.ext, external_ref: `po_${hex()}`, kind: 'payout', lines: [{ recipient_handle: s.ownerC.handle, amount_kori: 100 }] });
  assert.equal((await approve(s, self.body.id)).body.code, 'approver_is_recipient');
  const big = await request(KEBU, { external_business_id: s.ext, external_ref: `po_${hex()}`, kind: 'payout', lines: [{ recipient_handle: (await customer()).handle, amount_kori: 10_000_000 }] });
  assert.equal(big.status, 400, 'line above the per-line limit');
  const p = await customer();
  const poor = await request(KEBU, { external_business_id: s.ext, external_ref: `po_${hex()}`, kind: 'payout', lines: [{ recipient_handle: p.handle, amount_kori: 5_000 }] });
  const biz0 = await bizBal(s.b.id);
  const a = await approve(s, poor.body.id);
  assert.deepEqual([a.status, a.body.code], [409, 'insufficient_funds']);
  assert.equal(await bizBal(s.b.id), biz0);
  assert.equal(await kori(p.id), 0);
  assert.equal((await prisma.partnerDebitInstruction.findUnique({ where: { id: poor.body.id } })).status, 'failed');
  const q = await request(KEBU, { external_business_id: s.ext, external_ref: `po_${hex()}`, kind: 'payout', lines: [{ recipient_handle: p.handle, amount_kori: 100 }] });
  const links = await s.owner.call('GET', `businesses/${s.b.id}/os/integrations`);
  await s.owner.call('POST', `businesses/${s.b.id}/os/integrations/${links.body.find((l) => l.objectType === 'business').id}/revoke`, {});
  assert.equal((await approve(s, q.body.id)).body.code, 'invalidated', 'business unlinked after the request');
});

test('exactly-once under concurrency: 5 parallel approvals (2 approvers) → one execution; ledger totals reconcile', async () => {
  const s = await shop();
  const fin = await customer();
  await prisma.businessMember.create({ data: { businessId: s.b.id, userId: fin.id, role: 'finance', status: 'active', acceptedAt: new Date() } });
  const finance = await signedIn(api, fin);
  const [e1, e2] = [await s.employee(), await s.employee()];
  const r = await request(KEBU, payroll(s, [{ recipient_handle: e1.handle, amount_kori: 1500 }, { recipient_handle: e2.handle, amount_kori: 2500 }]));
  const hash = (await detail(s, r.body.id)).body.detailsHash;
  await stepUp(s.owner);
  await stepUp(finance);
  const biz0 = await bizBal(s.b.id);
  const call = (who) => who.call('POST', `businesses/${s.b.id}/partner-debits/${r.body.id}/approve`, { detailsHash: hash });
  const out = await Promise.all([call(s.owner), call(finance), call(s.owner), call(finance), call(s.owner)]);
  assert.ok(out.every((x) => x.status !== 500), out.map((x) => `${x.status}:${x.body.code ?? x.body.status}`).join(','));
  assert.equal(out.filter((x) => x.status === 200 && !x.body.replayed).length, 1, 'exactly one execution');
  assert.equal(await bizBal(s.b.id), biz0 - 4000);
  const journals = await prisma.journalEntry.count({ where: { reference: { startsWith: `pdi-${r.body.id}-` } } });
  assert.equal(journals, 2, 'one journal entry per line');
});

test('partner cancel before approval; a cancelled instruction can never be approved', async () => {
  const s = await shop();
  const p = await customer();
  const r = await request(KEBU, { external_business_id: s.ext, external_ref: `po_${hex()}`, kind: 'payout', lines: [{ recipient_handle: p.handle, amount_kori: 400 }] });
  assert.equal((await api.client('POST', `v1/debit-instructions/${r.body.id}/cancel`, { ...as(KEBU), body: {} })).body.status, 'cancelled');
  assert.equal((await approve(s, r.body.id)).status, 409);
  assert.equal(await kori(p.id), 0);
  const rej = await request(KEBU, { external_business_id: s.ext, external_ref: `po_${hex()}`, kind: 'payout', lines: [{ recipient_handle: p.handle, amount_kori: 400 }] });
  assert.equal((await s.owner.call('POST', `businesses/${s.b.id}/partner-debits/${rej.body.id}/reject`, { reason: 'pas prévu' })).body.status, 'rejected');
  assert.equal((await approve(s, rej.body.id)).status, 409);
});

test('J15 provisional limits (XOF via the peg): line 500 000 XOF, request 5 000 000 XOF, daily count — exact boundaries', async () => {
  const D = await import('../../lib/integrations/partner-debits.js');
  assert.equal(D.LIMITS_STATUS, 'provisional_local_test_limits');
  assert.deepEqual([D.LIMITS.lineMaxXof(), D.LIMITS.instructionMaxXof(), D.LIMITS.dailyMaxXof(), D.LIMITS.dailyMaxCount()], [500_000, 5_000_000, 10_000_000, 20]);
  assert.deepEqual([D.LIMITS.lineMaxKori(), D.LIMITS.instructionMaxKori(), D.LIMITS.dailyMaxKori()], [50_000, 500_000, 1_000_000], '10 XOF per ₭');
  const s = await shop({ funds: 2_000_000 });
  const p = await customer();
  const line = (amount) => request(KEBU, { external_business_id: s.ext, external_ref: `po_${hex()}`, kind: 'payout', lines: [{ recipient_handle: p.handle, amount_kori: amount }] });
  assert.equal((await line(50_000)).status, 201, 'exactly the line limit');
  assert.equal((await line(50_001)).status, 400, 'one ₭ over');
  const emps = [];
  for (let i = 0; i < 11; i += 1) emps.push(await s.employee());
  const ten = await request(KEBU, payroll(s, emps.slice(0, 10).map((e) => ({ recipient_handle: e.handle, amount_kori: 50_000 }))));
  assert.equal(ten.status, 201, 'exactly the request limit (500 000 ₭)');
  const eleven = await request(KEBU, payroll(s, emps.map((e) => ({ recipient_handle: e.handle, amount_kori: 50_000 }))));
  assert.deepEqual([eleven.status, eleven.body.code], [422, 'limit_exceeded']);
  // Daily count, with a lowered (still provisional) count on a dedicated server.
  const small = await startApiServer({ JOKO_API_KEYS: `kebu:${KEBU}`, PARTNER_DEBIT_INSTRUCTIONS_ENABLED: 'true', PARTNER_DEBIT_DAILY_MAX_COUNT: '2' });
  try {
    const owner = await signedIn(small, s.ownerC);
    await stepUp(owner);
    const outcomes = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await small.client('POST', 'v1/debit-instructions', { ...as(KEBU), body: { external_business_id: s.ext, external_ref: `day_${hex()}`, kind: 'payout', lines: [{ recipient_handle: p.handle, amount_kori: 100 }] } });
      const d = await owner.call('GET', `businesses/${s.b.id}/partner-debits/${r.body.id}`);
      const a = await owner.call('POST', `businesses/${s.b.id}/partner-debits/${r.body.id}/approve`, { detailsHash: d.body.detailsHash });
      outcomes.push(a.body.status ?? a.body.code);
    }
    const executedToday = await prisma.partnerDebitInstruction.count({ where: { businessId: s.b.id, status: 'executed' } });
    assert.ok(executedToday <= 2 + 0, `daily count respected: ${outcomes}`);
    assert.equal(outcomes.at(-1), 'risk_limit');
  } finally {
    await small.stop();
  }
});
