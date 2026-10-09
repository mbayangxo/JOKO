/**
 * J11 collective money over real HTTP: dark by default, authorization boundaries, operator separation
 * (ruling ≠ money execution), freeze, step-up, and a full tontine through the API.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { customer, operator, signedIn, stepUp } from '../j3/helpers.js';
import { checkCollectiveInvariants } from '../../lib/collective/invariants.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';

let on;
let off;
before(async () => { [on, off] = await Promise.all([startApiServer({ JOKKO_COLLECTIVE_ENABLED: 'true' }), startApiServer()]); });
after(async () => {
  await Promise.all([on?.stop(), off?.stop()]);
  const r = await checkCollectiveInvariants();
  assert.ok(r.ok, JSON.stringify(r.violations));
  await assertInvariants(prisma);
  await prisma.$disconnect();
});

const ok = (r, msg = '') => { assert.ok(r.status < 300, `${msg} ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const bal = async (u) => (await prisma.wallet.findUnique({ where: { userId: u.id } })).koriBalance;
const key = () => ({ headers: { 'idempotency-key': crypto.randomBytes(8).toString('hex') } });
async function members(n, kori = 20_000) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(await signedIn(on, await customer({ koriBalance: kori })));
  return out;
}
async function activeGroup(us, { contributionKori = 1000, order = null } = {}) {
  const [org, ...rest] = us;
  const g = ok(await org.call('POST', 'collective/groups', { kind: 'rotating', name: 'Natt du quartier', contributionKori, frequency: 'weekly', rotationMethod: order ? 'fixed' : 'draw' }), 'create');
  ok(await org.call('POST', `collective/groups/${g.id}/invite`, { handles: rest.map((u) => u.handle) }));
  for (const u of rest) ok(await u.call('POST', `collective/groups/${g.id}/respond`, { accept: true }));
  const p = ok(await org.call('POST', `collective/groups/${g.id}/rules`, { order: order?.map((u) => u.handle), startAt: new Date(Date.now() + 2000).toISOString() }));
  for (const u of us) ok(await u.call('POST', `collective/groups/${g.id}/rules/accept`, { rulesHash: p.rulesHash }), 'accept');
  return g.id;
}

test('dark by default: without the flag every collective route answers 503 and nothing is created', async () => {
  const u = await signedIn(off, await customer({}));
  assert.equal((await u.call('GET', 'collective/groups')).status, 503);
  assert.equal((await u.call('POST', 'collective/groups', { kind: 'rotating', name: 'xxx', contributionKori: 100, frequency: 'weekly' })).status, 503);
});

test('a full tontine through the API; outsiders see nothing; nobody can name a recipient', async () => {
  const us = await members(3);
  const [org, a, b] = us;
  const id = await activeGroup(us, { order: [b, a, org] });
  const outsider = (await members(1))[0];
  assert.equal((await outsider.call('GET', `collective/groups/${id}`)).status, 404, 'a group is private to its members');
  assert.equal((await outsider.call('POST', `collective/groups/${id}/contribute`, {}, key())).status, 404);
  assert.equal((await a.call('POST', `collective/groups/${id}/invite`, { handles: [outsider.handle] })).status, 403, 'only the organizer invites');
  assert.equal((await org.call('POST', `collective/groups/${id}/invite`, { handles: [outsider.handle] })).status, 409, 'membership is locked after activation');
  assert.equal((await org.call('POST', `collective/groups/${id}/contribute`, { recipientId: org.id }, key())).status, 400, 'no client-chosen recipient');
  const view = ok(await a.call('GET', `collective/groups/${id}`));
  assert.equal(view.schedule[0].recipient.handle, b.handle);
  assert.equal(view.myDue[0].dueKori, 1000);
  const before = await Promise.all(us.map(bal));
  for (let c = 0; c < 3; c += 1) for (const u of us) ok(await u.call('POST', `collective/groups/${id}/contribute`, {}, key()), `cycle ${c + 1}`);
  assert.deepEqual(await Promise.all(us.map(bal)), before);
  const done = ok(await org.call('GET', `collective/groups/${id}`));
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.schedule.map((s) => s.recipient.handle), [b.handle, a.handle, org.handle]);
  assert.equal(done.history.filter((h) => h.kind === 'payout').length, 3);
});

test('dispute → operator ruling → a DIFFERENT finance operator executes; collective_ops never moves money', async () => {
  const us = await members(3);
  const [org, a, b] = us;
  const id = await activeGroup(us, { order: [b, a, org] });
  ok(await org.call('POST', `collective/groups/${id}/contribute`, {}, key()));
  ok(await a.call('POST', `collective/groups/${id}/disputes`, { reason: 'Le compte de b semble piraté, il ne répond plus' }));
  ok(await b.call('POST', `collective/groups/${id}/contribute`, {}, key()));
  ok(await a.call('POST', `collective/groups/${id}/contribute`, {}, key()));
  assert.equal((await prisma.collectivePayout.count({ where: { groupId: id } })), 0, 'an open dispute holds the payout even when the cycle is complete');
  assert.equal((await a.call('POST', `collective/groups/${id}/release`)).status, 409);

  const ops = await operator(on, ['collective_ops']);
  const tns = await operator(on, ['trust_safety']);
  const fin = await operator(on, ['finance_ops']);
  assert.equal((await tns.call('GET', 'admin/collective/disputes')).status, 403, 'moderators have no collective access');
  const q = ok(await ops.call('GET', 'admin/collective/disputes'));
  const d = q.disputes.find((x) => x.groupId === id);
  assert.ok(d);
  const detail = ok(await ops.call('GET', `admin/collective/groups/${id}`));
  assert.ok(!JSON.stringify(detail).includes(a.phone), 'operator view carries no phone numbers');
  const ruled = ok(await ops.call('POST', `admin/collective/disputes/${d.id}/rule`, { outcome: 'skip_recipient', note: 'Compte du bénéficiaire compromis, tour suspendu' }));
  assert.ok(ruled.approval?.id);
  assert.equal((await ops.call('POST', `admin/approvals/${ruled.approval.id}/approve`)).status, 403, 'the ruling operator cannot execute');
  const before = await Promise.all(us.map(bal));
  ok(await fin.call('POST', `admin/approvals/${ruled.approval.id}/approve`));
  const after_ = await Promise.all(us.map(bal));
  assert.deepEqual(after_.map((x, i) => x - before[i]), [1000, 1000, 1000], 'the cycle pot went back to each payer, exactly');
  assert.equal((await fin.call('POST', `admin/approvals/${ruled.approval.id}/approve`)).status < 300, true, 'replay is a no-op');
  assert.deepEqual(await Promise.all(us.map(bal)), after_);
  const v = ok(await a.call('GET', `collective/groups/${id}`));
  assert.equal(v.members.find((m) => m.handle === b.handle).status, 'removed');
  assert.equal(v.currentCycle, 2);
});

test('freeze stops money; only a different operator unfreezes', async () => {
  const us = await members(2);
  const [org, a] = us;
  const id = await activeGroup(us);
  const op1 = await operator(on, ['collective_ops']);
  const op2 = await operator(on, ['collective_ops']);
  ok(await op1.call('POST', `admin/collective/groups/${id}/freeze`, { reason: 'Signalement de fraude en cours' }));
  assert.equal((await a.call('POST', `collective/groups/${id}/contribute`, {}, key())).status, 423);
  assert.equal((await op1.call('POST', `admin/collective/groups/${id}/unfreeze`, { reason: 'Vérification terminée, rien trouvé' })).status, 403);
  ok(await op2.call('POST', `admin/collective/groups/${id}/unfreeze`, { reason: 'Vérification terminée, rien trouvé' }));
  ok(await a.call('POST', `collective/groups/${id}/contribute`, {}, key()));
  assert.equal((await org.call('GET', `collective/groups/${id}`)).body.frozen, false);
});

test('large contributions need a fresh PIN step-up', async () => {
  const us = await members(2, 200_000);
  const [org, a] = us;
  const id = await activeGroup(us, { contributionKori: 50_000 }); // 500 000 XOF
  const r = await a.call('POST', `collective/groups/${id}/contribute`, {}, key());
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'step_up_required');
  await stepUp(a);
  ok(await a.call('POST', `collective/groups/${id}/contribute`, {}, key()));
  assert.ok(org);
});
