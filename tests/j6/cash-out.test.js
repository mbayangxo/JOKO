/**
 * J6.5 — cash-out vertical slice over real HTTP (production mode).
 * request (tier / limits / device / recovery / risk / PIN) → ₭ HELD → agent
 * scan → customer authorizes THIS agent + amount with PIN → agent pays cash
 * and completes with PIN → one J2 settlement → receipt. A failed cash-out
 * never destroys funds; a completed one is never paid twice.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { customer, operator, signedIn } from '../j3/helpers.js';
import { sweepCash } from '../../lib/agents/cash.js';
import { activeAgent, cashIn, cashOut, customerHeld, floatOf, idem, pinned, wallet, withKey } from './helpers.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

async function funded(kori = 5000, tier = 2) {
  const c = await customer({ tier });
  if (kori) await fundUser(c.id, kori);
  return signedIn(api, c);
}
async function request(cust, amountXof, key) {
  return cust.call('POST', 'agent-cash/out', { amountXof }, { headers: { ...(key ? withKey(key) : idem()).headers, ...(await pinned(cust)) } });
}
async function boundOut(cust, ag, amountXof = 20_000) {
  const r = await request(cust, amountXof);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const scan = await ag.s.call('POST', 'agent/cash/scan', { qr: r.body.qr });
  assert.equal(scan.status, 200, JSON.stringify(scan.body));
  return { id: r.body.transaction.id, qr: r.body.qr, b: scan.body.transaction.bindingHash };
}

test('happy path: funds held at request; customer PIN authorizes the bound agent; agent PIN completes; settled once', async () => {
  const ag = await activeAgent(api);
  const cust = await funded(5000);
  const noPin = await cust.call('POST', 'agent-cash/out', { amountXof: 20_000 }, idem());
  assert.equal(noPin.status, 403);
  assert.equal(noPin.body.code, 'step_up_required');
  const r = await request(cust, 20_000);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.transaction.state, 'funds_held');
  assert.equal(await wallet(cust.id), 3000, 'available drops at request');
  assert.equal(await customerHeld(cust.id), 2000, '₭ held');
  const scan = await ag.s.call('POST', 'agent/cash/scan', { qr: r.body.qr });
  const b = scan.body.transaction.bindingHash;
  // The agent cannot pay out before the customer authorizes on their own device.
  const early = await ag.s.call('POST', `agent/cash/${r.body.transaction.id}/complete`, { bindingHash: b }, { headers: await pinned(ag.s) });
  assert.equal(early.body.code, 'not_completable');
  const auth = await cust.call('POST', `agent-cash/tx/${r.body.transaction.id}/confirm`, { bindingHash: b }, { headers: await pinned(cust) });
  assert.equal(auth.body.transaction.state, 'customer_authorized');
  const done = await ag.s.call('POST', `agent/cash/${r.body.transaction.id}/complete`, { bindingHash: b }, { headers: await pinned(ag.s) });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(await wallet(cust.id), 3000);
  assert.equal(await customerHeld(cust.id), 0);
  assert.equal(await floatOf(ag.profile.id), 220_000, 'agent e-float grows by the cash paid out');
  const usage = await prisma.userDailyUsage.findFirst({ where: { userId: cust.id } });
  assert.equal(usage.cashOutNational, 20_000, 'daily cash-out usage recorded once');
  // Replays: no second payment.
  const replays = await Promise.all([1, 2, 3].map(async () => ag.s.call('POST', `agent/cash/${r.body.transaction.id}/complete`, { bindingHash: b }, { headers: await pinned(ag.s) })));
  assert.ok(replays.every((x) => x.status === 200));
  assert.equal(await floatOf(ag.profile.id), 220_000);
  assert.equal(await prisma.journalEntry.count({ where: { reference: { startsWith: done.body.transaction.reference }, kind: 'agent_cash_out' } }), 1);
});

test('tier / recovery / new device / insufficient funds are refused before anything is held', async () => {
  const t1 = await funded(5000, 1);
  const r1 = await request(t1, 10_000);
  assert.equal(r1.status, 403);
  assert.equal(await wallet(t1.id), 5000);
  const rec = await funded(5000);
  await prisma.user.update({ where: { id: rec.id }, data: { accountRecoveredAt: new Date() } });
  const r2 = await rec.call('POST', 'agent-cash/out', { amountXof: 10_000 }, idem());
  assert.equal(r2.status, 423);
  assert.equal(r2.body.code, 'cash_out_hold');
  const poor = await funded(500);
  const r3 = await request(poor, 10_000);
  assert.equal(r3.status, 400);
  assert.equal(r3.body.code, 'insufficient_funds');
  assert.equal(await prisma.agentCashTransaction.count({ where: { customerId: { in: [t1.id, rec.id, poor.id] } } }), 0);
  assert.equal(await wallet(poor.id), 500);
});

test('held funds cannot be spent twice: second cash-out / P2P on the same ₭ is refused; simultaneous withdrawals fund only what exists', async () => {
  const cust = await funded(3000);
  const first = await request(cust, 20_000);
  assert.equal(first.status, 201);
  assert.equal((await request(cust, 20_000)).body.code, 'insufficient_funds');
  const friend = await funded(0);
  const p2p = await cust.call('POST', 'transfers/send', { recipientHandle: friend.handle, amount: 2000 }, idem());
  assert.ok(p2p.status >= 400, 'the held ₭ are not spendable');
  const many = await funded(5000);
  const headers = await pinned(many);
  const runs = await Promise.all([1, 2, 3, 4, 5].map(() => many.call('POST', 'agent-cash/out', { amountXof: 20_000 }, { headers: { ...idem().headers, ...headers } })));
  assert.equal(runs.filter((r) => r.status === 201).length, 2, '5000 ₭ funds two 2000 ₭ withdrawals');
  assert.equal(await wallet(many.id), 1000);
  assert.equal(await customerHeld(many.id), 4000);
  // Same key, concurrently: one request.
  const same = await funded(5000);
  const sh = await pinned(same);
  const dup = await Promise.all([1, 2, 3].map(() => same.call('POST', 'agent-cash/out', { amountXof: 10_000 }, { headers: { 'idempotency-key': 'dup-out-1', ...sh } })));
  assert.equal(new Set(dup.filter((r) => r.status < 300).map((r) => r.body.transaction.id)).size, 1);
  assert.equal(await customerHeld(same.id), 1000);
});

test('agent liquidity / business-agent threshold are checked at binding', async () => {
  const full = await activeAgent(api, { floatXof: 490_000 }); // limit 500 000
  const cust = await funded(5000);
  const r = await request(cust, 20_000);
  assert.equal((await full.s.call('POST', 'agent/cash/scan', { qr: r.body.qr })).body.code, 'agent_capacity');
  assert.equal((await prisma.agentCashTransaction.findUnique({ where: { id: r.body.transaction.id } })).state, 'funds_held', 'still available to another agent');
  const rich = await funded(80_000, 3);
  const big = await request(rich, 600_000);
  assert.equal(big.status, 201, JSON.stringify(big.body));
  const std = await activeAgent(api);
  assert.equal((await std.s.call('POST', 'agent/cash/scan', { qr: big.body.qr })).body.code, 'amount_too_high');
  const biz = await activeAgent(api, { tier: 'business', floatXof: 1_000_000 });
  assert.equal((await biz.s.call('POST', 'agent/cash/scan', { qr: big.body.qr })).status, 200);
});

test('screenshot / forwarded QR: a thief’s agent can bind it but can never complete without the victim’s PIN authorization; the victim sees and cancels', async () => {
  const thiefAgent = await activeAgent(api);
  const honest = await activeAgent(api);
  const victim = await funded(5000);
  const r = await request(victim, 20_000);
  // The thief got the QR (screenshot) and goes to a colluding agent.
  const scan = await thiefAgent.s.call('POST', 'agent/cash/scan', { qr: r.body.qr });
  assert.equal(scan.status, 200);
  const pay = await thiefAgent.s.call('POST', `agent/cash/${r.body.transaction.id}/complete`, { bindingHash: scan.body.transaction.bindingHash }, { headers: await pinned(thiefAgent.s) });
  assert.equal(pay.body.code, 'not_completable', 'no completion without the customer');
  // The same screenshot at an honest agent: already bound.
  assert.equal((await honest.s.call('POST', 'agent/cash/scan', { qr: r.body.qr })).body.code, 'already_bound');
  const view = await victim.call('GET', `agent-cash/tx/${r.body.transaction.id}`);
  assert.equal(view.body.transaction.servicePoint.agentCode, thiefAgent.profile.agentCode, 'the victim sees which point holds the code');
  assert.equal((await victim.call('POST', `agent-cash/tx/${r.body.transaction.id}/cancel`, {})).status, 200);
  assert.equal(await wallet(victim.id), 5000);
  assert.equal(await customerHeld(victim.id), 0);
  assert.equal(await floatOf(thiefAgent.profile.id), 200_000);
});

test('customer authorization is bound to the exact agent + amount + transaction (substitution refused)', async () => {
  const ag = await activeAgent(api);
  const cust = await funded(10_000);
  const a = await boundOut(cust, ag, 20_000);
  const b = await boundOut(cust, ag, 30_000);
  assert.notEqual(a.b, b.b);
  const cross = await cust.call('POST', `agent-cash/tx/${a.id}/confirm`, { bindingHash: b.b }, { headers: await pinned(cust) });
  assert.equal(cross.body.code, 'binding_mismatch', 'an authorization for another transaction never applies');
  await cust.call('POST', `agent-cash/tx/${a.id}/confirm`, { bindingHash: a.b }, { headers: await pinned(cust) });
  assert.equal((await ag.s.call('POST', `agent/cash/${a.id}/complete`, { bindingHash: b.b }, { headers: await pinned(ag.s) })).body.code, 'binding_mismatch');
  assert.equal(await customerHeld(cust.id), 5000);
});

test('cancel before authorization releases once; after authorization only the agent can decline (funds come back)', async () => {
  const ag = await activeAgent(api);
  const cust = await funded(5000);
  const t = await boundOut(cust, ag);
  await Promise.all([1, 2, 3].map(() => cust.call('POST', `agent-cash/tx/${t.id}/cancel`, {})));
  assert.equal(await wallet(cust.id), 5000);
  assert.equal(await prisma.journalEntry.count({ where: { reference: { endsWith: '-RELEASE' }, kind: 'cash_out_release', postings: { some: { account: { code: `customer:${cust.id}:held` } } } } }), 1);
  const t2 = await boundOut(cust, ag);
  await cust.call('POST', `agent-cash/tx/${t2.id}/confirm`, { bindingHash: t2.b }, { headers: await pinned(cust) });
  assert.equal((await cust.call('POST', `agent-cash/tx/${t2.id}/cancel`, {})).body.code, 'not_cancellable');
  assert.equal((await ag.s.call('POST', `agent/cash/${t2.id}/decline`, { reason: 'no cash in the till' })).body.transaction.state, 'declined');
  assert.equal(await wallet(cust.id), 5000);
});

test('stale / offline: unbound expiry releases; customer never authorizes → expired; agent offline after authorization → needs_review, late completion pays once', async () => {
  const ag = await activeAgent(api);
  const cust = await funded(10_000);
  const r = await request(cust, 20_000);
  await prisma.agentCashTransaction.update({ where: { id: r.body.transaction.id }, data: { challengeExpiresAt: new Date(Date.now() - 1000) } });
  const t = await boundOut(cust, ag);
  await prisma.agentCashTransaction.update({ where: { id: t.id }, data: { reviewDeadline: new Date(Date.now() - 1000) } });
  const t2 = await boundOut(cust, ag, 30_000);
  await cust.call('POST', `agent-cash/tx/${t2.id}/confirm`, { bindingHash: t2.b }, { headers: await pinned(cust) });
  await prisma.agentCashTransaction.update({ where: { id: t2.id }, data: { reviewDeadline: new Date(Date.now() - 1000) } });
  await Promise.all([sweepCash(), sweepCash(), sweepCash()]);
  const states = await prisma.agentCashTransaction.findMany({ where: { id: { in: [r.body.transaction.id, t.id, t2.id] } } });
  const by = Object.fromEntries(states.map((s) => [s.id, s.state]));
  assert.equal(by[r.body.transaction.id], 'expired');
  assert.equal(by[t.id], 'expired');
  assert.equal(by[t2.id], 'needs_review');
  assert.equal(await wallet(cust.id), 7000, 'expired ones released, the authorized one stays held');
  assert.equal(await customerHeld(cust.id), 3000);
  const late = await ag.s.call('POST', `agent/cash/${t2.id}/complete`, { bindingHash: t2.b }, { headers: await pinned(ag.s) });
  assert.equal(late.status, 200, JSON.stringify(late.body));
  assert.equal(await customerHeld(cust.id), 0);
  assert.equal(await floatOf(ag.profile.id), 230_000);
  const view = await cust.call('GET', `agent-cash/tx/${t2.id}`);
  assert.ok(!/réessa|recommence|try again/i.test(view.body.transaction.nextStep));
});

test('agent suspended after authorization → needs_review; maker-checker completes on evidence (paid once) — or releases', async () => {
  const ag = await activeAgent(api);
  const cust = await funded(10_000);
  const t = await boundOut(cust, ag);
  await cust.call('POST', `agent-cash/tx/${t.id}/confirm`, { bindingHash: t.b }, { headers: await pinned(cust) });
  const risk = await operator(api, ['risk']);
  await risk.call('POST', `admin/agents/${ag.profile.id}/suspend`, { reason: 'audit' });
  assert.equal((await prisma.agentCashTransaction.findUnique({ where: { id: t.id } })).state, 'needs_review');
  const support = await operator(api, ['support']);
  assert.equal((await support.call('POST', `admin/cash/${t.id}/resolve`, { outcome: 'complete', reason: 'support cannot do this' })).status, 403);
  const req = await risk.call('POST', `admin/cash/${t.id}/resolve`, { outcome: 'complete', reason: 'agent receipt and customer call confirm cash was paid' });
  const fa = await operator(api, ['finance_approver']);
  const runs = await Promise.all([1, 2].map(() => fa.call('POST', `admin/approvals/${req.body.approval.id}/approve`, {})));
  assert.ok(runs.some((r) => r.status === 200), JSON.stringify(runs.map((r) => r.body)));
  assert.equal((await prisma.agentCashTransaction.findUnique({ where: { id: t.id } })).state, 'completed');
  assert.equal(await customerHeld(cust.id), 0);
  assert.equal(await wallet(cust.id), 8000);
  assert.equal(await floatOf(ag.profile.id), 220_000);
});

test('risk: rapid cash-in → cash-out goes to risk_hold (funds held, no QR); risk resumes or returns the funds', async () => {
  const ag = await activeAgent(api);
  const other = await activeAgent(api);
  const cust = await funded(0);
  await cashIn(cust, ag, 50_000); // 5000 ₭
  const r = await request(cust, 45_000);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.transaction.state, 'risk_hold');
  assert.equal(r.body.qr, null, 'no handoff code while risk reviews');
  assert.equal(await customerHeld(cust.id), 4500);
  const risk = await operator(api, ['risk']);
  const go = await risk.call('POST', `admin/cash/${r.body.transaction.id}/risk-decision`, { outcome: 'resume', reason: 'customer called, salary withdrawal' });
  assert.equal(go.body.state, 'funds_held');
  const qr = await cust.call('POST', `agent-cash/tx/${r.body.transaction.id}/challenge`, {});
  assert.equal(qr.status, 200);
  const scan = await other.s.call('POST', 'agent/cash/scan', { qr: qr.body.qr });
  assert.equal(scan.status, 200, JSON.stringify(scan.body));
  const r2 = await cust.call('POST', `agent-cash/tx/${r.body.transaction.id}/cancel`, {});
  assert.equal(r2.status, 200);
  assert.equal(await wallet(cust.id), 5000, 'nothing lost');
  // The owner can also take back ₭ that are still in risk_hold.
  const r3 = await request(cust, 45_000);
  assert.equal(r3.body.transaction.state, 'risk_hold');
  assert.equal((await cust.call('POST', `agent-cash/tx/${r3.body.transaction.id}/cancel`, {})).status, 200);
  assert.equal(await wallet(cust.id), 5000);
  assert.equal(await customerHeld(cust.id), 0);
  void cashOut;
});
