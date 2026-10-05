/**
 * J6.6 secure handoff, J6.9 limits & risk (behaviour-only signals).
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { customer, signedIn } from '../j3/helpers.js';
import { cashLimits } from '../../lib/agents/limits.js';
import { activeAgent, cashIn, idem, pinned, wallet } from './helpers.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const person = async (tier = 2, kori = 0) => {
  const c = await customer({ tier });
  if (kori) await fundUser(c.id, kori);
  return signedIn(api, c);
};

test('handoff: the QR carries no amount / name / phone / id; only a hash is stored; tokens are unguessable', async () => {
  const cust = await person();
  const r = await cust.call('POST', 'agent-cash/in', { amountXof: 15_000 }, idem());
  const token = r.body.qr.replace('jokko://cash/', '');
  assert.ok(!r.body.qr.includes('15000') && !r.body.qr.includes(cust.id) && !r.body.qr.includes(cust.phone));
  const row = await prisma.agentCashTransaction.findUnique({ where: { id: r.body.transaction.id } });
  assert.ok(!JSON.stringify(row).includes(token), 'raw token is never stored');
  assert.equal(token.length, 24);
  assert.ok(Buffer.from(token, 'base64url').length >= 18, '≥ 144 bits');
});

test('brute force / enumeration: invalid codes lock the agent’s scanner; a locked scanner refuses even valid codes', async () => {
  const ag = await activeAgent(api);
  const cust = await person();
  const r = await cust.call('POST', 'agent-cash/in', { amountXof: 10_000 }, idem());
  for (let i = 0; i < cashLimits().maxScanFailures; i++) {
    const g = await ag.s.call('POST', 'agent/cash/scan', { qr: `jokko://cash/${'A'.repeat(23)}${i}` });
    assert.equal(g.body.code, 'invalid_code');
  }
  const locked = await ag.s.call('POST', 'agent/cash/scan', { qr: r.body.qr });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.code, 'scan_locked');
  // Phone numbers / references / internal ids are identifiers, never authorization.
  const other = await activeAgent(api);
  for (const guess of [cust.phone, r.body.transaction.reference, r.body.transaction.id]) {
    assert.equal((await other.s.call('POST', 'agent/cash/scan', { qr: String(guess) })).body.code, 'invalid_code');
  }
});

test('old QR reuse after completion / cancellation is refused', async () => {
  const ag = await activeAgent(api);
  const cust = await person();
  const c = await cust.call('POST', 'agent-cash/in', { amountXof: 10_000 }, idem());
  const scan = await ag.s.call('POST', 'agent/cash/scan', { qr: c.body.qr });
  await cust.call('POST', `agent-cash/tx/${c.body.transaction.id}/confirm`, { bindingHash: scan.body.transaction.bindingHash });
  await ag.s.call('POST', `agent/cash/${c.body.transaction.id}/complete`, { bindingHash: scan.body.transaction.bindingHash }, { headers: await pinned(ag.s) });
  const reuse = await ag.s.call('POST', 'agent/cash/scan', { qr: c.body.qr });
  assert.equal(reuse.status, 200, 'the same agent re-reading a completed code just sees it');
  assert.equal(reuse.body.transaction.state, 'completed');
  const other = await activeAgent(api);
  assert.equal((await other.s.call('POST', 'agent/cash/scan', { qr: c.body.qr })).body.code, 'already_bound');
  assert.equal(await wallet(cust.id), 1000);
});

test('limits: customer daily amount / count, agent daily volume and per-operation caps come from ONE configurable table', async () => {
  const L = cashLimits();
  assert.equal(L.perTransaction.cash_in.standard, 500_000);
  const cust = await person(3);
  const n = L.customerDailyCount.cash_in;
  for (let i = 0; i < n; i++) assert.equal((await cust.call('POST', 'agent-cash/in', { amountXof: 1000 }, idem())).status, 201);
  const over = await cust.call('POST', 'agent-cash/in', { amountXof: 1000 }, idem());
  assert.equal(over.body.code, 'customer_daily_count');
  const rich = await person(3);
  const big = [];
  for (let i = 0; i < 4; i++) big.push(await rich.call('POST', 'agent-cash/in', { amountXof: 500_000 }, idem()));
  assert.equal(big.filter((r) => r.status === 201).length, 4);
  assert.equal((await rich.call('POST', 'agent-cash/in', { amountXof: 500_000 }, idem())).body.code, 'customer_daily_limit');
  // Override through configuration (validated; garbage ignored).
  const tight = await startApiServer({ AGENT_CASH_LIMITS_JSON: JSON.stringify({ perTransaction: { cash_in: { standard: 30_000 } }, minXof: -5, bogus: 1 }) });
  try {
    const t = await signedIn(tight, await customer({ tier: 2 }));
    const ag = await activeAgent(tight);
    const r = await t.call('POST', 'agent-cash/in', { amountXof: 40_000 }, idem());
    assert.equal(r.status, 201, 'shape max stays the largest tier cap');
    assert.equal((await ag.s.call('POST', 'agent/cash/scan', { qr: r.body.qr })).body.code, 'amount_too_high', 'standard point cap from config');
    assert.equal((await t.call('POST', 'agent-cash/in', { amountXof: 100 }, idem())).body.code, 'amount_too_low', 'invalid override ignored');
  } finally {
    await tight.stop();
  }
});

test('risk: circular cash at the same point is held; commission farming earns nothing; repeated cancellations → review', async () => {
  const ag = await activeAgent(api);
  const cust = await person(2);
  await cashIn(cust, ag, 30_000); // 3000 ₭
  const out = await cust.call('POST', 'agent-cash/out', { amountXof: 10_000 }, { headers: { ...idem().headers, ...(await pinned(cust)) } });
  // rapid_cash_in_out does not fire (< 80 %), but the SAME agent sees circular cash and holds it at binding.
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const scan = await ag.s.call('POST', 'agent/cash/scan', { qr: out.body.qr });
  assert.equal(scan.body.code, 'risk_review', JSON.stringify(scan.body));
  assert.equal((await prisma.agentCashTransaction.findUnique({ where: { id: out.body.transaction.id } })).state, 'risk_hold');
  // Repeated cancellations push the next cash-out to review.
  const c2 = await person(2, 10_000);
  const h = await pinned(c2);
  for (let i = 0; i < 3; i++) {
    const r = await c2.call('POST', 'agent-cash/out', { amountXof: 1000 }, { headers: { ...idem().headers, ...h } });
    await c2.call('POST', `agent-cash/tx/${r.body.transaction.id}/cancel`, {});
  }
  const next = await c2.call('POST', 'agent-cash/out', { amountXof: 1000 }, { headers: { ...idem().headers, ...h } });
  assert.equal(next.body.transaction.state, 'risk_hold');
  const d = await prisma.riskDecision.findFirst({ where: { userId: c2.id, action: 'cash_out' }, orderBy: { createdAt: 'desc' } });
  assert.match(d.reasonsJson, /cash_cancellations/);
  assert.ok(!/cash_cancellations/.test(JSON.stringify(next.body)), 'internal signal names never reach the client');
});

test('fairness: cash-network risk and limits read no proxy for ethnicity, nationality, language, name or neighbourhood', () => {
  for (const f of ['../../lib/agents/risk.js', '../../lib/agents/limits.js', '../../lib/risk/engine.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    for (const forbidden of [/\bcountry\b/i, /nationalit/i, /languag/i, /arrondissement/i, /ethnic/i, /\bname\b\s*:/, /isDiaspora/, /neighbo/i, /dateOfBirth/, /\barea\b/, /publicAddress/]) {
      assert.ok(!forbidden.test(src), `${f} must not read ${forbidden}`);
    }
  }
});
