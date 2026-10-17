/**
 * Phase 9 (merchant pay) + Phase 11 (agents) — real HTTP, NODE_ENV=production.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

import { createUserWithWallet, createVerifiedDevice, establishedSessionToken, fundedRewardsFor, fundUser, prisma, resetReserveToWallets } from '../helpers/db.js';
import { freshIp, startApiServer } from '../helpers/http-harness.js';
import { customer as j3customer, signedIn as j3signedIn } from '../j3/helpers.js';
import { activeAgent, cashIn, cashOut, idem, pinned } from '../j6/helpers.js';
import { reconcileKoriReserve } from '../../lib/kori-reserve.js';

const ACCESS_SECRET = 'http-test-access-secret-0123456789';
let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });

async function actor(koriBalance = 0, tier = 2) {
  const user = await createUserWithWallet({ koriBalance, tier });
  const device = await createVerifiedDevice(user.id);
  return { user, id: user.id, handle: user.handle, device, token: await establishedSessionToken(user.id, device, ACCESS_SECRET), ip: freshIp() };
}
const as = (a, headers = {}) => ({ token: a.token, device: a.device, ip: a.ip, headers: { 'x-vercel-ip-country': 'SN', ...headers } });
const bal = async (a) => (await prisma.wallet.findUnique({ where: { userId: a.id } })).koriBalance;
const call = (m, p, a, opts = {}) => api.client(m, p, { ...as(a, opts.headers), body: opts.body });

async function merchant() {
  const owner = await actor();
  const r = await call('POST', 'businesses', owner, { body: { name: `Boutique ${crypto.randomBytes(3).toString('hex')}`, type: 'merchant' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { owner, id: r.body.id };
}

test('merchant pay: debit/credit, both histories, forged merchant, malformed amounts', async () => {
  const { owner, id } = await merchant();
  const payer = await actor(1000);
  const p = await call('POST', `merchants/${id}/pay`, payer, { body: { amount: 250 } });
  assert.equal(p.status, 201);
  // Only rewards paid from the funded incentive budget may top this up.
  const reward = await fundedRewardsFor(payer.id);
  assert.equal(await bal(payer), 750 + reward);
  // J5: settles to the BUSINESS wallet (personal and business money stay distinct).
  assert.equal(await bal(owner), 0);
  assert.equal(Number((await prisma.ledgerAccount.findUnique({ where: { code: `business:${id}:wallet` } })).balance), 250);
  assert.ok((await call('GET', 'transactions', payer)).body.some((t) => t.reference === p.body.reference));
  assert.equal((await call('POST', 'merchants/nope/pay', payer, { body: { amount: 10 } })).status, 404);
  for (const amount of [0, -1, 1.5, '10']) assert.equal((await call('POST', `merchants/${id}/pay`, payer, { body: { amount } })).status, 400);
  assert.equal(await bal(payer), 750 + reward);
});

test('merchant pay: concurrent overspend → one succeeds; duplicate key → one debit', async () => {
  const { id } = await merchant();
  const a = await actor(500);
  const race = await Promise.all([1, 2].map(() => call('POST', `merchants/${id}/pay`, a, { body: { amount: 400 } })));
  assert.deepEqual(race.map((r) => r.status).sort(), [201, 400]);
  const b = await actor(500);
  const key = `mp-${crypto.randomBytes(5).toString('hex')}`;
  await Promise.all([1, 2, 3].map(() => call('POST', `merchants/${id}/pay`, b, { headers: { 'idempotency-key': key }, body: { amount: 100 } })));
  assert.equal(await bal(b), 400);
});

test('merchant pay: receipt cannot be forged into a conversation the payer and merchant are not both in', async () => {
  const { id } = await merchant();
  const payer = await actor(100);
  const stranger = await actor();
  const thread = await prisma.mboloThread.create({ data: { creatorId: stranger.id, name: 'private', type: 'direct', members: { create: [{ userId: stranger.id }] } } });
  const r = await call('POST', `merchants/${id}/pay`, payer, { body: { amount: 10, threadId: thread.id } });
  assert.equal(r.status, 201);
  assert.equal(await prisma.mboloMessage.count({ where: { threadId: thread.id } }), 0);
});

test('merchant cannot refund or reverse a customer payment', async () => {
  const { owner, id } = await merchant();
  const payer = await actor(100);
  const p = await call('POST', `merchants/${id}/pay`, payer, { body: { amount: 50 } });
  assert.equal((await call('POST', `transfers/${p.body.reference}/undo`, owner)).status, 403);
  assert.ok([401, 403].includes((await call('POST', 'admin/refunds', owner, { body: { recipientUserId: payer.id, amount: 50, reason: 'x' } })).status));
});


test('agent role cannot be self-assigned; non-agents cannot use agent endpoints', async () => {
  const u = await actor();
  // J3: agent is an application role — refused with an explicit code, nothing granted.
  const self = await call('POST', 'roles/agent', u);
  assert.equal(self.status, 403);
  assert.equal(self.body.code, 'role_requires_onboarding');
  assert.equal(await prisma.accountRole.count({ where: { userId: u.id, role: 'agent' } }), 0);
  assert.equal((await call('POST', 'agent/cash/scan', u, { body: { qr: 'jokko://cash/AAAAAAAAAAAAAAAAAAAAAAAA' } })).status, 403);
  // J6: the legacy bearer-QR routes are retired.
  assert.equal((await call('POST', 'withdrawals/agent', u, { body: { amount: 20_000 } })).status, 410);
});

// J6: agent cash moved to the secure handoff (customer confirms / authorizes in-app,
// agent completes with PIN). Full matrices: tests/j6/cash-in.test.js, cash-out.test.js.
const j6person = async (tier = 2, kori = 0) => {
  const c = await j3customer({ tier });
  if (kori) await fundUser(c.id, kori);
  return j3signedIn(api, c);
};

test('agent deposit: completed exactly once under concurrency; agent sees no phone / id', async () => {
  const ag = await activeAgent(api);
  const cust = await j6person();
  const c = await cust.call('POST', 'agent-cash/in', { amountXof: 20_000 }, idem());
  const scan = await ag.s.call('POST', 'agent/cash/scan', { qr: c.body.qr });
  const text = JSON.stringify(scan.body);
  assert.ok(!text.includes(cust.phone) && !text.includes(cust.id), 'no full phone / internal id for the agent');
  await cust.call('POST', `agent-cash/tx/${c.body.transaction.id}/confirm`, { bindingHash: scan.body.transaction.bindingHash });
  const headers = await pinned(ag.s);
  const rs = await Promise.all([1, 2, 3].map(() => ag.s.call('POST', `agent/cash/${c.body.transaction.id}/complete`, { bindingHash: scan.body.transaction.bindingHash }, { headers })));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(await bal(cust), 2000);
  assert.equal((await prisma.agentProfile.findUnique({ where: { id: ag.profile.id } })).floatBalance, 180_000);
  assert.equal((await ag.s.call('GET', `agent-cash/tx/${c.body.transaction.id}`)).body.transaction.state, 'completed');
});

test('agent deposit respects KYC tier balance caps (tier 1: 5 000 ₭)', async () => {
  const cust = await j6person(1);
  const r = await cust.call('POST', 'agent-cash/in', { amountXof: 100_000 }, idem());
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'tier_balance_cap');
  assert.equal(await bal(cust), 0);
});

test('agent withdraw: funds are HELD at request — a second withdrawal on the same ₭ is refused up front (was a 500 at confirmation)', async () => {
  const ag = await activeAgent(api, { floatXof: 100_000 });
  const cust = await j6person(2, 3000);
  const h = await pinned(cust);
  const w1 = await cust.call('POST', 'agent-cash/out', { amountXof: 20_000 }, { headers: { ...idem().headers, ...h } });
  const w2 = await cust.call('POST', 'agent-cash/out', { amountXof: 20_000 }, { headers: { ...idem().headers, ...h } });
  assert.equal(w1.status, 201, JSON.stringify(w1.body));
  assert.equal(w2.status, 400);
  assert.equal(w2.body.code, 'insufficient_funds');
  assert.equal(await bal(cust), 1000);
  assert.equal((await prisma.agentProfile.findUnique({ where: { id: ag.profile.id } })).floatBalance, 100_000);
});

test('agent withdraw: tier gate, once-only completion, reserve stays reconciled, recovery hold', async () => {
  const ag = await activeAgent(api, { floatXof: 100_000 });
  const t1 = await j6person(1, 3000);
  assert.equal((await t1.call('POST', 'agent-cash/out', { amountXof: 20_000 }, { headers: { ...idem().headers, ...(await pinned(t1)) } })).status, 403);
  const cust = await j6person(2, 5000);
  await resetReserveToWallets();
  const done = await cashOut(cust, ag, 20_000);
  const again = await ag.s.call('POST', `agent/cash/${done.transaction.id}/complete`, { bindingHash: 'x'.repeat(64) }, { headers: await pinned(ag.s) });
  assert.equal(again.body.transaction.state, 'completed');
  assert.equal(await bal(cust), 3000);
  const rec = await reconcileKoriReserve(prisma);
  assert.equal(rec.ok, true, JSON.stringify(rec));
  const recovered = await j6person(2, 5000);
  await prisma.user.update({ where: { id: recovered.id }, data: { accountRecoveredAt: new Date() } });
  const held = await recovered.call('POST', 'agent-cash/out', { amountXof: 10_000 }, idem());
  // J3: the central cash-out guard refuses before any money logic runs.
  assert.equal(held.status, 423);
  assert.equal(held.body.code, 'cash_out_hold');
  assert.equal(held.body.category, 'security_change');
  void cashIn;
});
