/**
 * J13-F5 follow-up — notification routing never bypasses access control. A notification only carries
 * (kind, refId); the destination screen loads the resource through the same authenticated endpoint as
 * any other navigation, so the server decides. Proven here for every refId-bearing route and for the
 * notifications themselves: cross-account, unauthorized, deleted and expired/closed resources.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { customer, signedIn } from '../j3/helpers.js';
import { routeForKind, inferKind } from '../../src/lib/notification-route.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const hex = () => crypto.randomBytes(3).toString('hex');
async function parcelOf(ownerId) {
  const hub = await prisma.deliveryHub.create({ data: { name: `Point ${hex()}`, code: `PT-${hex()}`, address: 'Rue 3', city: 'Dakar', lat: 14.7, lng: -17.4 } });
  return prisma.hubParcel.create({ data: { reference: `HP-${hex()}`, ownerId, hubId: hub.id, status: 'at_hub', originCountry: 'FR', description: 'Colis privé', pickupCode: '654321' } });
}

test('a parcel notification pointing at SOMEONE ELSE\'s parcel opens nothing of theirs (403), a deleted one 404', async () => {
  const a = await customer();
  const A = await signedIn(api, a);
  const b = await customer();
  const theirs = await parcelOf(b.id);
  // Even a notification row crafted to point at B's parcel only yields a route…
  const r = routeForKind(inferKind({ kind: 'hub_parcel' }), theirs.id);
  assert.equal(r.target, 'HubParcelDetail');
  assert.deepEqual(r.targetParams, { parcelId: theirs.id });
  // …and the screen's load is refused by the server: no reference, pickup code or description leaks.
  const got = await A.call('GET', `hubs/parcels/${theirs.id}`);
  assert.equal(got.status, 403);
  assert.ok(!JSON.stringify(got.body).includes('654321') && !JSON.stringify(got.body).includes(theirs.reference));
  // Well-formed bodies (the CORRECT pickup code included), so the authorization check — not body
  // validation — is what refuses.
  const bodies = { 'in-transit': {}, pickup: { pickupCode: '654321' }, 'last-mile': { area: 'Plateau', address: 'Rue 10' }, arrive: {} };
  for (const [action, body] of Object.entries(bodies)) {
    const w = await A.call('POST', `hubs/parcels/${theirs.id}/${action}`, body);
    assert.ok([403, 404, 409, 410].includes(w.status), `${action}: ${w.status} ${JSON.stringify(w.body)}`);
  }
  assert.equal((await prisma.hubParcel.findUnique({ where: { id: theirs.id } })).status, 'at_hub', 'nothing changed');
  const mine = await parcelOf(a.id);
  assert.equal((await A.call('GET', `hubs/parcels/${mine.id}`)).status, 200, 'the owner still opens their own');
  await prisma.hubParcel.delete({ where: { id: mine.id } });
  assert.equal((await A.call('GET', `hubs/parcels/${mine.id}`)).status, 404, 'deleted → not found');
});

test('a Jëkkal notification to a private (awaiting-beneficiary / declined) campaign does not reveal it', async () => {
  const A = await signedIn(api, await customer());
  const creator = await customer();
  for (const status of ['pending_beneficiary', 'declined']) {
    const c = await prisma.solidarityCampaign.create({ data: { creatorId: creator.id, beneficiaryUserId: creator.id, title: `Privé ${hex()}`, goalAmount: 10_000, status } });
    const got = await A.call('GET', `jekkal/campaigns/${c.id}`);
    assert.equal(got.status, 404, `${status}: ${got.status}`);
  }
  assert.equal((await A.call('GET', `jekkal/campaigns/does-not-exist-${hex()}`)).status, 404);
});

test('a closed (expired) campaign reached from a notification cannot take money', async () => {
  const a = await customer({ koriBalance: 0 });
  await fundUser(a.id, 10_000);
  const A = await signedIn(api, a);
  const creator = await customer();
  const c = await prisma.solidarityCampaign.create({ data: { creatorId: creator.id, beneficiaryUserId: creator.id, title: `Fini ${hex()}`, goalAmount: 10_000, status: 'closed' } });
  const before = await prisma.wallet.findUnique({ where: { userId: a.id } });
  const r = await A.call('POST', `jekkal/campaigns/${c.id}/contribute`, { amount: 1000 }, { headers: { 'idempotency-key': `intent-${hex()}${hex()}` } });
  assert.ok(r.status >= 400 && r.status < 500, `${r.status} ${JSON.stringify(r.body)}`);
  const after_ = await prisma.wallet.findUnique({ where: { userId: a.id } });
  assert.equal(after_.balance + after_.koriBalance, before.balance + before.koriBalance, 'no money moved');
  assert.equal(await prisma.solidarityContribution.count({ where: { campaignId: c.id } }), 0);
});

test('notifications are per-account: B\'s notifications are never listed for A, and A cannot mark them read', async () => {
  const a = await customer();
  const A = await signedIn(api, a);
  const b = await customer();
  const secret = `Facture privée ${hex()}`;
  const n = await prisma.notification.create({ data: { userId: b.id, title: secret, body: 'x', kind: 'trade_invoice', category: 'money' } });
  for (const path of ['notifications', 'notifications/feed']) {
    const list = await A.call('GET', path);
    assert.equal(list.status, 200);
    assert.ok(!JSON.stringify(list.body).includes(secret), `${path} leaks another account's notification`);
  }
  const mark = await A.call('POST', `notifications/${n.id}/read`, {});
  assert.ok([403, 404].includes(mark.status) || mark.body?.count === 0, `mark: ${mark.status} ${JSON.stringify(mark.body)}`);
  const row = await prisma.notification.findUnique({ where: { id: n.id } });
  assert.equal(Boolean(row.readAt ?? row.read), false, 'B\'s notification is untouched');
});

test('list routes carry no resource id — the destination always loads the viewer\'s own data', () => {
  for (const kind of ['marketplace_order', 'low_stock', 'support_ticket', 'trade_invoice', 'scheduled_payment', 'agent_float', 'business_invitation']) {
    const r = routeForKind(inferKind({ kind }), 'someone-elses-id');
    assert.ok(r, kind);
    assert.equal(r.targetParams, undefined, `${kind} must not forward a foreign id`);
  }
});
