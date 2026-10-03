/**
 * Tontine consent + escrow model — adversarial, over real HTTP with
 * NODE_ENV=production. `off` = production default (money movement disabled),
 * `on` = TONTINE_ESCROW_ENABLED=true (the model under test).
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

import { createUserWithWallet, createVerifiedDevice, establishedSessionToken, prisma } from '../helpers/db.js';
import { freshIp, startApiServer } from '../helpers/http-harness.js';

const ACCESS_SECRET = 'http-test-access-secret-0123456789';
let on;
let off;

before(async () => {
  [on, off] = await Promise.all([startApiServer({ TONTINE_ESCROW_ENABLED: 'true' }), startApiServer()]);
});
after(async () => {
  await Promise.all([on?.stop(), off?.stop()]);
  await prisma.$disconnect();
});

async function actor(koriBalance = 0) {
  const user = await createUserWithWallet({ koriBalance });
  const device = await createVerifiedDevice(user.id);
  const token = await establishedSessionToken(user.id, device, ACCESS_SECRET);
  return { user, id: user.id, handle: user.handle, device, token, ip: freshIp() };
}
const as = (a, headers = {}) => ({ token: a.token, device: a.device, ip: a.ip, headers: { 'x-vercel-ip-country': 'SN', ...headers } });
const bal = async (a) => (await prisma.wallet.findUnique({ where: { userId: a.id } })).koriBalance;
const pot = async (id) => (await prisma.tontineGroup.findUnique({ where: { id } })).potBalance;
const potLedgerSum = async (id) =>
  (await prisma.tontinePotEntry.aggregate({ where: { groupId: id }, _sum: { amountKori: true } }))._sum.amountKori ?? 0;

const call = (srv, method, path, a, opts = {}) => srv.client(method, path, { ...as(a, opts.headers), body: opts.body });

/** creator + N invitees; 10 000 XOF per member = 1 000 ₭ per cycle. */
async function group(srv, creator, invitees, amountPerMember = 10_000) {
  const r = await call(srv, 'POST', 'tontine/groups', creator, {
    body: { name: `T-${crypto.randomBytes(3).toString('hex')}`, amountPerMember, frequency: 'mensuel', memberHandles: invitees.map((i) => i.handle) },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}

async function activeGroup(members) {
  const [creator, ...rest] = members;
  const id = await group(on, creator, rest);
  for (const m of rest) assert.equal((await call(on, 'POST', `tontine/groups/${id}/accept`, m)).status, 200);
  const s = await call(on, 'POST', `tontine/groups/${id}/start`, creator);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return id;
}

test('invitation without acceptance: no debit, cannot contribute, and the creator cannot collect', async () => {
  const creator = await actor(5000);
  const invited = await actor(5000);
  const id = await group(on, creator, [invited]);
  const g = await call(on, 'GET', `tontine/groups/${id}`, invited);
  assert.equal(g.body.myStatus, 'invited');
  assert.equal(g.body.status, 'forming');

  assert.equal((await call(on, 'POST', `tontine/groups/${id}/contribute`, invited)).status, 409, 'group not active');
  const start = await call(on, 'POST', `tontine/groups/${id}/start`, creator);
  assert.equal(start.status, 409, 'cannot start with only the creator accepted');
  assert.equal((await call(on, 'POST', `tontine/groups/${id}/release`, creator)).status, 409);
  assert.equal(await bal(invited), 5000);
  assert.equal(await bal(creator), 5000);
});

test('non-accepted invitee is excluded from the rotation and can never be debited', async () => {
  const creator = await actor(5000);
  const yes = await actor(5000);
  const never = await actor(5000);
  const id = await group(on, creator, [yes, never]);
  await call(on, 'POST', `tontine/groups/${id}/accept`, yes);
  await call(on, 'POST', `tontine/groups/${id}/start`, creator);
  const g = await call(on, 'GET', `tontine/groups/${id}`, creator);
  assert.equal(g.body.memberCount, 2);
  const c = await call(on, 'POST', `tontine/groups/${id}/contribute`, never);
  assert.equal(c.status, 403);
  await call(on, 'POST', `tontine/groups/${id}/contribute`, creator);
  await call(on, 'POST', `tontine/groups/${id}/contribute`, yes);
  const r = await call(on, 'POST', `tontine/groups/${id}/release`, creator);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await bal(never), 5000, 'never-accepted invitee untouched');
});

test('forged membership: strangers cannot read, accept, contribute or release; nobody can accept for someone else', async () => {
  const creator = await actor(5000);
  const invited = await actor(5000);
  const stranger = await actor(5000);
  const id = await group(on, creator, [invited]);
  assert.equal((await call(on, 'GET', `tontine/groups/${id}`, stranger)).status, 403);
  assert.equal((await call(on, 'POST', `tontine/groups/${id}/accept`, stranger)).status, 403);
  // Body-injected identity is ignored — accept applies to the caller only.
  const forged = await call(on, 'POST', `tontine/groups/${id}/accept`, creator, { body: { userId: invited.id } });
  assert.equal(forged.status, 409, 'creator already accepted; cannot accept on behalf of invitee');
  const m = await prisma.tontineMembership.findUnique({ where: { groupId_userId: { groupId: id, userId: invited.id } } });
  assert.equal(m.status, 'invited');
  assert.equal((await call(on, 'POST', `tontine/groups/${id}/contribute`, stranger)).status, 409);
  assert.equal((await call(on, 'POST', `tontine/groups/${id}/release`, stranger)).status, 403);
});

test('creator cannot debit members: contributions are self-authorized and go to escrow, not the creator', async () => {
  const creator = await actor(5000);
  const m1 = await actor(5000);
  const id = await activeGroup([creator, m1]);
  await call(on, 'POST', `tontine/groups/${id}/contribute`, m1);
  assert.equal(await bal(m1), 4000);
  assert.equal(await bal(creator), 5000, 'creator wallet unchanged — money is in the pot');
  assert.equal(await pot(id), 1000);
  assert.equal(await potLedgerSum(id), 1000);
  // There is no endpoint that debits another member; the old auto-collect is gone.
  assert.equal((await call(on, 'POST', `tontine/groups/${id}/release`, creator)).status, 409, 'creator has not paid; cycle incomplete');
  assert.equal(await bal(m1), 4000);
});

test('early release refused while any contribution is missing; payout only to the scheduled recipient', async () => {
  const creator = await actor(5000);
  const m1 = await actor(5000);
  const m2 = await actor(5000);
  const id = await activeGroup([creator, m1, m2]);
  await call(on, 'POST', `tontine/groups/${id}/contribute`, creator);
  await call(on, 'POST', `tontine/groups/${id}/contribute`, m1);
  const early = await call(on, 'POST', `tontine/groups/${id}/release`, creator);
  assert.equal(early.status, 409);
  assert.equal(early.body.code, 'tontine_cycle_incomplete');
  await call(on, 'POST', `tontine/groups/${id}/contribute`, m2);
  // m2 triggers, but the recipient is fixed by rotation (creator first).
  const rel = await call(on, 'POST', `tontine/groups/${id}/release`, m2);
  assert.equal(rel.status, 200);
  assert.equal(rel.body.payout.recipientId, creator.id);
  assert.equal(await bal(creator), 5000 - 1000 + 3000);
  assert.equal(await bal(m2), 4000);
  assert.equal(await pot(id), 0);
  assert.equal(await potLedgerSum(id), 0);
});

test('insufficient funds: contribution refused, no partial state, cycle not payable', async () => {
  const creator = await actor(5000);
  const poor = await actor(500);
  const id = await activeGroup([creator, poor]);
  await call(on, 'POST', `tontine/groups/${id}/contribute`, creator);
  const r = await call(on, 'POST', `tontine/groups/${id}/contribute`, poor);
  assert.equal(r.status, 400);
  assert.equal(await bal(poor), 500);
  assert.equal(await prisma.tontineContribution.count({ where: { groupId: id, userId: poor.id } }), 0);
  assert.equal(await pot(id), 1000, 'only the creator’s own contribution is escrowed');
  assert.equal((await call(on, 'POST', `tontine/groups/${id}/release`, creator)).status, 409);
});

test('duplicate and concurrent contributions debit exactly once per cycle', async () => {
  const creator = await actor(5000);
  const m1 = await actor(5000);
  const id = await activeGroup([creator, m1]);
  const rs = await Promise.all(Array.from({ length: 6 }, () => call(on, 'POST', `tontine/groups/${id}/contribute`, m1)));
  assert.ok(rs.every((r) => [200, 409].includes(r.status)), JSON.stringify(rs.map((r) => r.status)));
  const again = await call(on, 'POST', `tontine/groups/${id}/contribute`, m1);
  assert.equal(again.status, 200);
  assert.equal(again.body.contribution.duplicate, true);
  assert.equal(await bal(m1), 4000);
  assert.equal(await prisma.tontineContribution.count({ where: { groupId: id, userId: m1.id } }), 1);
});

test('retry after network failure with the same Idempotency-Key replays; never double-debits', async () => {
  const creator = await actor(5000);
  const m1 = await actor(5000);
  const id = await activeGroup([creator, m1]);
  const key = `tc-${crypto.randomBytes(5).toString('hex')}`;
  const r1 = await call(on, 'POST', `tontine/groups/${id}/contribute`, m1, { headers: { 'idempotency-key': key } });
  const r2 = await call(on, 'POST', `tontine/groups/${id}/contribute`, m1, { headers: { 'idempotency-key': key } });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.contribution.reference, r1.body.contribution.reference);
  assert.equal(await bal(m1), 4000);
});

