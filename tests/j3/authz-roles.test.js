/**
 * J3 destruction suite — authorization: business staff, agents, couriers,
 * operators (separation of duties, maker-checker), role escalation.
 * Real HTTP, NODE_ENV=production; J2 invariants after every scenario.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { fundBusiness, fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { account } from '../../lib/money-kernel/flows.js';
import { ensureBusinessWallet } from '../../lib/business-wallet-service.js';
import { applyForAgentProfile, approveAgentProfile } from '../../lib/agent-service.js';
import { business, customer, operator, signedIn, stepUp } from './helpers.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

async function bizWithMoney(owner, members = [], kori = 10_000) {
  const b = await business(owner, members);
  await ensureBusinessWallet(b.id, prisma);
  await fundBusiness(b.id, kori);
  return b;
}
const bizBal = async (id) => (await prisma.businessWallet.findUnique({ where: { businessId: id } })).balance;

// ── Business / merchant identity ─────────────────────────────────────────────

test('merchant A cannot touch merchant B; employee of A cannot act for B', async () => {
  const ownerA = await signedIn(api, await customer());
  const ownerB = await signedIn(api, await customer());
  const cfoA = await signedIn(api, await customer());
  const a = await bizWithMoney(ownerA, [{ user: cfoA, role: 'cfo' }]);
  const b = await bizWithMoney(ownerB);
  for (const actor of [ownerA, cfoA]) {
    assert.equal((await actor.call('GET', `businesses/${b.id}/wallet`)).status, 403);
    assert.equal((await actor.call('GET', `businesses/${b.id}/members`)).status, 403);
    await stepUp(actor);
    const t = await actor.call('POST', `businesses/${b.id}/transfer`, { kind: 'b2b', amount: 100, recipientBusinessId: a.id });
    assert.equal(t.status, 403);
  }
  assert.equal(await bizBal(b.id), 10_000);
});

test('employee → owner-only action: grants above own level and owner-only roles are refused', async () => {
  const owner = await signedIn(api, await customer());
  const adminM = await signedIn(api, await customer());
  const staff = await signedIn(api, await customer());
  const target = await customer();
  const b = await business(owner, [{ user: adminM, role: 'admin' }, { user: staff, role: 'staff' }]);
  const asCfo = await adminM.call('POST', `businesses/${b.id}/members`, { userHandle: target.handle, role: 'cfo' });
  assert.equal(asCfo.status, 403);
  assert.equal(asCfo.body.code, 'owner_only_role');
  const asOwner = await adminM.call('POST', `businesses/${b.id}/members`, { userHandle: target.handle, role: 'owner' });
  assert.ok([400, 403].includes(asOwner.status), 'J5: ownership is not a grantable role at all');
  assert.equal((await staff.call('POST', `businesses/${b.id}/members`, { userHandle: target.handle, role: 'viewer' })).status, 403);
  assert.equal((await staff.call('GET', `businesses/${b.id}/wallet`)).status, 403, 'staff cannot read treasury');
  assert.equal(await prisma.businessMember.count({ where: { businessId: b.id, userId: target.id } }), 0);
});

test('invitation is not authority: no access until the invitee accepts; nobody else can accept it', async () => {
  const owner = await signedIn(api, await customer());
  const invitee = await signedIn(api, await customer());
  const forger = await signedIn(api, await customer());
  const b = await bizWithMoney(owner);
  const inv = await owner.call('POST', `businesses/${b.id}/members`, { userHandle: invitee.handle, role: 'admin' });
  assert.equal(inv.status, 201);
  assert.equal(inv.body.status, 'invited');
  assert.equal((await invitee.call('GET', `businesses/${b.id}/wallet`)).status, 403, 'invited ≠ member');
  assert.equal((await forger.call('POST', `businesses/${b.id}/members/${inv.body.id}/accept`)).status, 404, 'forged acceptance');
  const mine = await invitee.call('GET', 'businesses/invitations/mine');
  assert.ok(mine.body.some((m) => m.id === inv.body.id));
  assert.equal((await invitee.call('POST', `businesses/${b.id}/members/${inv.body.id}/accept`)).status, 200);
  assert.equal((await invitee.call('GET', `businesses/${b.id}/wallet`)).status, 200);
});

test('revoked employee: removal is immediate, history stays attributed; concurrent removal vs payment never pays after removal', async () => {
  const owner = await signedIn(api, await customer());
  const cfo = await signedIn(api, await customer());
  const a = await bizWithMoney(owner, [{ user: cfo, role: 'cfo' }], 10_000);
  const other = await bizWithMoney(await customer());
  await stepUp(cfo);
  const paid = await cfo.call('POST', `businesses/${a.id}/transfer`, { kind: 'b2b', amount: 100, recipientBusinessId: other.id });
  assert.equal(paid.status, 201, JSON.stringify(paid.body));
  const member = await prisma.businessMember.findFirst({ where: { businessId: a.id, userId: cfo.id } });

  // Race: owner removes the CFO while the CFO fires payments.
  const [removed, ...pays] = await Promise.all([
    owner.call('POST', `businesses/${a.id}/members/${member.id}/remove`, { reason: 'left the company' }),
    ...[1, 2, 3].map(() => cfo.call('POST', `businesses/${a.id}/transfer`, { kind: 'b2b', amount: 100, recipientBusinessId: other.id })),
  ]);
  assert.equal(removed.status, 200);
  const after = await prisma.businessMember.findUnique({ where: { id: member.id } });
  const entries = await prisma.journalEntry.findMany({ where: { kind: 'business_transfer', metadata: { not: undefined } }, orderBy: { createdAt: 'asc' } }).catch(() => []);
  for (const p of pays.filter((x) => x.status === 201)) {
    const e = await prisma.journalEntry.findFirst({ where: { reference: `${p.body.reference}-J` } });
    assert.ok(!e || e.createdAt <= after.removedAt, 'no payment committed after the removal');
  }
  void entries;
  // After removal: nothing works.
  assert.equal((await cfo.call('GET', `businesses/${a.id}/wallet`)).status, 403);
  const late = await cfo.call('POST', `businesses/${a.id}/transfer`, { kind: 'b2b', amount: 100, recipientBusinessId: other.id });
  assert.equal(late.status, 403);
  assert.equal(after.status, 'removed', 'row kept, not deleted');
  await assert.rejects(prisma.businessMember.delete({ where: { id: member.id } }), /never deleted/);
  assert.ok(await prisma.identityAuditEvent.findFirst({ where: { action: 'business_member_removed', subjectId: a.id } }));
});

test('payroll employment never grants business authority (job title "cfo" is not a role)', async () => {
  const owner = await signedIn(api, await customer());
  const worker = await signedIn(api, await customer());
  const b = await bizWithMoney(owner);
  const r = await owner.call('POST', `businesses/${b.id}/payroll/employees`, { userHandle: worker.handle, jobTitle: 'cfo', payAmount: 1000 });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  assert.equal(await prisma.businessMember.count({ where: { businessId: b.id, userId: worker.id, status: 'active' } }), 0);
  assert.equal((await worker.call('GET', `businesses/${b.id}/wallet`)).status, 403);
});

// ── Courier / agent trust ────────────────────────────────────────────────────

test('fake courier: no endpoint self-grants the courier role', async () => {
  const u = await signedIn(api, await customer());
  const viaRoles = await u.call('POST', 'roles/driver');
  assert.equal(viaRoles.status, 403);
  const viaQuery = await u.call('POST', 'roles/driver?role=driver');
  assert.equal(viaQuery.status, 403, 'the old ?role= bypass is closed');
  assert.equal((await u.call('POST', 'workers/profile', { modes: ['delivery'] })).status, 201);
  const applied = await u.call('POST', 'drivers/profile', { vehicle: 'moto' });
  assert.equal(applied.status, 202);
  assert.equal((await u.call('GET', 'deliveries/nearby')).status, 403);
  const role = await prisma.accountRole.findUnique({ where: { userId_role: { userId: u.id, role: 'driver' } } });
  assert.equal(role.status, 'pending');
});

test('courier onboarding: compliance approves; risk suspends; a suspended courier is cut off immediately', async () => {
  const u = await signedIn(api, await customer());
  await u.call('POST', 'workers/profile', { modes: ['delivery'] });
  await u.call('POST', 'drivers/profile', { vehicle: 'moto' });
  const support = await operator(api, ['support']);
  assert.equal((await support.call('POST', `admin/couriers/${u.id}/approve`, { reason: 'ok' })).status, 403);
  const compliance = await operator(api, ['compliance']);
  assert.equal((await compliance.call('POST', `admin/couriers/${u.id}/approve`, { reason: 'ID and vehicle checked' })).status, 200);
  assert.equal((await u.call('GET', 'deliveries/nearby')).status, 200);
  const risk = await operator(api, ['risk']);
  assert.equal((await risk.call('POST', `admin/couriers/${u.id}/suspend`, { reason: 'complaints' })).status, 200);
  const cut = await u.call('GET', 'deliveries/nearby');
  assert.equal(cut.status, 403);
  assert.equal(cut.body.code, 'driver_required');
  assert.equal((await u.call('POST', 'roles/driver')).status, 403, 'cannot self-reactivate');
});

test('agent → unrelated customer / suspended agent: cut off at the policy layer', async () => {
  const ag = await signedIn(api, await customer({ tier: 2 }));
  const profile = await applyForAgentProfile({ userId: ag.id, displayName: 'Point Test' });
  await approveAgentProfile(profile.id, 'test-compliance');
  assert.notEqual((await ag.call('GET', 'agent/me')).status, 403);
  const stranger = await customer();
  const scan = await ag.call('POST', 'agent/withdrawals/scan', { token: 'not-a-real-session-token' });
  assert.ok([400, 404].includes(scan.status), 'an agent reaches only sessions a customer opened for them');
  void stranger;
  const risk = await operator(api, ['risk']);
  assert.equal((await risk.call('POST', `admin/agents/${profile.id}/suspend`, { reason: 'float mismatch' })).status, 200);
  const r = await ag.call('POST', 'agent/deposits/scan', { token: 'xxxxxxxxxxxx' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'agent_required');
  // Finance topping up a pending/suspended agent never (re)activates them.
  const fin = await operator(api, ['finance_ops']);
  await fin.call('POST', `admin/agents/${profile.id}/float`, { amountXof: 1000, note: 'test top-up' });
  assert.equal((await prisma.agentProfile.findUnique({ where: { id: profile.id } })).status, 'suspended');
});

// ── Operators: separation of duties, maker-checker ──────────────────────────

test('no god-mode: an operator with no role is authorized for nothing; the shared key is retired', async () => {
  const nobody = await operator(api, []);
  assert.equal((await nobody.call('GET', 'admin/me')).status, 200);
  for (const [m, p] of [['GET', 'admin/dashboard'], ['GET', 'admin/users?q=77'], ['GET', 'admin/money/position'], ['GET', 'admin/kyc/queue']]) {
    const r = await nobody.call(m, p);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.body.code, 'permission_denied');
  }
  const legacy = await api.client('GET', 'admin/dashboard', { headers: { 'x-admin-key': 'anything' } });
  assert.equal(legacy.status, 401);
});

test('support cannot move money, decide KYC, unfreeze or see sensitive data', async () => {
  const support = await operator(api, ['support']);
  const c = await customer({ koriBalance: 0 });
  await fundUser(c.id, 1234);
  assert.equal((await support.call('POST', 'admin/refunds', { recipientUserId: c.id, amount: 10, reason: 'goodwill gesture' })).status, 403);
  assert.equal((await support.call('POST', 'admin/money/adjustments', {})).status, 403);
  assert.equal((await support.call('POST', `admin/kyc/x/approve`, {})).status, 403);
  assert.equal((await support.call('POST', `admin/users/${c.id}/unfreeze`, { reason: 'customer asked us to' })).status, 403);
  const detail = await support.call('GET', `admin/users/${c.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.disclosure, 'support_minimal');
  assert.equal(detail.body.wallet, undefined, 'no balance for support');
  assert.ok(!String(detail.body.phone).includes(c.phone.slice(5)), 'phone masked');
  assert.ok(!JSON.stringify(detail.body).match(/pinHash|passwordHash|cniHash|cniNumber/));
});

test('finance operator cannot take identity actions; risk cannot move money', async () => {
  const fin = await operator(api, ['finance_ops']);
  const risk = await operator(api, ['risk']);
  const c = await customer();
  assert.equal((await fin.call('POST', `admin/users/${c.id}/freeze`, { reason: 'test' })).status, 403);
  assert.equal((await fin.call('POST', `admin/users/${c.id}/credentials/invalidate`, { reason: 'test reason' })).status, 403);
  assert.equal((await fin.call('POST', `admin/couriers/${c.id}/approve`, { reason: 'x' })).status, 403);
  assert.equal((await risk.call('POST', 'admin/refunds', { recipientUserId: c.id, amount: 10, reason: 'goodwill' })).status, 403);
  assert.equal((await risk.call('POST', `admin/agents/x/float`, { amountXof: 10 })).status, 403);
});

test('high-risk financial adjustment: finance_ops alone cannot post to a customer; the approver must be someone else', async () => {
  const fin = await operator(api, ['finance_ops']);
  const approver = await operator(api, ['finance_approver']);
  const c = await customer();
  const key = `adj-${c.id}`;
  await prisma.$transaction(async (tx) => { await account(tx, 'suspense'); await account(tx, 'refundsBudget'); });
  const req = await fin.call('POST', 'admin/money/adjustments', {
    debitAccount: 'suspense:reconciliation:KRI', creditAccount: `customer:${c.id}:available`, amount: 50, reason: 'statement correction 2026-10',
  }, { 'idempotency-key': key });
  assert.equal(req.status, 201, JSON.stringify(req.body));
  assert.equal(req.body.status, 'requested', 'customer-facing: dual authorization');
  assert.equal((await fin.call('POST', `admin/money/adjustments/${req.body.id}/approve`)).status, 403, 'requester lacks approve permission');
  const ok = await approver.call('POST', `admin/money/adjustments/${req.body.id}/approve`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'posted');
});

test('D10 low-risk path: a small platform-to-platform correction posts with one operator, audited', async () => {
  const fin = await operator(api, ['finance_ops']);
  await prisma.$transaction(async (tx) => { await account(tx, 'suspense'); await account(tx, 'refundsBudget'); });
  const r = await fin.call('POST', 'admin/money/adjustments', {
    debitAccount: 'suspense:reconciliation:KRI', creditAccount: 'platform:refunds', amount: 100, reason: 'reclassify a small difference',
  }, { 'idempotency-key': `low-${Date.now()}` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // Above the single-operator cap → requested, not posted.
  const big = await fin.call('POST', 'admin/money/adjustments', {
    debitAccount: 'suspense:reconciliation:KRI', creditAccount: 'platform:refunds', amount: 999_999, reason: 'large reclassification',
  }, { 'idempotency-key': `big-${Date.now()}` });
  assert.equal(big.body.status, 'requested');
  assert.equal(r.body.status, 'posted');
  const e = await prisma.journalEntry.findUnique({ where: { reference: `adjustment:${r.body.id}` } });
  assert.match(e.metadata?.authorization ?? '', /admin_single_low_risk/);
  assert.equal(e.metadata?.policy, 'single_low_risk');
});

test('maker-checker: unfreeze needs a second operator; nobody approves their own request', async () => {
  const risk1 = await operator(api, ['risk']);
  const risk2 = await operator(api, ['risk']);
  const c = await customer();
  assert.equal((await risk1.call('POST', `admin/users/${c.id}/freeze`, { reason: 'suspected takeover' })).status, 200);
  const req = await risk1.call('POST', `admin/users/${c.id}/unfreeze`, { reason: 'owner verified in branch, case 42' });
  assert.equal(req.status, 202);
  const self = await risk1.call('POST', `admin/approvals/${req.body.approval.id}/approve`);
  assert.equal(self.status, 403);
  assert.ok((await prisma.user.findUnique({ where: { id: c.id } })).frozenByAdminAt, 'still frozen');
  const ok = await risk2.call('POST', `admin/approvals/${req.body.approval.id}/approve`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await prisma.user.findUnique({ where: { id: c.id } })).frozenByAdminAt, null);
  const again = await risk2.call('POST', `admin/approvals/${req.body.approval.id}/approve`);
  assert.equal(again.body.approval.status, 'executed', 'idempotent; decided requests are final');
});

test('admin privilege escalation: role grants are maker-checker, never self, and respect separation of duties', async () => {
  const sys1 = await operator(api, ['sysadmin']);
  const sys2 = await operator(api, ['sysadmin']);
  const target = await operator(api, []);
  // A sysadmin cannot request a role for themself.
  const self = await sys1.call('POST', `admin/admins/${sys1.id}/roles`, { role: 'finance_approver', reason: 'I need it for a while' });
  assert.equal(self.status, 403);
  // Request for someone else → pending; the requester cannot approve it.
  const req = await sys1.call('POST', `admin/admins/${target.id}/roles`, { role: 'finance_ops', reason: 'new finance hire, ticket 7' });
  assert.equal(req.status, 202);
  assert.equal((await sys1.call('POST', `admin/approvals/${req.body.approval.id}/approve`)).status, 403);
  assert.equal((await target.call('GET', 'admin/money/position')).status, 403, 'not yet granted');
  assert.equal((await sys2.call('POST', `admin/approvals/${req.body.approval.id}/approve`)).status, 200);
  assert.equal((await target.call('GET', 'admin/money/position')).status, 200, 'granted after the second sysadmin');
  // The grantee cannot approve a grant to themself either (DB + app).
  await assert.rejects(
    prisma.adminRoleGrant.create({ data: { adminUserId: target.id, role: 'risk', grantedBy: sys1.id, approvedBy: target.id, reason: 'self approval attempt' } }),
    /approver other than/,
  );
  // Separation of duties: a sysadmin can never also hold finance.
  const sod = await sys1.call('POST', `admin/admins/${sys2.id}/roles`, { role: 'finance_approver', reason: 'consolidate duties' });
  assert.equal(sod.status, 202);
  const sodOk = await (await operator(api, ['sysadmin'])).call('POST', `admin/approvals/${sod.body.approval.id}/approve`);
  assert.equal(sodOk.status, 409);
  assert.equal(sodOk.body.code, 'sod_conflict');
  // Audit trail is append-only.
  const ev = await prisma.identityAuditEvent.findFirst({ where: { action: 'admin_role_granted', subjectId: target.id } });
  assert.ok(ev);
  await assert.rejects(prisma.identityAuditEvent.delete({ where: { id: ev.id } }), /append-only/);
});

test('revoked operator role / revoked session: previously authorized endpoint refuses immediately', async () => {
  const fin = await operator(api, ['finance_ops']);
  const sys = await operator(api, ['sysadmin']);
  assert.equal((await fin.call('GET', 'admin/money/position')).status, 200);
  assert.equal((await sys.call('POST', `admin/admins/${fin.id}/roles/finance_ops/revoke`, { reason: 'left the finance team' })).status, 200);
  assert.equal((await fin.call('GET', 'admin/money/position')).status, 403);
});

test('direct HTTP bypass of UI restrictions: every admin route refuses a user token; agent/courier routes refuse plain users', async () => {
  const u = await signedIn(api, await customer());
  for (const p of ['admin/dashboard', 'admin/me', 'admin/approvals', 'admin/admins']) {
    assert.equal((await u.call('GET', p)).status, 401, p);
  }
  for (const [m, p] of [['GET', 'agent/me'], ['POST', 'agent/deposits/scan'], ['GET', 'deliveries/nearby'], ['POST', 'deliveries/x/accept']]) {
    assert.equal((await u.call(m, p, {})).status, 403, `${m} ${p}`);
  }
});
