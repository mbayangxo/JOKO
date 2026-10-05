/**
 * J6.4 — cash-in vertical slice over real HTTP (production mode).
 * customer intent → agent scan (binds + reserves e-float) → customer confirms
 * → agent completes with PIN → one J2 posting → receipts. J2 invariants
 * after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { customer, operator, signedIn } from '../j3/helpers.js';
import { sweepCash } from '../../lib/agents/cash.js';
import { activeAgent, cashIn, floatOf, held, idem, pinned, wallet, withKey } from './helpers.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

async function person(tier = 2) {
  return signedIn(api, await customer({ tier }));
}
async function bound(cust, ag, amountXof = 20_000) {
  const c = await cust.call('POST', 'agent-cash/in', { amountXof }, idem());
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const scan = await ag.s.call('POST', 'agent/cash/scan', { qr: c.body.qr });
  assert.equal(scan.status, 200, JSON.stringify(scan.body));
  return { id: c.body.transaction.id, qr: c.body.qr, b: scan.body.transaction.bindingHash, view: scan.body.transaction };
}

test('happy path: credited only after customer confirmation AND agent PIN completion; receipts on both sides; no PII to the agent', async () => {
  const ag = await activeAgent(api);
  const cust = await person();
  const c = await cust.call('POST', 'agent-cash/in', { amountXof: 20_000 }, idem());
  assert.equal(c.body.transaction.status, 'pending');
  assert.match(c.body.qr, /^jokko:\/\/cash\/[A-Za-z0-9_-]{24}$/, 'QR carries only an opaque token');
  const scan = await ag.s.call('POST', 'agent/cash/scan', { qr: c.body.qr });
  const text = JSON.stringify(scan.body);
  assert.ok(!text.includes(cust.phone) && !text.includes(cust.id) && !text.includes(cust.handle), 'agent sees no phone, id or handle');
  assert.equal(scan.body.transaction.amountXof, 20_000, 'both sides see the authoritative amount');
  assert.equal(await held(ag.profile.id), 20_000, 'e-float reserved at binding');
  assert.equal(await wallet(cust.id), 0);

  // PIN is required to complete (no fresh step-up in this session yet).
  assert.equal((await ag.s.call('POST', `agent/cash/${c.body.transaction.id}/complete`, { bindingHash: scan.body.transaction.bindingHash })).body.code, 'step_up_required');
  // The agent cannot credit before the customer confirms (no "the UI says cash was received").
  const early = await ag.s.call('POST', `agent/cash/${c.body.transaction.id}/complete`, { bindingHash: scan.body.transaction.bindingHash }, { headers: await pinned(ag.s) });
  assert.equal(early.status, 409);
  assert.equal(early.body.code, 'not_completable');
  // The customer sees the agent before confirming.
  const seen = await cust.call('GET', `agent-cash/tx/${c.body.transaction.id}`);
  assert.equal(seen.body.transaction.servicePoint.agentCode, ag.profile.agentCode);
  assert.equal((await cust.call('POST', `agent-cash/tx/${c.body.transaction.id}/confirm`, { bindingHash: scan.body.transaction.bindingHash })).status, 200);
  const done = await ag.s.call('POST', `agent/cash/${c.body.transaction.id}/complete`, { bindingHash: scan.body.transaction.bindingHash }, { headers: await pinned(ag.s) });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.receipt.amountXof, 20_000);
  assert.equal(await wallet(cust.id), 2000);
  assert.equal(await floatOf(ag.profile.id), 180_000);
  assert.equal(await held(ag.profile.id), 0);
  const mine = await cust.call('GET', `agent-cash/tx/${c.body.transaction.id}`);
  assert.equal(mine.body.receipt.reference, done.body.receipt.reference);
  assert.equal(await prisma.journalEntry.count({ where: { reference: { startsWith: done.body.transaction.reference }, kind: 'agent_cash_in' } }), 1);
});

test('duplicate submit (same key ×5 concurrent) → one transaction; duplicate confirm / complete ×5 concurrent → one credit', async () => {
  const ag = await activeAgent(api);
  const cust = await person();
  const k = 'dup-key-cash-in-1';
  const runs = await Promise.all([1, 2, 3, 4, 5].map(() => cust.call('POST', 'agent-cash/in', { amountXof: 10_000 }, withKey(k))));
  // Concurrent duplicates: the first wins, the others replay it or are told it is in progress (J4).
  assert.ok(runs.every((r) => r.status < 300 || r.body.code === 'idempotency_in_progress'), JSON.stringify(runs.map((r) => r.body)));
  assert.equal(new Set(runs.filter((r) => r.status < 300).map((r) => r.body.transaction.id)).size, 1);
  assert.equal(await prisma.agentCashTransaction.count({ where: { customerId: cust.id } }), 1);
  assert.equal((await cust.call('POST', 'agent-cash/in', { amountXof: 12_000 }, withKey(k))).body.code, 'idempotency_key_reuse', 'same key, changed amount');
  const qr = runs.find((r) => r.body?.qr)?.body.qr;
  const scan = await ag.s.call('POST', 'agent/cash/scan', { qr });
  const b = scan.body.transaction.bindingHash;
  const id = scan.body.transaction.id;
  await Promise.all([1, 2, 3].map(() => cust.call('POST', `agent-cash/tx/${id}/confirm`, { bindingHash: b })));
  const headers = await pinned(ag.s);
  const done = await Promise.all([1, 2, 3, 4, 5].map(() => ag.s.call('POST', `agent/cash/${id}/complete`, { bindingHash: b }, { headers })));
  assert.ok(done.every((r) => r.status === 200), JSON.stringify(done.map((r) => r.body)));
  assert.equal(await wallet(cust.id), 1000);
  assert.equal(await floatOf(ag.profile.id), 190_000);
});

test('wrong customer / wrong agent / changed amount are refused', async () => {
  const ag = await activeAgent(api);
  const other = await activeAgent(api);
  const cust = await person();
  const stranger = await person();
  const t = await bound(cust, ag);
  for (const [m, p, body] of [['GET', `agent-cash/tx/${t.id}`], ['POST', `agent-cash/tx/${t.id}/confirm`, { bindingHash: t.b }], ['POST', `agent-cash/tx/${t.id}/cancel`, {}]]) {
    assert.equal((await stranger.call(m, p, body)).status, 404, `stranger ${m} ${p}`);
  }
  assert.equal((await other.s.call('POST', 'agent/cash/scan', { qr: t.qr })).body.code, 'already_bound', 'another agent cannot take a bound QR');
  assert.equal((await other.s.call('POST', `agent/cash/${t.id}/complete`, { bindingHash: t.b }, { headers: await pinned(other.s) })).status, 404);
  assert.equal((await other.s.call('GET', `agent-cash/tx/${t.id}`)).status, 404);
  // A forged binding (any other agent / amount) does not match.
  assert.equal((await cust.call('POST', `agent-cash/tx/${t.id}/confirm`, { bindingHash: '0'.repeat(64) })).body.code, 'binding_mismatch');
  // Amount and parties are immutable in the database.
  await assert.rejects(prisma.agentCashTransaction.update({ where: { id: t.id }, data: { amountXof: 900_000 } }));
  await assert.rejects(prisma.agentCashTransaction.update({ where: { id: t.id }, data: { agentId: other.profile.id } }));
  await assert.rejects(prisma.agentCashTransaction.update({ where: { id: t.id }, data: { customerId: stranger.id } }));
  await assert.rejects(prisma.agentCashTransaction.delete({ where: { id: t.id } }));
  assert.equal(await wallet(stranger.id), 0);
});

test('insufficient float / customer balance cap / per-point max are refused before anything is reserved', async () => {
  const poor = await activeAgent(api, { floatXof: 10_000 });
  const cust = await person();
  const c = await cust.call('POST', 'agent-cash/in', { amountXof: 20_000 }, idem());
  const scan = await poor.s.call('POST', 'agent/cash/scan', { qr: c.body.qr });
  assert.equal(scan.body.code, 'insufficient_float');
  assert.equal(await held(poor.profile.id), 0);
  assert.equal((await prisma.agentCashTransaction.findUnique({ where: { id: c.body.transaction.id } })).state, 'created', 'still open for another agent');

  const t1 = await person(1); // tier 1: 5 000 ₭ balance cap
  const capped = await t1.call('POST', 'agent-cash/in', { amountXof: 100_000 }, idem());
  assert.equal(capped.status, 403);
  assert.equal(capped.body.code, 'tier_balance_cap');
  const tooBig = await cust.call('POST', 'agent-cash/in', { amountXof: 9_000_000 }, idem());
  assert.equal(tooBig.body.code, 'amount_too_high');
  const odd = await cust.call('POST', 'agent-cash/in', { amountXof: 10_005 }, idem());
  assert.equal(odd.body.code, 'amount_not_multiple');
  const big = await activeAgent(api, { floatXof: 400_000 });
  const c2 = await cust.call('POST', 'agent-cash/in', { amountXof: 900_000 }, idem());
  assert.equal((await big.s.call('POST', 'agent/cash/scan', { qr: c2.body.qr })).body.code, 'amount_too_high', 'standard point max 500 000');
});

test('expired / cancelled: holds released exactly once; cancel after the customer confirmed is refused', async () => {
  const ag = await activeAgent(api);
  const cust = await person();
  // Unscanned and expired.
  const c = await cust.call('POST', 'agent-cash/in', { amountXof: 10_000 }, idem());
  await prisma.agentCashTransaction.update({ where: { id: c.body.transaction.id }, data: { challengeExpiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await ag.s.call('POST', 'agent/cash/scan', { qr: c.body.qr })).body.code, 'expired');
  // Bound, then cancelled by the customer → float back.
  const t = await bound(cust, ag);
  assert.equal(await held(ag.profile.id), 20_000);
  const cancels = await Promise.all([1, 2, 3].map(() => cust.call('POST', `agent-cash/tx/${t.id}/cancel`, {})));
  assert.ok(cancels.every((r) => r.status === 200), JSON.stringify(cancels.map((r) => r.body)));
  assert.equal(await held(ag.profile.id), 0);
  assert.equal(await floatOf(ag.profile.id), 200_000);
  // Bound, never confirmed, deadline passes → expired + release (sweep run twice concurrently).
  const t2 = await bound(cust, ag);
  await prisma.agentCashTransaction.update({ where: { id: t2.id }, data: { reviewDeadline: new Date(Date.now() - 1000) } });
  await Promise.all([sweepCash(), sweepCash()]);
  assert.equal((await prisma.agentCashTransaction.findUnique({ where: { id: t2.id } })).state, 'expired');
  assert.equal(await held(ag.profile.id), 0);
  assert.equal(await prisma.journalEntry.count({ where: { reference: { startsWith: (await prisma.agentCashTransaction.findUnique({ where: { id: t2.id } })).reference }, kind: 'agent_float_release' } }), 1);
  // Confirmed → the customer can no longer cancel (they handed cash); the agent completes or declines.
  const t3 = await bound(cust, ag);
  await cust.call('POST', `agent-cash/tx/${t3.id}/confirm`, { bindingHash: t3.b });
  assert.equal((await cust.call('POST', `agent-cash/tx/${t3.id}/cancel`, {})).body.code, 'not_cancellable');
  const dec = await ag.s.call('POST', `agent/cash/${t3.id}/decline`, { reason: 'no cash received' });
  assert.equal(dec.body.transaction.state, 'declined');
  assert.equal(await held(ag.profile.id), 0);
  assert.equal(await wallet(cust.id), 0);
});

test('agent suspended / terminated mid-flow: bound → declined + released; confirmed → needs_review (nothing paid, nothing lost)', async () => {
  const ag = await activeAgent(api);
  const cust = await person();
  const pre = await bound(cust, ag);
  const post = await bound(cust, ag, 30_000);
  await cust.call('POST', `agent-cash/tx/${post.id}/confirm`, { bindingHash: post.b });
  const risk = await operator(api, ['risk']);
  assert.equal((await risk.call('POST', `admin/agents/${ag.profile.id}/suspend`, { reason: 'investigation' })).status, 200);
  assert.equal((await prisma.agentCashTransaction.findUnique({ where: { id: pre.id } })).state, 'declined');
  assert.equal((await prisma.agentCashTransaction.findUnique({ where: { id: post.id } })).state, 'needs_review');
  assert.equal(await held(ag.profile.id), 30_000, 'the committed one stays reserved for review');
  const blocked = await ag.s.call('POST', `agent/cash/${post.id}/complete`, { bindingHash: post.b }, { headers: await pinned(ag.s) });
  assert.equal(blocked.status, 403);
  assert.equal(await wallet(cust.id), 0);
  // Review: risk requests release, a finance approver (different operator) executes it.
  const fa = await operator(api, ['finance_approver']);
  const req = await risk.call('POST', `admin/cash/${post.id}/resolve`, { outcome: 'release', reason: 'agent suspended, cash not received' });
  assert.equal(req.status, 202, JSON.stringify(req.body));
  assert.equal((await risk.call('POST', `admin/approvals/${req.body.approval.id}/approve`, {})).status, 403, 'maker cannot approve');
  const ok = await fa.call('POST', `admin/approvals/${req.body.approval.id}/approve`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await prisma.agentCashTransaction.findUnique({ where: { id: post.id } })).state, 'released');
  assert.equal(await held(ag.profile.id), 0);
  assert.equal(await floatOf(ag.profile.id), 200_000);

  const ag2 = await activeAgent(api);
  const t = await bound(cust, ag2);
  const comp = await operator(api, ['compliance']);
  assert.equal((await comp.call('POST', `admin/agents/${ag2.profile.id}/terminate`, { reason: 'contract ended by the network' })).status, 200);
  assert.equal((await prisma.agentCashTransaction.findUnique({ where: { id: t.id } })).state, 'declined');
  assert.equal((await ag2.s.call('POST', 'agent/cash/scan', { qr: 'jokko://cash/AAAAAAAAAAAAAAAAAAAAAAAA' })).status, 403);
});

test('response lost after settlement / retry / app restart: the state is read back, never re-executed', async () => {
  const ag = await activeAgent(api);
  const cust = await person();
  const done = await cashIn(cust, ag, 20_000);
  const id = done.transaction.id;
  // Agent retries the completion (lost response): same result, no second credit.
  const again = await ag.s.call('POST', `agent/cash/${id}/complete`, { bindingHash: done.transaction.bindingHash ?? 'x'.repeat(64) }, { headers: await pinned(ag.s) });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.transaction.state, 'completed');
  assert.equal(await wallet(cust.id), 2000);
  // App restart: the customer lists their operations and finds it completed with a receipt.
  const list = await cust.call('GET', 'agent-cash/tx');
  assert.equal(list.body.transactions[0].status, 'completed');
  assert.ok(!/réessa|recommence|try again/i.test(list.body.transactions[0].nextStep));
  // An open one survives a restart and can get a NEW QR (the old one dies).
  const open = await cust.call('POST', 'agent-cash/in', { amountXof: 10_000 }, idem());
  const re = await cust.call('POST', `agent-cash/tx/${open.body.transaction.id}/challenge`, {});
  assert.equal(re.status, 200);
  assert.notEqual(re.body.qr, open.body.qr);
  assert.equal((await ag.s.call('POST', 'agent/cash/scan', { qr: open.body.qr })).body.code, 'invalid_code', 'old QR is dead');
  assert.equal((await ag.s.call('POST', 'agent/cash/scan', { qr: re.body.qr })).status, 200);
  assert.equal((await cust.call('POST', `agent-cash/tx/${open.body.transaction.id}/challenge`, {})).body.code, 'not_reissuable', 'no new QR once bound');
});

test('concurrent cash-ins against one agent: never more reserved than the float; float never negative', async () => {
  const ag = await activeAgent(api, { floatXof: 50_000 });
  const custs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => person()));
  const intents = await Promise.all(custs.map((c) => c.call('POST', 'agent-cash/in', { amountXof: 20_000 }, idem())));
  const scans = await Promise.all(intents.map((i) => ag.s.call('POST', 'agent/cash/scan', { qr: i.body.qr })));
  const okScans = scans.filter((r) => r.status === 200);
  assert.equal(okScans.length, 2, '50 000 float covers two 20 000 cash-ins');
  assert.ok(scans.filter((r) => r.status !== 200).every((r) => r.body.code === 'insufficient_float'));
  assert.equal(await held(ag.profile.id), 40_000);
  assert.equal(await floatOf(ag.profile.id), 10_000);
  const headers = await pinned(ag.s);
  await Promise.all(okScans.map(async (s) => {
    const c = custs[scans.indexOf(s)];
    await c.call('POST', `agent-cash/tx/${s.body.transaction.id}/confirm`, { bindingHash: s.body.transaction.bindingHash });
    return ag.s.call('POST', `agent/cash/${s.body.transaction.id}/complete`, { bindingHash: s.body.transaction.bindingHash }, { headers });
  }));
  assert.equal(await floatOf(ag.profile.id), 10_000);
  assert.equal(await held(ag.profile.id), 0);
  const credited = (await Promise.all(custs.map((c) => wallet(c.id)))).reduce((a, b) => a + b, 0);
  assert.equal(credited, 4000);
});