test('duplicate / concurrent payout: one payout per cycle, pot never paid twice', async () => {
  const a = await actor(5000);
  const b = await actor(5000);
  const c = await actor(5000);
  const id = await activeGroup([a, b, c]);
  for (const m of [a, b, c]) await call(on, 'POST', `tontine/groups/${id}/contribute`, m);
  const rs = await Promise.all([a, b, c, a, b].map((m) => call(on, 'POST', `tontine/groups/${id}/release`, m)));
  assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs.map((r) => [r.status, r.body.code])));
  assert.equal(await prisma.tontinePayout.count({ where: { groupId: id } }), 1);
  const total = (await bal(a)) + (await bal(b)) + (await bal(c)) + (await pot(id));
  assert.equal(total, 15000, 'value conserved');
  // Next cycle: nothing paid yet → payout refused.
  assert.equal((await call(on, 'POST', `tontine/groups/${id}/release`, a)).status, 409);
});

test('payout while a contribution is in flight: release and contribute race never pays an unfunded pot', async () => {
  const a = await actor(5000);
  const b = await actor(5000);
  const id = await activeGroup([a, b]);
  await call(on, 'POST', `tontine/groups/${id}/contribute`, a);
  const [contrib, rel] = await Promise.all([
    call(on, 'POST', `tontine/groups/${id}/contribute`, b),
    call(on, 'POST', `tontine/groups/${id}/release`, a),
  ]);
  assert.equal(contrib.status, 200);
  if (rel.status === 200) {
    assert.equal(rel.body.payout.amountKori, 2000, 'paid only after both contributions were escrowed');
  } else {
    assert.equal(rel.body.code, 'tontine_cycle_incomplete');
  }
  assert.equal((await bal(a)) + (await bal(b)) + (await pot(id)), 10000);
});

