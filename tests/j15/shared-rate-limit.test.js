/**
 * J15-D3 — partner rate limits are shared and atomic across FOUR API processes; money routes fail closed when
 * enforcement is unavailable (deterministic lab fault); lab fault hooks are inert outside the lab.
 */
import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';

const servers = [];
after(async () => { await Promise.all(servers.map((s) => s.stop())); await assertInvariants(prisma); await prisma.$disconnect(); });
const start = async (env) => { const s = await startApiServer(env); servers.push(s); return s; };
const four = (env) => Promise.all([0, 1, 2, 3].map(() => start(env)));
const hex = () => crypto.randomBytes(4).toString('hex');
const faultFile = (faults) => {
  const f = path.join(os.tmpdir(), `lab-faults-${hex()}.json`);
  fs.writeFileSync(f, JSON.stringify({ faults }));
  return f;
};

test('four API processes share ONE per-partner budget: exactly the limit passes, never limit × 4', async () => {
  const pid = `rl${hex()}`;
  const key = `k-${hex()}-${hex()}`;
  const fleet = await four({ JOKO_API_KEYS: `${pid}:${key}`, JOKO_PARTNER_RATE_LIMITS: `${pid}:10` });
  const calls = Array.from({ length: 40 }, (_, i) => fleet[i % 4].client('GET', 'v1/payments/nope', { headers: { 'x-api-key': key } }));
  const st = (await Promise.all(calls)).map((r) => r.status);
  assert.equal(st.filter((s) => s !== 429).length, 10, st.join(','));
  assert.equal(st.filter((s) => s === 429).length, 30);
});

test('scoped keys: the per-key limit is shared across the four processes too', async () => {
  const pid = `rk${hex()}`;
  const raw = `jk_live_${crypto.randomBytes(24).toString('base64url')}`;
  await prisma.partnerApiKey.create({ data: { partnerId: pid, keyHash: crypto.createHash('sha256').update(raw).digest('hex'), keyPrefix: raw.slice(0, 12), scopesJson: '["partner.payment.read"]', environment: 'live', status: 'active', rateLimitPerMin: 5, createdBy: 'test', activatedBy: 'test2' } });
  const fleet = await four({ PARTNER_SCOPED_KEYS_ENABLED: 'true', JOKO_API_KEYS: `other:${hex()}${hex()}` });
  const st = (await Promise.all(Array.from({ length: 20 }, (_, i) => fleet[i % 4].client('GET', 'v1/payments/nope', { headers: { 'x-api-key': raw } })))).map((r) => r.status);
  assert.equal(st.filter((s) => s !== 429).length, 5, st.join(','));
});

test('enforcement unavailable → money routes FAIL CLOSED (503, nothing created); read routes degrade open', async () => {
  const pid = `fc${hex()}`;
  const key = `k-${hex()}-${hex()}`;
  const file = faultFile([{ point: 'ratelimit.partner', always: true, action: 'throw', code: 'db_unavailable' }]);
  const fleet = await four({ JOKO_API_KEYS: `${pid}:${key}`, JOKKO_LAB: 'true', JOKKO_LAB_ALLOW: 'local-only', JOKKO_LAB_FAULT_FILE: file });
  const ref = `fc_${hex()}`;
  for (const s of fleet) {
    const money = await s.client('POST', 'v1/payments/collect', { headers: { 'x-api-key': key }, body: { amount_xof: 1000, phone: '+221771234567', method: 'wave', reference: ref } });
    assert.deepEqual([money.status, money.body.code], [503, 'rate_limit_unavailable']);
    const read = await s.client('GET', 'v1/payments/nope', { headers: { 'x-api-key': key } });
    assert.equal(read.status, 404, 'a read proceeds (degraded)');
  }
  assert.equal(await prisma.partnerPayment.count({ where: { partnerId: pid } }), 0, 'nothing executed');
});

test('lab hooks are INERT without both lab variables, and on Vercel even with them', async () => {
  const pid = `in${hex()}`;
  const key = `k-${hex()}-${hex()}`;
  const file = faultFile([{ point: 'ratelimit.partner', always: true, action: 'throw' }, { point: 'money.before_commit', always: true, action: 'crash' }]);
  for (const env of [
    { JOKKO_LAB_FAULT_FILE: file },
    { JOKKO_LAB: 'true', JOKKO_LAB_FAULT_FILE: file },
    { JOKKO_LAB: 'true', JOKKO_LAB_ALLOW: 'local-only', VERCEL: '1', JOKKO_LAB_FAULT_FILE: file },
  ]) {
    const s = await start({ JOKO_API_KEYS: `${pid}:${key}`, ...env });
    const r = await s.client('GET', 'v1/payments/nope', { headers: { 'x-api-key': key } });
    assert.equal(r.status, 404, JSON.stringify(env));
  }
  const { labEnabled } = await import('../../lib/lab/faults.js');
  assert.equal(labEnabled(), false, 'the test process itself is not in the lab');
});
