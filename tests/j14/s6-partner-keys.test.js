/**
 * J14-S6 — partner hardening over real HTTP: database keys with scopes (= route policy permissions),
 * maker/checker activation, rotation with a bounded overlap, immediate revocation, per-partner and per-key
 * rate limits, sandbox/live separation, partner audit trail — and a sweep over EVERY partner route.
 * Invariants after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { ROUTE_POLICY } from '../../lib/authz/route-policy.js';
import { operator } from '../j3/helpers.js';

const ENV_KEY = `j14s6-env-${crypto.randomBytes(8).toString('hex')}`;
const RATE_PARTNER = `rl_${crypto.randomBytes(3).toString('hex')}`;
let api;
let maker;
let checker;

before(async () => {
  api = await startApiServer({ JOKO_API_KEYS: `kebu:${ENV_KEY}`, PARTNER_SCOPED_KEYS_ENABLED: 'true', JOKO_PARTNER_RATE_LIMITS: `${RATE_PARTNER}:4` });
  maker = await operator(api, ['integration_ops']);
  checker = await operator(api, ['risk']);
});
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const pid = (p = 'p') => `${p}_${crypto.randomBytes(3).toString('hex')}`;
const as = (key) => ({ headers: { 'x-api-key': key } });
const REASON = 'partner onboarding ticket 42';

/** Maker issues, checker approves → an ACTIVE key. */
async function activeKey(partnerId, body, server = api, mk = maker, ck = checker) {
  const r = await mk.call('POST', `admin/partners/${partnerId}/keys`, { reason: REASON, environment: 'live', ...body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ok = await ck.call('POST', `admin/approvals/${r.body.approval.id}/approve`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  return r.body.key;
}
const concretePath = (routePath) => routePath.replace(/:[A-Za-z]+/g, `x_${crypto.randomBytes(3).toString('hex')}`);
const PARTNER_ROUTES = Object.entries(ROUTE_POLICY).filter(([, p]) => p.actor === 'partner').map(([k, p]) => {
  const [method, ...rest] = k.split(' ');
  return { key: k, method, path: rest.join(' '), perm: p.perm };
});

test('disabled by default: no flag → key issuance refused, a database key is not a credential, env keys unchanged', async () => {
  const off = await startApiServer({ JOKO_API_KEYS: `kebu:${ENV_KEY}` });
  try {
    const mk = await operator(off, ['integration_ops']);
    const r = await mk.call('POST', `admin/partners/${pid()}/keys`, { reason: REASON, environment: 'live', scopes: ['partner.payment.read'] });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'disabled');
    const k = await activeKey(pid(), { scopes: ['partner.payment.read'] }); // issued on the enabled server
    assert.equal((await off.client('GET', 'v1/payments/nope', as(k.secret))).status, 401, 'flag off → database keys do not authenticate');
    assert.equal((await off.client('GET', 'v1/payments/nope', as(ENV_KEY))).status, 404, 'env key unchanged');
  } finally {
    await off.stop();
  }
});

test('maker/checker: a new key is unusable until a DIFFERENT operator approves; shown once; never listed with a hash', async () => {
  const p = pid();
  const r = await maker.call('POST', `admin/partners/${p}/keys`, { reason: REASON, environment: 'live', scopes: ['partner.payment.read'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const { key, approval } = r.body;
  assert.match(key.secret, /^jk_live_/);
  assert.equal(key.status, 'pending');
  assert.equal((await api.client('GET', 'v1/payments/nope', as(key.secret))).status, 401, 'pending key refused');
  assert.equal((await maker.call('POST', `admin/approvals/${approval.id}/approve`, {})).status, 403, 'maker cannot approve');
  const other = await operator(api, ['integration_ops']);
  assert.equal((await other.call('POST', `admin/approvals/${approval.id}/approve`, {})).status, 403, 'issuer role cannot approve');
  assert.equal((await checker.call('POST', `admin/approvals/${approval.id}/approve`, {})).status, 200);
  assert.equal((await api.client('GET', 'v1/payments/nope', as(key.secret))).status, 404, 'active key authenticates (payment simply not found)');
  const list = await maker.call('GET', `admin/partners/${p}/keys`);
  assert.equal(list.status, 200);
  const raw = JSON.stringify(list.body);
  assert.ok(!raw.includes(key.secret) && !raw.includes('keyHash') && !raw.includes(crypto.createHash('sha256').update(key.secret).digest('hex')));
  const row = await prisma.partnerApiKey.findUnique({ where: { id: key.id } });
  assert.notEqual(row.keyHash, key.secret, 'only the hash is stored');
  const noPerm = await operator(api, ['trust_safety']);
  assert.equal((await noPerm.call('POST', `admin/partners/${p}/keys`, { reason: REASON, environment: 'live', scopes: ['partner.payment.read'] })).status, 403);
});

test('sweep: EVERY partner route refuses no key (401), a revoked key (401) and a key without its scope (403 scope_required); with the scope it passes authentication', async () => {
  const p = pid('sweep');
  const allScopes = [...new Set(PARTNER_ROUTES.map((r) => r.perm))];
  const findings = [];
  // One key holding every scope EXCEPT the route's, per distinct permission.
  const without = new Map();
  for (const perm of allScopes) {
    const others = allScopes.filter((s) => s !== perm);
    without.set(perm, await activeKey(p, { scopes: others.length ? others : ['partner.payment.read'], rate_limit_per_min: 1000 }));
  }
  const full = await activeKey(`${p}f`, { scopes: allScopes });
  const revoked = await activeKey(`${p}r`, { scopes: allScopes });
  assert.equal((await maker.call('POST', `admin/partner-keys/${revoked.id}/revoke`, { reason: 'compromised in a test' })).status, 200);
  for (const r of PARTNER_ROUTES) {
    const path = concretePath(r.path);
    const call = (key) => api.client(r.method, path, { ...(key ? as(key) : {}), body: r.method === 'GET' ? undefined : {} });
    const none = await call(null);
    if (none.status !== 401) findings.push(`${r.key}: no key → ${none.status}`);
    const rev = await call(revoked.secret);
    if (rev.status !== 401) findings.push(`${r.key}: revoked → ${rev.status}`);
    const lack = await call(without.get(r.perm).secret);
    if (lack.status !== 403 || lack.body.code !== 'scope_required') findings.push(`${r.key}: missing scope → ${lack.status} ${lack.body.code}`);
    const ok = await call(full.secret);
    if (ok.status === 401 || ['scope_required', 'environment_mismatch'].includes(ok.body?.code) && r.perm !== 'partner.sandbox') findings.push(`${r.key}: full scope → ${ok.status} ${ok.body?.code}`);
  }
  assert.deepEqual(findings, []);
  assert.ok(PARTNER_ROUTES.length >= 20, `covered ${PARTNER_ROUTES.length} partner routes`);
  assert.equal(await prisma.partnerPayment.count({ where: { partnerId: { startsWith: p } } }), 0, 'refused calls created nothing');
});

test('rotation: old key keeps working until the new one is approved, then only for the overlap; overlap 0 cuts it at approval', async () => {
  const p = pid();
  const a = await activeKey(p, { scopes: ['partner.payment.read'] });
  const rot = await maker.call('POST', `admin/partner-keys/${a.id}/rotate`, { reason: 'scheduled key rotation', overlap_hours: 0 });
  assert.equal(rot.status, 201, JSON.stringify(rot.body));
  const b = rot.body.key;
  assert.deepEqual(b.scopes, ['partner.payment.read'], 'same scopes');
  assert.equal((await api.client('GET', 'v1/payments/nope', as(a.secret))).status, 404, 'old key still works while the new one is pending');
  assert.equal((await api.client('GET', 'v1/payments/nope', as(b.secret))).status, 401, 'new key unusable until approved');
  assert.equal((await checker.call('POST', `admin/approvals/${rot.body.approval.id}/approve`, {})).status, 200);
  assert.equal((await api.client('GET', 'v1/payments/nope', as(a.secret))).status, 401, 'old key refused after rotation');
  assert.equal((await api.client('GET', 'v1/payments/nope', as(b.secret))).status, 404);

  const c = await activeKey(pid(), { scopes: ['partner.payment.read'] });
  const rot2 = await maker.call('POST', `admin/partner-keys/${c.id}/rotate`, { reason: 'scheduled key rotation' });
  await checker.call('POST', `admin/approvals/${rot2.body.approval.id}/approve`, {});
  const old = await prisma.partnerApiKey.findUnique({ where: { id: c.id } });
  const left = old.expiresAt.getTime() - Date.now();
  assert.ok(left > 23 * 3600_000 && left <= 24 * 3600_000, `default overlap ≤ 24 h (${left})`);
  assert.equal((await api.client('GET', 'v1/payments/nope', as(c.secret))).status, 404, 'inside the overlap');
  await prisma.partnerApiKey.update({ where: { id: c.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await api.client('GET', 'v1/payments/nope', as(c.secret))).status, 401, 'after the overlap');
  const big = await maker.call('POST', `admin/partner-keys/${rot2.body.key.id}/rotate`, { reason: 'scheduled key rotation', overlap_hours: 1000 });
  assert.equal(big.status, 201);
  assert.ok((await prisma.partnerApiKey.findUnique({ where: { id: big.body.key.id } })).rotationOverlapMs <= 24 * 3600_000, 'overlap capped at 24 h');
});

test('revocation is immediate and audited; a revoked PENDING key can never be activated by its approval', async () => {
  const k = await activeKey(pid(), { scopes: ['partner.payment.read'] });
  assert.equal((await maker.call('POST', `admin/partner-keys/${k.id}/revoke`, { reason: 'short' })).status, 400, 'reason required');
  assert.equal((await checker.call('POST', `admin/partner-keys/${k.id}/revoke`, { reason: 'suspected key leak' })).status, 200);
  assert.equal((await api.client('GET', 'v1/payments/nope', as(k.secret))).status, 401);
  assert.equal(await prisma.adminAuditLog.count({ where: { action: 'partner_key.revoke', targetId: k.id } }), 1);

  const r = await maker.call('POST', `admin/partners/${pid()}/keys`, { reason: REASON, environment: 'live', scopes: ['partner.payment.read'] });
  await maker.call('POST', `admin/partner-keys/${r.body.key.id}/revoke`, { reason: 'issued by mistake' });
  const ap = await checker.call('POST', `admin/approvals/${r.body.approval.id}/approve`, {});
  assert.equal(ap.status, 409, JSON.stringify(ap.body));
  assert.equal((await prisma.partnerApiKey.findUnique({ where: { id: r.body.key.id } })).status, 'revoked');
  assert.equal((await api.client('GET', 'v1/payments/nope', as(r.body.key.secret))).status, 401);
});

test('validation: unknown scopes, empty scopes, bad environment, bad partner id are refused; nothing created', async () => {
  const p = pid();
  for (const body of [{ scopes: ['partner.everything'] }, { scopes: [] }, { scopes: ['partner.payment.read'], environment: 'prod' }]) {
    const r = await maker.call('POST', `admin/partners/${p}/keys`, { reason: REASON, environment: 'live', ...body });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  }
  assert.equal((await maker.call('POST', 'admin/partners/BAD%20ID/keys', { reason: REASON, environment: 'live', scopes: ['partner.payment.read'] })).status, 400);
  assert.equal(await prisma.partnerApiKey.count({ where: { partnerId: p } }), 0);
});

test('rate limits: per key and per partner (JOKO_PARTNER_RATE_LIMITS) → 429; another partner is unaffected', async () => {
  const k = await activeKey(pid(), { scopes: ['partner.payment.read'], rate_limit_per_min: 3 });
  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await api.client('GET', 'v1/payments/nope', as(k.secret))).status);
  assert.deepEqual(statuses, [404, 404, 404, 429, 429]);
  const a = await activeKey(RATE_PARTNER, { scopes: ['partner.payment.read'] });
  const b = await activeKey(RATE_PARTNER, { scopes: ['partner.payment.read'] });
  const s2 = [];
  for (let i = 0; i < 3; i += 1) s2.push((await api.client('GET', 'v1/payments/nope', as(a.secret))).status, (await api.client('GET', 'v1/payments/nope', as(b.secret))).status);
  assert.deepEqual(s2.filter((s) => s === 429).length, 2, `partner limit 4/min shared across its keys: ${s2}`);
  const other = await activeKey(pid(), { scopes: ['partner.payment.read'] });
  assert.equal((await api.client('GET', 'v1/payments/nope', as(other.secret))).status, 404);
});

test('environments: a sandbox key is refused against live; a live key never reaches a sandbox-only route; sandbox parity with the env key', async () => {
  const sk = await activeKey(pid(), { scopes: ['partner.payment.read', 'partner.checkout', 'partner.sandbox'], environment: 'sandbox' });
  assert.match(sk.secret, /^jk_test_/);
  const live = await api.client('GET', 'v1/payments/nope', as(sk.secret));
  assert.equal(live.status, 403);
  assert.equal(live.body.code, 'environment_mismatch');

  const sandboxEnvKey = `j14s6-sbx-${crypto.randomBytes(6).toString('hex')}`;
  const sbx = await startApiServer({ NODE_ENV: 'development', JOKO_API_KEYS: `kebu:${sandboxEnvKey}`, PARTNER_SCOPED_KEYS_ENABLED: 'true' });
  try {
    const lk = await activeKey(pid(), { scopes: ['partner.sandbox', 'partner.payment.read'] });
    const r = await sbx.client('POST', 'v1/payments/x_ref/sandbox-complete', { ...as(lk.secret), body: {} });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'environment_mismatch');
    // Parity: the same checkout through a sandbox DB key and through the env key — same contract.
    const p = sk.partner_id;
    const body = (ref) => ({ amount_xof: 1000, reference: ref, description: 'parity', return_url: 'https://example.test/r' });
    const viaKey = await sbx.client('POST', 'v1/checkout/sessions', { ...as(sk.secret), body: body(`par_${crypto.randomBytes(4).toString('hex')}`) });
    const viaEnv = await sbx.client('POST', 'v1/checkout/sessions', { ...as(sandboxEnvKey), body: body(`par_${crypto.randomBytes(4).toString('hex')}`) });
    assert.equal(viaKey.status, viaEnv.status, `${JSON.stringify(viaKey.body)} vs ${JSON.stringify(viaEnv.body)}`);
    assert.deepEqual(Object.keys(viaKey.body).sort(), Object.keys(viaEnv.body).sort());
    assert.ok(viaKey.status < 300, `sandbox checkout through a sandbox key: ${viaKey.status} ${JSON.stringify(viaKey.body)}`);
    assert.equal(await prisma.partnerPayment.count({ where: { partnerId: p } }), 1, 'the payment belongs to the key\'s partner');
  } finally {
    await sbx.stop();
  }
});

test('partner audit trail: every mutating call is recorded (partner, key, route, status — no body); reads are not; isolation by partner', async () => {
  const k = await activeKey(pid(), { scopes: ['partner.messages.send', 'partner.payment.read'] });
  await api.client('POST', 'v1/messages/send', { ...as(k.secret), body: { to_phone: '+221770000000', text: 'secret body text' } });
  await api.client('GET', 'v1/payments/nope', as(k.secret));
  const rows = await prisma.partnerAuditLog.findMany({ where: { partnerId: k.partner_id } });
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.deepEqual([rows[0].credential, rows[0].keyId, rows[0].routeKey], ['db', k.id, 'POST v1/messages/send']);
  assert.ok(!JSON.stringify(rows).includes('secret body text') && !JSON.stringify(rows).includes('+221770000000'), 'no body / personal data');
  await api.client('POST', 'v1/messages/send', { ...as(ENV_KEY), body: {} });
  assert.ok(await prisma.partnerAuditLog.count({ where: { partnerId: 'kebu', credential: 'env' } }) >= 1, 'env keys audited too');
  const view = await checker.call('GET', `admin/partners/${k.partner_id}/audit`);
  assert.equal(view.status, 200);
  assert.equal(view.body.entries.length, 1);
  const ts = await operator(api, ['trust_safety']);
  assert.equal((await ts.call('GET', `admin/partners/${k.partner_id}/audit`)).status, 403);
});

test('cross-partner: a key only ever acts as ITS partner — another partner\'s payment reads as not found', async () => {
  const k = await activeKey(pid(), { scopes: ['partner.payment.read'] });
  const pay = await prisma.partnerPayment.create({ data: { partnerId: 'kebu', reference: `xp_${crypto.randomBytes(4).toString('hex')}`, amountXof: 1000, checkoutToken: crypto.randomBytes(16).toString('hex') } });
  assert.equal((await api.client('GET', `v1/payments/${pay.reference}`, as(k.secret))).status, 404);
  assert.equal((await api.client('GET', `v1/payments/${pay.reference}`, as(ENV_KEY))).status, 200, 'its own partner sees it');
});