test('full rotation completes; every member paid exactly once; value conserved', async () => {
  const a = await actor(5000);
  const b = await actor(5000);
  const c = await actor(5000);
  const id = await activeGroup([a, b, c]);
  for (let cycle = 1; cycle <= 3; cycle++) {
    for (const m of [a, b, c]) assert.equal((await call(on, 'POST', `tontine/groups/${id}/contribute`, m)).status, 200);
    assert.equal((await call(on, 'POST', `tontine/groups/${id}/release`, b)).status, 200);
  }
  const g = await prisma.tontineGroup.findUnique({ where: { id } });
  assert.equal(g.status, 'completed');
  assert.deepEqual([await bal(a), await bal(b), await bal(c)], [5000, 5000, 5000]);
  assert.equal((await call(on, 'POST', `tontine/groups/${id}/contribute`, a)).status, 409, 'closed group takes no money');
});

test('leaving: allowed while forming, refused once active; creator cannot leave', async () => {
  const creator = await actor(5000);
  const m1 = await actor(5000);
  const m2 = await actor(5000);
  const id = await group(on, creator, [m1, m2]);
  await call(on, 'POST', `tontine/groups/${id}/accept`, m1);
  await call(on, 'POST', `tontine/groups/${id}/accept`, m2);
  assert.equal((await call(on, 'POST', `tontine/groups/${id}/leave`, m2)).status, 200);
  assert.equal((await call(on, 'POST', `tontine/groups/${id}/leave`, creator)).status, 409);
  await call(on, 'POST', `tontine/groups/${id}/start`, creator);
  assert.equal((await call(on, 'POST', `tontine/groups/${id}/leave`, m1)).status, 409);
  const g = await call(on, 'GET', `tontine/groups/${id}`, creator);
  assert.equal(g.body.memberCount, 2);
  assert.equal((await call(on, 'POST', `tontine/groups/${id}/contribute`, m2)).status, 403, 'a member who left cannot be charged');
});

test('creator cancels: current cycle escrow refunded to the payers, exactly once', async () => {
  const creator = await actor(5000);
  const m1 = await actor(5000);
  const m2 = await actor(5000);
  const id = await activeGroup([creator, m1, m2]);
  await call(on, 'POST', `tontine/groups/${id}/contribute`, m1);
  await call(on, 'POST', `tontine/groups/${id}/contribute`, m2);
  assert.equal((await call(on, 'POST', `tontine/groups/${id}/cancel`, m1)).status, 403, 'only the creator cancels');
  assert.equal((await call(on, 'POST', `tontine/groups/${id}/cancel`, creator)).status, 200);
  assert.equal((await call(on, 'POST', `tontine/groups/${id}/cancel`, creator)).status, 409);
  assert.deepEqual([await bal(creator), await bal(m1), await bal(m2)], [5000, 5000, 5000]);
  assert.equal(await pot(id), 0);
  assert.equal(await potLedgerSum(id), 0);
});

