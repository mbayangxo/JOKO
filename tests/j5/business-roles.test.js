/**
 * J5 — business identity, roles and authority over real HTTP
 * (NODE_ENV=production, real OTP logins). Roles are capability sets; the
 * matrix below is exercised route by route. J2 invariants after each test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { BUSINESS_CAPABILITIES, BUSINESS_ROLES } from '../../lib/authz/catalog.js';
import { business, customer, operator, signedIn } from '../j3/helpers.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

async function team(roles) {
  const owner = await customer();
  const people = {};
  for (const r of roles) people[r] = await customer();
  const b = await business(owner.user, roles.map((r) => ({ user: people[r].user, role: r })));
  const s = { owner: await signedIn(api, owner) };
  for (const r of roles) s[r] = await signedIn(api, people[r]);
  return { b, s, people, owner };
}

test('legacy J3 roles keep exactly their authority; new roles are explicit capability sets; owner is not a grantable role', () => {
  assert.deepEqual(BUSINESS_CAPABILITIES['business.treasury'].sort(), ['admin', 'ceo', 'cfo', 'finance', 'owner'].sort());
  assert.deepEqual(BUSINESS_CAPABILITIES['business.pay'].sort(), ['admin', 'ceo', 'cfo', 'finance', 'hr_admin', 'owner'].sort());
  assert.ok(!BUSINESS_ROLES.cashier.caps.includes('business.pay'), 'a cashier never gets payroll');
  assert.ok(!BUSINESS_ROLES.cashier.caps.includes('business.payroll.read'));
  assert.ok(!BUSINESS_ROLES.cashier.caps.includes('business.members.manage'));
  assert.ok(!BUSINESS_ROLES.manager.caps.includes('business.treasury'), 'a manager does not move money out');
  assert.ok(!('owner' in BUSINESS_ROLES), 'ownership is Business.ownerId, never a member role');
});

test('capability matrix over HTTP: cashier / inventory / fulfillment / finance / manager / viewer', async () => {
  const { b, s } = await team(['cashier', 'inventory', 'fulfillment', 'finance', 'manager', 'viewer']);
  const P = `businesses/${b.id}/os`;
  const can = async (who, method, path, body) => (await s[who].call(method, path, body)).status;
  const ok = (st) => st >= 200 && st < 300;

  // Catalog create: inventory / manager / owner yes; cashier, fulfillment, finance, viewer no.
  const item = { title: 'Thiéboudienne', priceKori: 150, initialStock: 5 };
  for (const who of ['inventory', 'manager', 'owner']) assert.ok(ok(await can(who, 'POST', `${P}/catalog`, item)), who);
  for (const who of ['cashier', 'fulfillment', 'finance', 'viewer']) assert.equal(await can(who, 'POST', `${P}/catalog`, item), 403, who);

  // Accept payments (charge QR): cashier / manager / owner.
  for (const who of ['cashier', 'manager', 'owner']) assert.equal(await can(who, 'POST', 'money/charges', { businessId: b.id, amountKori: 100 }), 201, who);
  for (const who of ['inventory', 'fulfillment', 'viewer']) assert.equal(await can(who, 'POST', 'money/charges', { businessId: b.id, amountKori: 100 }), 403, who);

  // Business money: balance only for finance/owner; manager sees activity without balance; cashier nothing.
  const fin = await s.finance.call('GET', `${P}/money`);
  assert.equal(fin.status, 200);
  assert.ok(fin.body.balance);
  const mgr = await s.manager.call('GET', `${P}/money`);
  assert.equal(mgr.status, 200);
  assert.equal(mgr.body.balance, null, 'no balance for a role without wallet.read');
  for (const who of ['cashier', 'inventory', 'fulfillment', 'viewer']) assert.equal(await can(who, 'GET', `${P}/money`), 403, who);

  // Payroll: never cashier / manager / inventory / fulfillment / viewer.
  for (const who of ['cashier', 'manager', 'inventory', 'fulfillment', 'viewer']) {
    assert.equal(await can(who, 'GET', `businesses/${b.id}/payroll/employees`), 403, who);
  }
  assert.equal(await can('finance', 'GET', `businesses/${b.id}/payroll/employees`), 200);

  // Analytics: manager / finance / owner. Customers: manager / fulfillment / owner.
  for (const who of ['manager', 'finance', 'owner']) assert.equal(await can(who, 'GET', `${P}/analytics`), 200, who);
  for (const who of ['cashier', 'inventory', 'fulfillment', 'viewer']) assert.equal(await can(who, 'GET', `${P}/analytics`), 403, who);
  for (const who of ['manager', 'fulfillment', 'owner']) assert.equal(await can(who, 'GET', `${P}/customers`), 200, who);
  for (const who of ['cashier', 'finance', 'viewer']) assert.equal(await can(who, 'GET', `${P}/customers`), 403, who);

  // Profile edits / settlement / verification request.
  assert.equal(await can('manager', 'PATCH', `${P}/profile`, { description: 'Ouvert 7j/7' }), 200);
  assert.equal(await can('cashier', 'PATCH', `${P}/profile`, { description: 'x' }), 403);
  assert.equal(await can('manager', 'POST', `${P}/settlement`, {}), 403, 'settlement is owner-only');
  assert.equal(await can('finance', 'POST', `${P}/verification`, {}), 403, 'verification request is owner-only');

  // Own capabilities are visible to drive the UI; a stranger gets nothing.
  const acc = await s.cashier.call('GET', `${P}/access`);
  assert.deepEqual(acc.body.roles, ['cashier']);
  assert.ok(acc.body.capabilities.includes('business.charges.create'));
  const stranger = await signedIn(api, await customer());
  for (const path of ['access', 'profile', 'catalog', 'orders', 'money', 'analytics', 'customers', 'today', 'charges']) {
    assert.ok([403, 404].includes((await stranger.call('GET', `${P}/${path}`)).status), path);
  }
});

test('membership lifecycle: invite → accept → role change → remove; owner-only roles; no self-promotion; history kept', async () => {
  const { b, s, people } = await team(['manager']);
  const staff = await customer();
  const staffS = await signedIn(api, staff);
  const P = `businesses/${b.id}`;

  // Manager invites a cashier; cannot grant owner-only roles.
  const inv = await s.manager.call('POST', `${P}/members`, { userHandle: staff.handle, role: 'cashier' });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  assert.equal((await s.manager.call('POST', `${P}/members`, { userHandle: staff.handle, role: 'finance' })).status, 403);
  assert.equal((await s.manager.call('POST', `${P}/members`, { userHandle: staff.handle, role: 'owner' })).status, 400, 'owner is not a grantable role');

  // Invited = no authority yet.
  assert.equal((await staffS.call('POST', 'money/charges', { businessId: b.id, amountKori: 100 })).status, 403);
  // Only the invitee accepts; a forged accept by someone else fails.
  assert.equal((await s.manager.call('POST', `${P}/members/${inv.body.id}/accept`, {})).status, 404);
  assert.equal((await staffS.call('POST', `${P}/members/${inv.body.id}/accept`, {})).status, 200);
  assert.equal((await staffS.call('POST', 'money/charges', { businessId: b.id, amountKori: 100 })).status, 201);

  // Role change: manager → inventory OK; to finance is owner-only; nobody changes their own role.
  const toInv = await s.manager.call('POST', `${P}/members/${inv.body.id}/role`, { role: 'inventory', reason: 'réorganisation' });
  assert.equal(toInv.status, 200, JSON.stringify(toInv.body));
  assert.equal((await staffS.call('POST', 'money/charges', { businessId: b.id, amountKori: 100 })).status, 403, 'the old role’s authority is gone');
  assert.equal((await s.manager.call('POST', `${P}/members/${toInv.body.id}/role`, { role: 'finance' })).status, 403);
  const mgrRow = await prisma.businessMember.findFirst({ where: { businessId: b.id, userId: people.manager.id, status: 'active' } });
  assert.equal((await s.manager.call('POST', `${P}/members/${mgrRow.id}/role`, { role: 'finance' })).status, 403, 'no self-promotion');
  assert.equal((await s.owner.call('POST', `${P}/members/${toInv.body.id}/role`, { role: 'finance' })).status, 200, 'owner may grant finance');

  // Removal: immediate; rows and audit trail remain.
  const finRow = await prisma.businessMember.findFirst({ where: { businessId: b.id, userId: staff.id, status: 'active' } });
  assert.equal((await s.owner.call('POST', `${P}/members/${finRow.id}/remove`, { reason: 'départ' })).status, 200);
  assert.equal((await staffS.call('GET', `${P}/os/money`)).status, 403, 'removed employee has no authority');
  const rows = await prisma.businessMember.findMany({ where: { businessId: b.id, userId: staff.id }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(rows.map((r) => [r.role, r.status]), [['cashier', 'removed'], ['inventory', 'removed'], ['finance', 'removed']]);
  assert.match(rows[0].removedReason, /role_changed:inventory/);
  const events = await prisma.identityAuditEvent.findMany({ where: { subjectType: 'business', subjectId: b.id }, orderBy: { createdAt: 'asc' } });
  assert.ok(['business_member_invited', 'business_member_accepted', 'business_member_role_changed', 'business_member_removed'].every((a) => events.some((e) => e.action === a)));
});

test('business identity: profile, locations, settlement switch (owner, one-way), verification decided only by operators', async () => {
  const { b, s } = await team(['manager']);
  const P = `businesses/${b.id}/os`;
  const prof = await s.owner.call('GET', `${P}/profile`);
  assert.equal(prof.status, 200);
  assert.equal(prof.body.locations.filter((l) => l.isPrimary).length, 1, 'a primary location exists');
  assert.equal(prof.body.verification.status, 'unverified');
  const loc = await s.manager.call('POST', `${P}/locations`, { name: 'Boutique Plateau', address: 'Plateau, Dakar' });
  assert.equal(loc.status, 201);
  assert.equal((await s.manager.call('PATCH', `${P}/locations/${prof.body.locations[0].id}`, { active: false })).status, 409, 'the primary location stays');

  // Legacy owner-personal settlement → owner switches to the business wallet; no way back.
  await prisma.business.update({ where: { id: b.id }, data: { settlementMode: 'owner' } });
  assert.equal((await s.owner.call('POST', `${P}/settlement`, {})).body.mode, 'business');
  assert.equal((await prisma.business.findUnique({ where: { id: b.id } })).settlementMode, 'business');

  // The business cannot verify itself; only an operator with merchants.verify.
  assert.equal((await s.owner.call('POST', `${P}/verification`, { note: 'NINEA joint' })).body.status, 'pending');
  const support = await operator(api, ['support']);
  const compliance = await operator(api, ['compliance']);
  assert.equal((await support.call('POST', `admin/businesses/${b.id}/verification`, { decision: 'verified', note: 'docs ok' })).status, 403);
  const d = await compliance.call('POST', `admin/businesses/${b.id}/verification`, { decision: 'verified', note: 'documents vérifiés' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const after = await prisma.business.findUnique({ where: { id: b.id } });
  assert.equal(after.verified, true);
  assert.equal(after.verificationStatus, 'verified');
  assert.equal((await s.owner.call('PATCH', `${P}/profile`, { verified: true, verificationStatus: 'verified' })).status, 200);
  assert.equal((await prisma.business.findUnique({ where: { id: b.id } })).verifiedBy, compliance.id, 'profile edits cannot touch verification fields');
});

test('no arbitrary user can claim or take over another business', async () => {
  const { b } = await team([]);
  const intruder = await signedIn(api, await customer());
  assert.equal((await intruder.call('POST', `businesses/${b.id}/members`, { userHandle: intruder.handle, role: 'manager' })).status, 403, 'cannot invite oneself');
  assert.equal((await intruder.call('PATCH', `businesses/${b.id}/os/profile`, { name: 'Volé' })).status, 403);
  assert.equal((await intruder.call('POST', `businesses/${b.id}/os/settlement`, {})).status, 403);
  // Accepting someone else's pending invitation (forged accept) does nothing.
  const victim = await customer();
  const inv = await prisma.businessMember.create({ data: { businessId: b.id, userId: victim.id, role: 'manager', status: 'invited' } });
  assert.equal((await intruder.call('POST', `businesses/${b.id}/members/${inv.id}/accept`, {})).status, 404);
  assert.equal((await prisma.businessMember.findUnique({ where: { id: inv.id } })).status, 'invited');
  assert.equal((await intruder.call('GET', `businesses/${b.id}/os/orders`)).status, 403);
});
