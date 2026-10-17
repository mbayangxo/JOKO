/**
 * J6.1 / J6.2 — agent identity & lifecycle, organizations, service points,
 * operator separation. Real HTTP, production mode.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { business, customer, operator, signedIn } from '../j3/helpers.js';
import { activeAgent } from './helpers.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const SP = { name: 'Kiosque Liberté', publicAddress: 'Rond-point Liberté 6, face pharmacie', area: 'Liberté 6', hours: { mon: [['08:00', '20:00']] } };

test('application → identity → review → maker-checker activation; no self-activation; float never activates; every step attributed', async () => {
  const u = await signedIn(api, await customer({ tier: 2 }));
  const apply = await u.call('POST', 'agent/apply', { displayName: 'Point Liberté', servicePoint: SP });
  assert.equal(apply.status, 201, JSON.stringify(apply.body));
  assert.equal(apply.body.agent.status, 'applied');
  const id = apply.body.agent.id;
  assert.equal(await prisma.accountRole.count({ where: { userId: u.id, role: 'agent', status: 'active' } }), 0, 'no role on application');
  assert.equal((await u.call('POST', 'roles/agent')).status, 403, 'cannot self-assign');
  assert.equal((await u.call('POST', 'agent/cash/scan', { qr: 'x'.repeat(24) })).status, 403);

  const fin = await operator(api, ['finance_ops']);
  await fin.call('POST', `admin/agents/${id}/float`, { amountXof: 50_000, note: 'early float' });
  assert.equal((await prisma.agentProfile.findUnique({ where: { id } })).status, 'applied', 'float never activates');

  const support = await operator(api, ['support']);
  const c1 = await operator(api, ['compliance']);
  const c2 = await operator(api, ['compliance']);
  const c3 = await operator(api, ['compliance']);
  assert.equal((await support.call('POST', `admin/agents/${id}/verify-identity`, {})).status, 403);
  assert.equal((await c1.call('POST', `admin/agents/${id}/approve`, { reason: 'looks fine' })).body.code, 'invalid_transition', 'review needs identity first');
  assert.equal((await c1.call('POST', `admin/agents/${id}/verify-identity`, {})).body.agent.status, 'under_review');
  assert.equal((await c1.call('POST', `admin/agents/${id}/approve`, { reason: 'premises visited' })).body.code, 'same_operator', 'the verifier does not approve');
  assert.equal((await c2.call('POST', `admin/agents/${id}/approve`, { reason: 'premises visited' })).body.agent.status, 'approved');
  // Activation needs an approved service point.
  const act = await c3.call('POST', `admin/agents/${id}/activate`, { reason: 'ready to operate at kiosk' });
  assert.equal(act.status, 202, JSON.stringify(act.body));
  const c4 = await operator(api, ['compliance']);
  const early = await c4.call('POST', `admin/approvals/${act.body.approval.id}/approve`, {});
  assert.equal(early.body.code, 'service_point_required', JSON.stringify(early.body));
  const prof = await prisma.agentProfile.findUnique({ where: { id } });
  await c1.call('POST', `admin/service-points/${prof.servicePointId}/status`, { status: 'active', reason: 'premises visited' });
  const act2 = await c3.call('POST', `admin/agents/${id}/activate`, { reason: 'ready to operate at kiosk' });
  assert.equal((await c3.call('POST', `admin/approvals/${act2.body.approval.id}/approve`, {})).status, 403, 'requester cannot approve');
  assert.equal((await c2.call('POST', `admin/approvals/${act2.body.approval.id}/approve`, {})).body.code, 'same_operator', 'the approver of the review cannot also activate');
  const ok = await c4.call('POST', `admin/approvals/${act2.body.approval.id}/approve`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const agent = await prisma.agentProfile.findUnique({ where: { id } });
  assert.equal(agent.status, 'active');
  assert.equal(agent.identityVerifiedBy, c1.id);
  assert.equal(agent.approvedBy, c2.id);
  assert.equal(agent.activatedBy, c4.id);
  const events = await prisma.agentStatusEvent.findMany({ where: { agentId: id }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(events.map((e) => e.toStatus), ['applied', 'under_review', 'approved', 'active']);
  await assert.rejects(prisma.agentStatusEvent.update({ where: { id: events[0].id }, data: { toStatus: 'active' } }), 'append-only');
  // Status cannot be patched.
  const mgr = await operator(api, ['compliance']);
  assert.equal((await mgr.call('PATCH', `admin/agents/${id}`, { status: 'suspended' })).status, 400);
});

test('identity: an unverified applicant cannot pass; a business agent needs an OWNED, VERIFIED business — staff cannot enrol it', async () => {
  const t1 = await signedIn(api, await customer({ tier: 1 }));
  const a = await t1.call('POST', 'agent/apply', { displayName: 'Point Tier1', servicePoint: SP });
  const c1 = await operator(api, ['compliance']);
  assert.equal((await c1.call('POST', `admin/agents/${a.body.agent.id}/verify-identity`, {})).body.code, 'identity_unverified');

  const owner = await customer({ tier: 2 });
  const mgr = await customer({ tier: 2 });
  const b = await business(owner.user, [{ user: mgr.user, role: 'manager' }]);
  const ms = await signedIn(api, mgr);
  const byStaff = await ms.call('POST', 'agent/apply', { displayName: 'Réseau', agentType: 'business', businessId: b.id, servicePoint: SP });
  assert.equal(byStaff.status, 403, 'a manager cannot turn the business into an agent network');
  const os = await signedIn(api, owner);
  const byOwner = await os.call('POST', 'agent/apply', { displayName: 'Réseau', agentType: 'business', businessId: b.id, servicePoint: SP });
  assert.equal(byOwner.status, 201);
  assert.equal((await c1.call('POST', `admin/agents/${byOwner.body.agent.id}/verify-identity`, {})).body.code, 'business_unverified');
  await prisma.business.update({ where: { id: b.id }, data: { verificationStatus: 'verified', verified: true } });
  assert.equal((await c1.call('POST', `admin/agents/${byOwner.body.agent.id}/verify-identity`, {})).status, 200);
  // The agent's float is never the business wallet.
  const org = await prisma.agentOrganization.findUnique({ where: { businessId: b.id } });
  assert.equal(org.kind, 'business');
  assert.equal(await prisma.ledgerAccount.count({ where: { code: `agent:${byOwner.body.agent.id}:float`, projTable: 'BusinessWallet' } }), 0);
});

test('service points: public places only, no precise coordinates, merchant assistance needs a separate permission', async () => {
  const u = await signedIn(api, await customer({ tier: 2 }));
  const home = await u.call('POST', 'agent/apply', { displayName: 'Chez moi', servicePoint: { name: 'Maison', publicAddress: 'Chez moi, appartement 3' } });
  assert.equal(home.body.code, 'private_address');
  const ok = await u.call('POST', 'agent/apply', { displayName: 'Point Grand Yoff', servicePoint: { ...SP, lat: 14.734567, lng: -17.456789 } });
  const prof = await prisma.agentProfile.findUnique({ where: { id: ok.body.agent.id } });
  const sp = await prisma.agentServicePoint.findUnique({ where: { id: prof.servicePointId } });
  assert.equal(sp.approxLat, 14.73);
  assert.equal(sp.approxLng, -17.46);
  assert.equal(prof.lat, 14.73, 'no precise coordinates kept on the profile either');
  assert.equal(sp.status, 'pending');
  assert.equal((await u.call('PATCH', `agent/service-points/${sp.id}`, { merchantAssist: true })).body.code, 'merchant_assist_not_permitted');
  const c = await operator(api, ['compliance']);
  await c.call('POST', `admin/service-points/${sp.id}/merchant-assist`, { permitted: true, reason: 'trained for onboarding' });
  assert.equal((await u.call('PATCH', `agent/service-points/${sp.id}`, { merchantAssist: true })).status, 200);
  const stranger = await signedIn(api, await customer());
  assert.equal((await stranger.call('PATCH', `agent/service-points/${sp.id}`, { cashOut: false })).status, 404);
  assert.equal((await u.call('PATCH', `agent/service-points/${sp.id}`, { hours: { mon: [['20:00', '08:00']] } })).body.code, 'invalid_hours');
});

test('an agent operates only at its own ACTIVE service point; a point deactivated mid-day cuts operations; another org’s point cannot be assigned', async () => {
  const ag = await activeAgent(api);
  const other = await activeAgent(api);
  const c = await operator(api, ['compliance']);
  const wrong = await c.call('POST', `admin/agents/${ag.profile.id}/service-point`, { servicePointId: other.profile.servicePointId, reason: 'move agent elsewhere' });
  assert.equal(wrong.body.code, 'wrong_organization');
  await c.call('POST', `admin/service-points/${ag.profile.servicePointId}/status`, { status: 'inactive', reason: 'premises closed for works' });
  const r = await ag.s.call('POST', 'agent/cash/scan', { qr: 'jokko://cash/AAAAAAAAAAAAAAAAAAAAAAAA' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'service_point_inactive');
});

test('suspension is immediate (role + profile); reactivation is maker-checker; termination is final', async () => {
  const ag = await activeAgent(api);
  const risk = await operator(api, ['risk']);
  const support = await operator(api, ['support']);
  assert.equal((await support.call('POST', `admin/agents/${ag.profile.id}/suspend`, { reason: 'x' })).status, 403);
  await risk.call('POST', `admin/agents/${ag.profile.id}/suspend`, { reason: 'float mismatch' });
  const cut = await ag.s.call('GET', 'agent/cash');
  assert.equal(cut.status, 403);
  assert.equal(cut.body.code, 'agent_required');
  const c1 = await operator(api, ['compliance']);
  const c2 = await operator(api, ['compliance']);
  const req = await c1.call('POST', `admin/agents/${ag.profile.id}/activate`, { reason: 'investigation closed, no issue' });
  assert.equal((await c2.call('POST', `admin/approvals/${req.body.approval.id}/approve`, {})).status, 200);
  assert.equal((await ag.s.call('GET', 'agent/cash')).status, 200);
  await c1.call('POST', `admin/agents/${ag.profile.id}/terminate`, { reason: 'network contract terminated' });
  const again = await c1.call('POST', `admin/agents/${ag.profile.id}/activate`, { reason: 'try to bring back' });
  const ap = await c2.call('POST', `admin/approvals/${again.body.approval?.id}/approve`, {});
  assert.equal(ap.body.code, 'invalid_transition', JSON.stringify(ap.body));
  assert.equal((await prisma.agentProfile.findUnique({ where: { id: ag.profile.id } })).status, 'terminated');
  const ev = await prisma.agentStatusEvent.findMany({ where: { agentId: ag.profile.id }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(ev.map((e) => e.toStatus).slice(-3), ['suspended', 'active', 'terminated']);
  assert.ok(ev.every((e) => e.actorId));
});
