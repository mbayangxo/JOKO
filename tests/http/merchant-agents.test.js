/**
 * Phase 9 (merchant pay) + Phase 11 (agents) — real HTTP, NODE_ENV=production.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

import { createUserWithWallet, createVerifiedDevice, establishedSessionToken, fundedRewardsFor, prisma, resetReserveToWallets } from '../helpers/db.js';
import { freshIp, startApiServer } from '../helpers/http-harness.js';
import { createAgentProfile } from '../../lib/agent-service.js';
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

async function agent(float = 200_000) {
  const a = await actor();
  const profile = await createAgentProfile({ userId: a.id, displayName: `Agent ${crypto.randomBytes(3).toString('hex')}`, initialFloat: float, floatLimit: 500_000 });
  return { ...a, profile };
}

test('agent role cannot be self-assigned; non-agents cannot use agent endpoints', async () => {
  const u = await actor();
  // J3: agent is an application role — refused with an explicit code, nothing granted.
  const self = await call('POST', 'roles/agent', u);
  assert.equal(self.status, 403);
  assert.equal(self.body.code, 'role_requires_onboarding');
  assert.equal(await prisma.accountRole.count({ where: { userId: u.id, role: 'agent' } }), 0);
  assert.equal((await call('POST', 'agent/deposits/scan', u, { body: { token: 'xxxxxxxxxxxx' } })).status, 403);
});

test('agent deposit: confirmed exactly once under concurrency; agent sees masked phone only', async () => {
  const ag = await agent();
  const cust = await actor(0, 2);
  const dep = await call('POST', 'deposits/agent', cust, { body: { amount: 20_000 } });
  assert.equal(dep.status, 201);
  const row = await prisma.agentDeposit.findUnique({ where: { reference: dep.body.reference } });
  const scan = await call('POST', 'agent/deposits/scan', ag, { body: { token: row.token } });
  assert.equal(scan.status, 200);
  const text = JSON.stringify(scan.body);
  assert.ok(!text.includes(cust.user.phone) && !text.includes(cust.id), 'no full phone / internal id for the agent');
  const rs = await Promise.all([1, 2, 3].map(() => call('POST', `agent/deposits/${row.id}/confirm`, ag)));
  assert.equal(rs.filter((r) => r.status === 201 || r.status === 200).length, 1);
  assert.equal(await bal(cust), 2000);
  assert.equal((await prisma.agentProfile.findUnique({ where: { id: ag.profile.id } })).floatBalance, 180_000);
  assert.equal((await call('GET', `deposits/agent/${dep.body.reference}`, ag)).status, 404, 'agent cannot read the customer session');
});

test('agent deposit respects KYC tier balance caps (tier 1: 5 000 ₭)', async () => {
  const ag = await agent();
  const cust = await actor(0, 1);
  const dep = await call('POST', 'deposits/agent', cust, { body: { amount: 100_000 } });
  const row = await prisma.agentDeposit.findUnique({ where: { reference: dep.body.reference } });
  const r = await call('POST', `agent/deposits/${row.id}/confirm`, ag);
  assert.ok(r.status >= 400, String(r.status));
  assert.equal(await bal(cust), 0);
  assert.equal((await prisma.agentProfile.findUnique({ where: { id: ag.profile.id } })).floatBalance, 200_000);
});

test('agent withdraw: the customer no longer has the funds at confirmation → clean 4xx, nothing moves (was HTTP 500)', async () => {
  const ag = await agent(100_000);
  const cust = await actor(3000, 2);
  const w1 = await call('POST', 'withdrawals/agent', cust, { body: { amount: 20_000 } });
  const w2 = await call('POST', 'withdrawals/agent', cust, { body: { amount: 20_000 } });
  assert.equal(w1.status, 201, JSON.stringify(w1.body));
  assert.equal(w2.status, 201, JSON.stringify(w2.body));
  const [r1, r2] = await Promise.all([w1, w2].map((w) => prisma.agentWithdrawal.findUnique({ where: { reference: w.body.reference } })));
  assert.ok((await call('POST', `agent/withdrawals/${r1.id}/confirm`, ag)).status < 300);
  const floatBefore = (await prisma.agentProfile.findUnique({ where: { id: ag.profile.id } })).floatBalance;
  const second = await call('POST', `agent/withdrawals/${r2.id}/confirm`, ag);
  assert.equal(second.status, 400, JSON.stringify(second.body));
  assert.equal(second.body.code, 'customer_insufficient_funds');
  assert.equal(await bal(cust), 1000);
  assert.equal((await prisma.agentProfile.findUnique({ where: { id: ag.profile.id } })).floatBalance, floatBefore);
  assert.equal((await prisma.agentWithdrawal.findUnique({ where: { id: r2.id } })).status, 'pending');
});

test('agent withdraw: tier gate, once-only confirm, reserve stays reconciled, recovery hold', async () => {
  const ag = await agent(100_000);
  const t1 = await actor(3000, 1);
  assert.equal((await call('POST', 'withdrawals/agent', t1, { body: { amount: 20_000 } })).status, 403);

  const cust = await actor(5000, 2);
  await resetReserveToWallets();
  const w = await call('POST', 'withdrawals/agent', cust, { body: { amount: 20_000 } });
  assert.equal(w.status, 201);
  const row = await prisma.agentWithdrawal.findUnique({ where: { reference: w.body.reference } });
  const rs = await Promise.all([1, 2].map(() => call('POST', `agent/withdrawals/${row.id}/confirm`, ag)));
  assert.equal(rs.filter((r) => r.status < 300).length, 1);
  assert.equal(await bal(cust), 3000);
  const rec = await reconcileKoriReserve(prisma);
  assert.equal(rec.ok, true, JSON.stringify(rec));

  const recovered = await actor(5000, 2);
  await prisma.user.update({ where: { id: recovered.id }, data: { accountRecoveredAt: new Date() } });
  const held = await call('POST', 'withdrawals/agent', recovered, { body: { amount: 10_000 } });
  // J3: the central cash-out guard refuses before any money logic runs.
  assert.equal(held.status, 423);
  assert.equal(held.body.code, 'cash_out_hold');
  assert.equal(held.body.category, 'security_change');
});
