/**
 * J14-F4 — partner keys: independent risk-role approval with STRICT separation between creator and approver.
 *   - the issuing role (integration_ops) and the approving role (risk) can never be held together (role SoD),
 *     and the role manager (sysadmin) holds neither;
 *   - re-checked at approval time: an approver who somehow holds issuing authority is refused;
 *   - issue / rotate / activate / revoke are each audited, with the key prefix only — never the key or hash;
 *   - scoped access and revocation unchanged.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { grantAdminRole } from '../../lib/authz/admin-authz.js';
import { operator } from '../j3/helpers.js';

let api;
before(async () => { api = await startApiServer({ PARTNER_SCOPED_KEYS_ENABLED: 'true' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const pid = () => `sod_${crypto.randomBytes(3).toString('hex')}`;
const REASON = 'partner onboarding ticket 77';
const issue = (mk, p, body = {}) => mk.call('POST', `admin/partners/${p}/keys`, { reason: REASON, environment: 'live', scopes: ['partner.payment.read'], ...body });

test('role SoD: integration_ops and risk can never be combined (either order); sysadmin holds neither', async () => {
  const a = await operator(api, ['integration_ops']);
  await assert.rejects(grantAdminRole(prisma, { adminUserId: a.id, role: 'risk', grantedBy: 'test', reason: 'attempt to combine roles' }), (e) => e.code === 'sod_conflict');
  const b = await operator(api, ['risk']);
  await assert.rejects(grantAdminRole(prisma, { adminUserId: b.id, role: 'integration_ops', grantedBy: 'test', reason: 'attempt to combine roles' }), (e) => e.code === 'sod_conflict');
  const c = await operator(api, ['sysadmin']);
  await assert.rejects(grantAdminRole(prisma, { adminUserId: c.id, role: 'integration_ops', grantedBy: 'test', reason: 'attempt to combine roles' }), (e) => e.code === 'sod_conflict');
});

test('an approver who holds issuing authority (grant made outside the flow) is refused at approval time; the key stays unusable', async () => {
  const maker = await operator(api, ['integration_ops']);
  const r = await issue(maker, pid());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // Seeded directly (bypassing grantAdminRole) to prove the approval-time re-check.
  const dual = await operator(api, ['risk']);
  await prisma.adminRoleGrant.create({ data: { adminUserId: dual.id, role: 'integration_ops', grantedBy: 'out-of-band', reason: 'out-of-band grant' } });
  const ap = await dual.call('POST', `admin/approvals/${r.body.approval.id}/approve`, {});
  assert.equal(ap.status, 403, JSON.stringify(ap.body));
  assert.equal((await prisma.partnerApiKey.findUnique({ where: { id: r.body.key.id } })).status, 'pending');
  assert.equal((await api.client('GET', 'v1/payments/x', { headers: { 'x-api-key': r.body.key.secret } })).status, 401);
  // A clean risk operator can still approve the same request.
  const checker = await operator(api, ['risk']);
  assert.equal((await checker.call('POST', `admin/approvals/${r.body.approval.id}/approve`, {})).status, 200);
});

test('the creator can never approve, not even a rotation they requested; another issuer cannot approve either', async () => {
  const maker = await operator(api, ['integration_ops']);
  const checker = await operator(api, ['risk']);
  const r = await issue(maker, pid());
  assert.equal((await maker.call('POST', `admin/approvals/${r.body.approval.id}/approve`, {})).status, 403);
  const peer = await operator(api, ['integration_ops']);
  assert.equal((await peer.call('POST', `admin/approvals/${r.body.approval.id}/approve`, {})).status, 403);
  assert.equal((await checker.call('POST', `admin/approvals/${r.body.approval.id}/approve`, {})).status, 200);
  const rot = await maker.call('POST', `admin/partner-keys/${r.body.key.id}/rotate`, { reason: 'scheduled key rotation' });
  assert.equal((await maker.call('POST', `admin/approvals/${rot.body.approval.id}/approve`, {})).status, 403);
  assert.equal((await checker.call('POST', `admin/approvals/${rot.body.approval.id}/approve`, {})).status, 200);
});

test('audit: issue, rotate, activate and revoke are recorded with creator/approver — never the key or its hash', async () => {
  const maker = await operator(api, ['integration_ops']);
  const checker = await operator(api, ['risk']);
  const r = await issue(maker, pid());
  await checker.call('POST', `admin/approvals/${r.body.approval.id}/approve`, {});
  const rot = await maker.call('POST', `admin/partner-keys/${r.body.key.id}/rotate`, { reason: 'scheduled key rotation' });
  await checker.call('POST', `admin/approvals/${rot.body.approval.id}/approve`, {});
  await checker.call('POST', `admin/partner-keys/${rot.body.key.id}/revoke`, { reason: 'suspected key leak' });
  const rows = await prisma.adminAuditLog.findMany({ where: { targetId: { in: [r.body.key.id, rot.body.key.id] } }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(rows.map((x) => x.action), ['partner_key.issue', 'partner_key.activate', 'partner_key.rotate_request', 'partner_key.activate', 'partner_key.revoke']);
  const act = JSON.parse(rows[1].detailJson);
  assert.deepEqual([act.createdBy, act.approvedBy], [maker.id, checker.id]);
  const all = JSON.stringify(rows);
  for (const secret of [r.body.key.secret, rot.body.key.secret]) {
    assert.ok(!all.includes(secret), 'no key in the audit trail');
    assert.ok(!all.includes(crypto.createHash('sha256').update(secret).digest('hex')), 'no key hash in the audit trail');
  }
});
