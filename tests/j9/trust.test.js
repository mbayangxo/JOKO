/**
 * J9 worker identity & trust: worker-controlled profile and visibility, operator-verified
 * qualifications (never self-verified), staff authority boundaries, retired gig listings.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { assertWorkInvariants } from '../../lib/work/invariants.js';
import { operator } from '../j3/helpers.js';
import { member } from '../j7/fixture.js';
import { GIG, employer, hire, ok, post, worker } from './fixture.js';

let api;
before(async () => { api = await startApiServer({ JOKKO_WORK_MONEY_ENABLED: 'true' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => {
  await assertInvariants(prisma);
  await assertWorkInvariants(prisma);
});

test('profile is the worker’s own; qualifications are self-declared until a work operator verifies them', async () => {
  const w = await worker(api, { visibility: 'applications_only' });
  const prof = ok(await w.call('GET', 'work/profile'));
  assert.equal(prof.profile.visibility, 'applications_only');
  assert.equal((await w.call('PUT', 'work/profile', { nationality: 'x' })).status, 400, 'no protected-attribute fields exist');
  const q = ok(await w.call('POST', 'work/qualifications', { kind: 'licence', title: 'Permis A (moto)', issuer: 'Préfecture', evidenceRef: 'doc:permis-scan-ref' }));
  assert.equal(q.status, 'self_declared');
  const e = await employer(api);
  const opp = await post(e);
  ok(await w.call('POST', `work/opportunities/${opp.id}/apply`, {}));
  let card = ok(await e.owner.call('GET', `businesses/${e.b.id}/work/opportunities/${opp.id}/applicants`))[0].worker;
  assert.deepEqual(card.verifiedQualifications, [], 'self-declared is not shown as verified');
  const support = await operator(api, ['support']);
  assert.equal((await support.call('POST', `admin/work/qualifications/${q.id}/review`, { decision: 'verified' })).status, 403);
  const ops = await operator(api, ['work_ops']);
  assert.ok(ok(await ops.call('GET', 'admin/work/review')).qualifications.some((x) => x.id === q.id));
  ok(await ops.call('POST', `admin/work/qualifications/${q.id}/review`, { decision: 'verified', note: 'Permis contrôlé' }));
  assert.equal((await ops.call('POST', `admin/work/qualifications/${q.id}/review`, { decision: 'rejected' })).body.code, 'invalid_state');
  card = ok(await e.owner.call('GET', `businesses/${e.b.id}/work/opportunities/${opp.id}/applicants`))[0].worker;
  assert.deepEqual(card.verifiedQualifications, [{ kind: 'licence', title: 'Permis A (moto)' }]);
  assert.equal(card.rating, null, 'no rating shown without enough independent feedback');
});

test('staff boundaries: only members holding business.staffing.manage post or accept work; funding needs business.pay', async () => {
  const e = await employer(api);
  const cashier = await member(api, e.b, 'cashier');
  const driver = await member(api, e.b, 'fleet_driver');
  assert.equal((await cashier.call('POST', `businesses/${e.b.id}/work/opportunities`, GIG)).status, 403);
  assert.equal((await driver.call('GET', `businesses/${e.b.id}/work/assignments`)).status, 403);
  const mgr = await member(api, e.b, 'manager');
  const opp = ok(await mgr.call('POST', `businesses/${e.b.id}/work/opportunities`, GIG));
  const w = await worker(api);
  const app = ok(await w.call('POST', `work/opportunities/${opp.id}/apply`, {}));
  // A manager can post and screen, but funding a prepaid offer is a payment (business.pay).
  const { withStepUp } = await import('./fixture.js');
  assert.equal((await mgr.call('POST', `businesses/${e.b.id}/work/offers`, { applicationId: app.id, startDate: '2026-11-02', duties: 'Compter le stock du rayon.' }, await withStepUp(mgr))).status, 403);
  const { assignment } = await hire(api, e, await worker(api));
  assert.equal((await cashier.call('POST', `businesses/${e.b.id}/work/assignments/${assignment.id}/accept`, { seq: 1 })).status, 403);
});

test('gig listings are retired: work is never posted as a product (no prepaid poster, no terms, no evidence)', async () => {
  const e = await employer(api);
  const r = await e.owner.call('POST', 'products', { title: 'Je fais vos courses', price: 1000, category: 'gig', businessId: e.b.id });
  assert.equal(r.status, 410);
  assert.equal(r.body.code, 'gig_listing_retired');
  ok(await e.owner.call('GET', 'work/types'));
});
