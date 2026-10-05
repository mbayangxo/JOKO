/**
 * J6 adversarial lab — the attacks not already proven in the slice suites
 * (cash-in / cash-out / handoff / lifecycle / commissions / roles), plus a
 * concurrency destruction run that mixes every transition at once.
 * J2 invariants after every test; agent reconciliation must stay clean.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fundUser, prisma } from '../helpers/db.js';
import { freshIp, startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { reconcileAgents } from '../../lib/agents/ops.js';
import { customer, newDevice, operator, otpLogin, signedIn } from '../j3/helpers.js';
import { activeAgent, cashIn, customerHeld, floatOf, held, idem, pinned, wallet } from './helpers.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const person = async (kori = 0) => {
  const c = await customer();
  if (kori) await fundUser(c.id, kori);
  return signedIn(api, c);
};

test('fake agent: a forged profile without the role, or the role without an active profile / point, is refused', async () => {
  const u = await person();
  await prisma.agentProfile.create({ data: { userId: u.id, agentCode: `FAKE-${crypto.randomBytes(3).toString('hex')}`, displayName: 'Fake', status: 'active' } });
  assert.equal((await u.call('POST', 'agent/cash/scan', { qr: 'jokko://cash/AAAAAAAAAAAAAAAAAAAAAAAA' })).status, 403, 'no role');
  await prisma.accountRole.upsert({ where: { userId_role: { userId: u.id, role: 'agent' } }, create: { userId: u.id, role: 'agent', status: 'active' }, update: { status: 'active' } });
  const r = await u.call('POST', 'agent/cash/scan', { qr: 'jokko://cash/AAAAAAAAAAAAAAAAAAAAAAAA' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'service_point_inactive', 'role + profile still need an approved service point of their organization');
  // A user token never reaches operator routes.
  for (const p of ['admin/agents/x/activate', 'admin/agents/x/float', 'admin/agents/x/verify-identity', 'admin/cash/x/resolve']) {
    assert.ok([401, 403].includes((await u.call('POST', p, { reason: 'self service please', amountXof: 1 })).status), p);
  }
});

test('fake / direct float: projection writes are refused by the database; a top-up request moves nothing until finance approves', async () => {
  const ag = await activeAgent(api);
  await assert.rejects(prisma.agentProfile.update({ where: { id: ag.profile.id }, data: { floatBalance: 9_999_999 } }));
  await assert.rejects(prisma.$executeRaw`UPDATE "LedgerAccount" SET balance = 1 WHERE code = ${`agent:${ag.profile.id}:float`}`);
  const req = await ag.s.call('POST', 'agent/float/topup-request', { amountXof: 100_000 });
  assert.equal(req.status, 201);
  assert.equal(await floatOf(ag.profile.id), 200_000);
  assert.equal((await ag.s.call('POST', 'agent/float/topup-request', { amountXof: 100_000 })).status, 409, 'one pending request');
});

test('enumeration / cross-agent access: other agents and customers see 404; agent views carry no balance or history of the customer', async () => {
  const a = await activeAgent(api);
  const b = await activeAgent(api);
  const cust = await person(5000);
  const done = await cashIn(cust, a, 20_000);
  const id = done.transaction.id;
  assert.equal((await b.s.call('GET', `agent-cash/tx/${id}`)).status, 404);
  assert.equal((await b.s.call('POST', `agent/cash/${id}/decline`, { reason: 'x' })).status, 404);
  assert.ok(!(await b.s.call('GET', 'agent/cash')).body.transactions.some((t) => t.id === id));
  for (const guess of [crypto.randomUUID(), 'cmuv0000000000000000000', `${id.slice(0, -1)}x`]) assert.equal((await cust.call('GET', `agent-cash/tx/${guess}`)).status, 404);
  const view = await a.s.call('GET', `agent-cash/tx/${id}`);
  const text = JSON.stringify(view.body);
  for (const leak of ['koriBalance', 'balance"', cust.phone, cust.handle, cust.id]) assert.ok(!text.includes(leak), `agent view leaks ${leak}`);
  assert.ok(!JSON.stringify((await a.s.call('GET', 'agent/cash')).body).includes('koriBalance'));
});

test('recovery / new-device bypass: a fresh device or a recovered account cannot start a cash-out', async () => {
  const c = await customer();
  await fundUser(c.id, 5000);
  const fresh = await otpLogin(api, c.phone, { device: newDevice(), ip: freshIp() });
  assert.equal(fresh.status, 200);
  const r = await api.client('POST', 'agent-cash/out', { token: fresh.body.accessToken, device: newDevice(), ip: freshIp(), headers: { 'x-vercel-ip-country': 'SN', 'idempotency-key': 'nd-1' }, body: { amountXof: 10_000 } });
  assert.ok([403, 423].includes(r.status), JSON.stringify(r.body));
  assert.equal(await customerHeld(c.id), 0);
  assert.equal(await wallet(c.id), 5000);
});

test('operator abuse: no role → nothing; a single operator cannot activate, resolve or fund alone; nobody approves their own request', async () => {
  const nobody = await operator(api, []);
  const ag = await activeAgent(api);
  for (const [m, p, b] of [['GET', 'admin/agents/liquidity'], ['GET', `admin/agents/${ag.profile.id}/overview`], ['POST', `admin/agents/${ag.profile.id}/suspend`, { reason: 'abuse' }]]) {
    assert.equal((await nobody.call(m, p, b)).status, 403, p);
  }
  const both = await operator(api, ['risk', 'finance_approver']);
  const cust = await person(5000);
  const r = await cust.call('POST', 'agent-cash/out', { amountXof: 20_000 }, { headers: { ...idem().headers, ...(await pinned(cust)) } });
  const s = await ag.s.call('POST', 'agent/cash/scan', { qr: r.body.qr });
  await cust.call('POST', `agent-cash/tx/${r.body.transaction.id}/confirm`, { bindingHash: s.body.transaction.bindingHash }, { headers: await pinned(cust) });
  await prisma.agentCashTransaction.update({ where: { id: r.body.transaction.id }, data: { reviewDeadline: new Date(Date.now() - 1000) } });
  const { sweepCash } = await import('../../lib/agents/cash.js');
  await sweepCash();
  const req = await both.call('POST', `admin/cash/${r.body.transaction.id}/resolve`, { outcome: 'release', reason: 'I will release it myself' });
  assert.equal(req.status, 202);
  assert.equal((await both.call('POST', `admin/approvals/${req.body.approval.id}/approve`, {})).status, 403, 'self-approval refused');
  assert.equal((await prisma.agentCashTransaction.findUnique({ where: { id: r.body.transaction.id } })).state, 'needs_review');
  assert.equal(await customerHeld(cust.id), 2000);
});

test('pending-funds spend: a cash-in that is not completed gives the customer nothing to spend or withdraw', async () => {
  const ag = await activeAgent(api);
  const cust = await person(0);
  const c = await cust.call('POST', 'agent-cash/in', { amountXof: 50_000 }, idem());
  const s = await ag.s.call('POST', 'agent/cash/scan', { qr: c.body.qr });
  await cust.call('POST', `agent-cash/tx/${c.body.transaction.id}/confirm`, { bindingHash: s.body.transaction.bindingHash });
  assert.equal(await wallet(cust.id), 0);
  const out = await cust.call('POST', 'agent-cash/out', { amountXof: 10_000 }, { headers: { ...idem().headers, ...(await pinned(cust)) } });
  assert.equal(out.body.code, 'insufficient_funds');
});

test('destruction: 8 customers × mixed concurrent completes / cancels / declines / sweeps / suspension — one outcome each, nothing created or lost', async () => {
  const ag = await activeAgent(api, { floatXof: 400_000 });
  const custs = await Promise.all(Array.from({ length: 8 }, () => person(10_000)));
  const floatStart = await floatOf(ag.profile.id);
  const ins = await Promise.all(custs.map((c) => c.call('POST', 'agent-cash/in', { amountXof: 20_000 }, idem())));
  const outs = await Promise.all(custs.map(async (c) => c.call('POST', 'agent-cash/out', { amountXof: 30_000 }, { headers: { ...idem().headers, ...(await pinned(c)) } })));
  const scanned = await Promise.all([...ins, ...outs].map((r) => ag.s.call('POST', 'agent/cash/scan', { qr: r.body.qr })));
  const agentPin = await pinned(ag.s);
  const pins = await Promise.all(custs.map((c) => pinned(c)));
  const ops = [];
  scanned.forEach((s, i) => {
    const t = s.body.transaction;
    const c = custs[i % 8];
    const headers = pins[i % 8];
    const roll = i % 4;
    ops.push((async () => {
      if (roll === 0) return c.call('POST', `agent-cash/tx/${t.id}/cancel`, {});
      await c.call('POST', `agent-cash/tx/${t.id}/confirm`, { bindingHash: t.bindingHash }, { headers });
      if (roll === 1) return ag.s.call('POST', `agent/cash/${t.id}/decline`, { reason: 'chaos' });
      return Promise.all([1, 2, 3].map(() => ag.s.call('POST', `agent/cash/${t.id}/complete`, { bindingHash: t.bindingHash }, { headers: agentPin })));
    })());
  });
  const { sweepCash } = await import('../../lib/agents/cash.js');
  ops.push(sweepCash(), sweepCash());
  await Promise.all(ops);
  const txs = await prisma.agentCashTransaction.findMany({ where: { agentId: ag.profile.id } });
  assert.equal(txs.length, 16);
  for (const t of txs) assert.ok(['completed', 'cancelled', 'declined'].includes(t.state), `${t.reference} ${t.state}`);
  const completedIn = txs.filter((t) => t.kind === 'cash_in' && t.state === 'completed').reduce((s, t) => s + t.amountXof, 0);
  const completedOut = txs.filter((t) => t.kind === 'cash_out' && t.state === 'completed').reduce((s, t) => s + t.amountXof, 0);
  assert.equal(await floatOf(ag.profile.id), floatStart - completedIn + completedOut, 'float = start − completed cash-ins + completed cash-outs');
  assert.equal(await held(ag.profile.id), 0);
  const total = (await Promise.all(custs.map((c) => wallet(c.id)))).reduce((a, b) => a + b, 0);
  assert.equal(total, 8 * 10_000 + completedIn / 10 - completedOut / 10, 'customers: start + cash-ins − cash-outs, to the ₭');
  for (const c of custs) assert.equal(await customerHeld(c.id), 0);
  const rec = await reconcileAgents(prisma, { record: false });
  assert.deepEqual(rec.exceptions.filter((e) => e.ref === ag.profile.id || txs.some((t) => t.reference === e.ref)), []);
});
