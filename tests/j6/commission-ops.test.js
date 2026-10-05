/**
 * J6.7 commissions (funded, never minted), J6.8 liquidity, J6.10
 * reconciliation (hard gate), J6.11 support/ops separation.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { customer, operator, signedIn } from '../j3/helpers.js';
import { ROUTE_POLICY } from '../../lib/authz/route-policy.js';
import { reconcileAgents } from '../../lib/agents/ops.js';
import { activeAgent, cashIn, idem, wallet } from './helpers.js';

let api;
let finOps;
let finApprover;
before(async () => {
  api = await startApiServer();
  finOps = await operator(api, ['finance_ops']);
  finApprover = await operator(api, ['finance_approver']);
});
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const acc = async (code) => Number((await prisma.ledgerAccount.findUnique({ where: { code } }))?.balance ?? 0);
const person = async () => signedIn(api, await customer());
async function approve(approval) {
  const r = await finApprover.call('POST', `admin/approvals/${approval.id}/approve`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function activeRule(purpose, body = {}) {
  const r = await finOps.call('POST', 'admin/agents/commission-rules', { purpose, bps: 50, flatKori: 5, minAmountXof: 5000, ...body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const a = await finOps.call('POST', `admin/agents/commission-rules/${r.body.rule.id}/activate`, { reason: 'launch rule approved by committee' });
  await approve(a.body.approval);
  return r.body.rule;
}

test('commissions: no rule → nothing; unfunded budget → recorded as unfunded, 0 minted; funded → paid from the budget only; customer gets the full amount', async () => {
  const ag = await activeAgent(api);
  const cust = await person();
  await prisma.agentCommissionRule.updateMany({ where: { status: 'active' }, data: { status: 'retired' } });
  const t0 = await cashIn(cust, ag, 20_000);
  assert.equal((await prisma.agentCommission.findUnique({ where: { txId: t0.transaction.id } })).ineligibleReason, 'no_active_rule');

  // Agents and support cannot touch rules.
  const support = await operator(api, ['support']);
  assert.equal((await support.call('POST', 'admin/agents/commission-rules', { purpose: 'cash_in', bps: 200 })).status, 403);
  assert.equal((await ag.s.call('POST', 'admin/agents/commission-rules', { purpose: 'cash_in', bps: 200 })).status, 401);
  const rule = await activeRule('cash_in');
  assert.equal((await prisma.agentCommissionRule.findUnique({ where: { id: rule.id } })).approvedBy, finApprover.id);

  const budgetBefore = await acc('platform:agent_commission_budget');
  const t1 = await cashIn(cust, ag, 20_000);
  const c1 = await prisma.agentCommission.findUnique({ where: { txId: t1.transaction.id } });
  if (budgetBefore < 15) {
    assert.equal(c1.status, 'unfunded');
    assert.equal(c1.amountKori, 0);
  }
  assert.equal(await wallet(cust.id), 4000, 'customer credited the full amount — commissions never come from the customer');

  const f = await finOps.call('POST', 'admin/agents/commission-budget/fund', { amountKori: 10_000, reason: 'Q4 commission budget from treasury' });
  assert.equal(f.status, 202);
  assert.equal((await finOps.call('POST', `admin/approvals/${f.body.approval.id}/approve`, {})).status, 403, 'maker cannot approve');
  await approve(f.body.approval);
  const funded = await acc('platform:agent_commission_budget');
  const t2 = await cashIn(cust, ag, 20_000);
  const c2 = await prisma.agentCommission.findUnique({ where: { txId: t2.transaction.id } });
  assert.equal(c2.status, 'accrued');
  assert.equal(c2.amountKori, 5 + Math.floor((2000 * 50) / 10_000));
  assert.equal(await acc('platform:agent_commission_budget'), funded - c2.amountKori);
  assert.equal(await acc(`agent:${ag.profile.id}:commission`), c2.amountKori);
});

test('commission farming / duplicate accrual: replayed completion accrues once; circular / repeated-pair activity earns nothing', async () => {
  await activeRule('cash_in');
  const f = await finOps.call('POST', 'admin/agents/commission-budget/fund', { amountKori: 5_000, reason: 'top-up of commission budget' });
  await approve(f.body.approval);
  const ag = await activeAgent(api);
  const cust = await person();
  const done = await cashIn(cust, ag, 20_000);
  const { pinned } = await import('./helpers.js');
  await Promise.all([1, 2, 3, 4].map(async () => ag.s.call('POST', `agent/cash/${done.transaction.id}/complete`, { bindingHash: 'x'.repeat(64) }, { headers: await pinned(ag.s) })));
  assert.equal(await prisma.agentCommission.count({ where: { txId: done.transaction.id } }), 1);
  assert.equal(await prisma.journalEntry.count({ where: { reference: `${done.transaction.reference}-COMM` } }), 1);
  // Same customer ≥ 5 times in 24 h at this agent → flagged → no commission.
  for (let i = 0; i < 5; i++) await cashIn(cust, ag, 6000);
  const last = await prisma.agentCashTransaction.findFirst({ where: { agentId: ag.profile.id }, orderBy: { createdAt: 'desc' } });
  const lc = await prisma.agentCommission.findUnique({ where: { txId: last.id } });
  assert.equal(lc.status, 'ineligible');
  assert.equal(lc.ineligibleReason, 'risk_flagged');
  // Totals reconcile to completed eligible transactions.
  const accrued = await prisma.agentCommission.aggregate({ where: { agentId: ag.profile.id, status: 'accrued' }, _sum: { amountKori: true } });
  assert.equal(await acc(`agent:${ag.profile.id}:commission`), accrued._sum.amountKori ?? 0);
});

test('settlement → the agent’s own wallet once (receipt); clawback only of unsettled commissions, maker-checker', async () => {
  await activeRule('cash_in');
  const f = await finOps.call('POST', 'admin/agents/commission-budget/fund', { amountKori: 5_000, reason: 'top-up of commission budget' });
  await approve(f.body.approval);
  const ag = await activeAgent(api);
  const c1 = await person();
  const c2 = await person();
  const t1 = await cashIn(c1, ag, 20_000);
  const before = await wallet(ag.id);
  const k = { headers: { 'idempotency-key': 'settle-1' } };
  const s1 = await ag.s.call('POST', 'agent/commissions/settle', {}, k);
  assert.equal(s1.status, 201, JSON.stringify(s1.body));
  const s2 = await ag.s.call('POST', 'agent/commissions/settle', {}, k);
  assert.equal(s2.body.receipt.reference, s1.body.receipt.reference);
  assert.equal(await wallet(ag.id), before + s1.body.receipt.amountKori);
  assert.equal((await ag.s.call('POST', 'agent/commissions/settle', {}, idem())).body.code, 'nothing_to_settle');
  const settled = await prisma.agentCommission.findUnique({ where: { txId: t1.transaction.id } });
  const risk = await operator(api, ['risk']);
  const cbSettled = await risk.call('POST', `admin/agents/commissions/${settled.id}/clawback`, { reason: 'farming suspected on this tx' });
  const r1 = await finApprover.call('POST', `admin/approvals/${cbSettled.body.approval.id}/approve`, {});
  assert.equal(r1.body.code, 'not_clawable', 'settled money is not taken back here');
  const t2 = await cashIn(c2, ag, 20_000);
  const open = await prisma.agentCommission.findUnique({ where: { txId: t2.transaction.id } });
  const budget0 = await acc('platform:agent_commission_budget');
  const cb = await risk.call('POST', `admin/agents/commissions/${open.id}/clawback`, { reason: 'customer complaint confirmed' });
  await approve(cb.body.approval);
  assert.equal((await prisma.agentCommission.findUnique({ where: { id: open.id } })).status, 'clawed_back');
  assert.equal(await acc('platform:agent_commission_budget'), budget0 + open.amountKori);
  assert.equal(await acc(`agent:${ag.profile.id}:commission`), 0);
});

test('liquidity: ledger float, pending, low-float, demand; physical cash is self-reported and never authoritative; rebalancing dormant', async () => {
  const ag = await activeAgent(api, { floatXof: 30_000 });
  const cust = await person();
  await ag.s.call('POST', 'agent/cash-report', { amountXof: 120_000, note: 'end of morning' });
  const c = await cust.call('POST', 'cash/in', { amountXof: 10_000 }, idem());
  await ag.s.call('POST', 'agent/cash/scan', { qr: c.body.qr });
  const support = await operator(api, ['support']);
  const v = await support.call('GET', 'admin/agents/liquidity');
  assert.equal(v.status, 200);
  const row = v.body.agents.find((a) => a.agentId === ag.profile.id);
  assert.equal(row.electronicFloat.availableXof, 20_000);
  assert.equal(row.electronicFloat.heldXof, 10_000);
  assert.equal(row.pending.cashIn.count, 1);
  assert.equal(row.lowFloat, true);
  assert.equal(row.physicalCash.source, 'self_reported');
  assert.equal(row.physicalCash.authoritative, false);
  assert.equal(v.body.rebalancing, 'ARCHITECTED-DORMANT');
  await assert.rejects(prisma.agentCashReport.updateMany({ where: { agentId: ag.profile.id }, data: { amountXof: 1 } }), 'reports are append-only');
});

test('reconciliation: clean network reconciles; a tampered state is an explicit exception; there is no "make it match" route', async () => {
  const ag = await activeAgent(api);
  const cust = await person();
  await cashIn(cust, ag, 20_000);
  const clean = await reconcileAgents(prisma, { record: false });
  const mine = clean.exceptions.filter((e) => e.ref === ag.profile.id || e.ref.startsWith('JC'));
  assert.deepEqual(mine, [], JSON.stringify(mine));
  // Tamper: mark a cancelled transaction completed directly in the DB (no posting).
  const c = await cust.call('POST', 'cash/in', { amountXof: 10_000 }, idem());
  await cust.call('POST', `cash/tx/${c.body.transaction.id}/cancel`, {});
  await prisma.$executeRaw`UPDATE "AgentCashTransaction" SET state = 'completed' WHERE id = ${c.body.transaction.id}`;
  const fin = await operator(api, ['finance_ops']);
  const run = await fin.call('POST', 'admin/agents/reconcile', {});
  assert.equal(run.status, 200);
  assert.ok(run.body.exceptions.some((e) => e.kind === 'agent_tx_posting' && /without completion posting/.test(e.detail)));
  assert.ok(await prisma.reconciliationException.findFirst({ where: { provider: 'agent_network', kind: 'agent_tx_posting', status: 'open' } }));
  const support = await operator(api, ['support']);
  assert.equal((await support.call('POST', 'admin/agents/reconcile', {})).status, 403);
  assert.equal((await support.call('GET', 'admin/agents/reconcile')).status, 200, 'read-only view is inspectable');
  await prisma.$executeRaw`UPDATE "AgentCashTransaction" SET state = 'cancelled' WHERE id = ${c.body.transaction.id}`;
  for (const key of Object.keys(ROUTE_POLICY)) assert.ok(!/set-balance|make-match|fix-balance|float\/set/i.test(key), key);
});

test('support inspects (overview, masked) but cannot move float, change status or resolve; finance cannot do identity actions', async () => {
  const ag = await activeAgent(api);
  const cust = await person();
  await cashIn(cust, ag, 20_000);
  const support = await operator(api, ['support']);
  const o = await support.call('GET', `admin/agents/${ag.profile.id}/overview`);
  assert.equal(o.status, 200);
  assert.equal(o.body.float.availableXof, 180_000);
  assert.ok(!JSON.stringify(o.body).includes(cust.phone), 'no customer phone in the overview');
  assert.ok(o.body.agent.lifecycle.length >= 4);
  for (const [m, p, b] of [
    ['POST', `admin/agents/${ag.profile.id}/float`, { amountXof: 1000 }],
    ['POST', `admin/agents/${ag.profile.id}/suspend`, { reason: 'nope' }],
    ['POST', `admin/agents/${ag.profile.id}/terminate`, { reason: 'nope nope nope' }],
    ['POST', `admin/cash/${o.body.transactions[0].id}/resolve`, { outcome: 'release', reason: 'support tries this' }],
    ['POST', 'admin/agents/commission-budget/fund', { amountKori: 1, reason: 'support tries this' }],
  ]) assert.equal((await support.call(m, p, b)).status, 403, `${m} ${p}`);
  assert.equal((await finOps.call('POST', `admin/agents/${ag.profile.id}/verify-identity`, {})).status, 403);
  assert.equal((await finOps.call('POST', `admin/agents/${ag.profile.id}/suspend`, { reason: 'finance' })).status, 403);
});