test('unauthorized actions: only the creator invites/removes/starts; only the invitee responds', async () => {
  const creator = await actor();
  const m1 = await actor();
  const m2 = await actor();
  const id = await group(on, creator, [m1]);
  assert.equal((await call(on, 'POST', `tontine/groups/${id}/invite`, m1, { body: { memberHandles: [m2.handle] } })).status, 403);
  assert.equal((await call(on, 'POST', `tontine/groups/${id}/remove`, m1, { body: { userId: creator.id } })).status, 403);
  assert.equal((await call(on, 'POST', `tontine/groups/${id}/start`, m1)).status, 403);
  assert.equal((await call(on, 'POST', `tontine/groups/${id}/decline`, m1)).status, 200);
  assert.equal((await call(on, 'POST', `tontine/groups/${id}/accept`, m1)).status, 409, 'cannot flip after responding');
  const unauth = await on.client('POST', `tontine/groups/${id}/contribute`, {});
  assert.equal(unauth.status, 401);
});

test('direct HTTP bypass: client-supplied amounts and recipients are ignored', async () => {
  const a = await actor(50_000);
  const b = await actor(5000);
  const id = await activeGroup([a, b]);
  const r = await call(on, 'POST', `tontine/groups/${id}/contribute`, b, { body: { amountKori: 1, userId: a.id } });
  assert.equal(r.status, 200);
  assert.equal(r.body.contribution.amountKori, 1000, 'server-fixed amount');
  assert.equal(await bal(a), 50_000, 'body userId cannot redirect the debit');
  await call(on, 'POST', `tontine/groups/${id}/contribute`, a);
  const rel = await call(on, 'POST', `tontine/groups/${id}/release`, b, { body: { recipientId: b.id } });
  assert.equal(rel.body.payout.recipientId, a.id, 'rotation decides, not the request');
});

test('reload / restart persistence: state and obligations survive an API restart', async () => {
  const a = await actor(5000);
  const b = await actor(5000);
  const id = await activeGroup([a, b]);
  await call(on, 'POST', `tontine/groups/${id}/contribute`, a);
  await on.stop();
  on = await startApiServer({ TONTINE_ESCROW_ENABLED: 'true' });
  const g = await call(on, 'GET', `tontine/groups/${id}`, b);
  assert.equal(g.body.status, 'active');
  assert.equal(g.body.potBalance, 1000);
  assert.equal(g.body.myContributionThisCycle, false);
  assert.equal((await call(on, 'POST', `tontine/groups/${id}/contribute`, a)).body.contribution.duplicate, true);
  assert.equal(await bal(a), 4000);
});

test('pot ledger is append-only and the pot never goes negative (DB-enforced)', async () => {
  const a = await actor(5000);
  const b = await actor(5000);
  const id = await activeGroup([a, b]);
  await call(on, 'POST', `tontine/groups/${id}/contribute`, a);
  const entry = await prisma.tontinePotEntry.findFirst({ where: { groupId: id } });
  await assert.rejects(prisma.tontinePotEntry.update({ where: { id: entry.id }, data: { amountKori: 1 } }));
  await assert.rejects(prisma.tontinePotEntry.delete({ where: { id: entry.id } }));
  await assert.rejects(prisma.tontineGroup.update({ where: { id }, data: { potBalance: -1 } }));
});

test('PRODUCTION DEFAULT: money movement stays disabled without the explicit operator flag', async () => {
  const a = await actor(5000);
  const b = await actor(5000);
  const created = await call(off, 'POST', 'tontine/groups', a, { body: { name: 'Off', amountPerMember: 10_000, memberHandles: [b.handle] } });
  const id = created.body.id;
  await call(off, 'POST', `tontine/groups/${id}/accept`, b);
  await call(off, 'POST', `tontine/groups/${id}/start`, a);
  const c = await call(off, 'POST', `tontine/groups/${id}/contribute`, b);
  assert.equal(c.status, 503);
  assert.equal(c.body.code, 'tontine_collections_paused');
  assert.equal((await call(off, 'POST', `tontine/groups/${id}/release`, a)).status, 503);
  assert.equal(await bal(b), 5000);
});

test('the old attack (invite victims, release immediately) moves nothing', async () => {
  const attacker = await actor(0);
  const v1 = await actor(50_000);
  const v2 = await actor(30_000);
  const id = await group(on, attacker, [v1, v2], 300_000);
  const rel = await call(on, 'POST', `tontine/groups/${id}/release`, attacker);
  assert.equal(rel.status, 409);
  assert.deepEqual([await bal(attacker), await bal(v1), await bal(v2)], [0, 50_000, 30_000]);
});
