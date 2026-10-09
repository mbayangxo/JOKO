/**
 * J11 adversarial + concurrency lab: simultaneous withdrawals, concurrent ballots, contributions racing
 * to a protected goal, colluding members, replayed settlements, a frozen group, and the dark default.
 */
import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createUserWithWallet, prisma } from '../helpers/db.js';
import * as C from '../../lib/collective/engine.js';
import * as P from '../../lib/collective/protected.js';
import { checkCollectiveInvariants } from '../../lib/collective/invariants.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';

process.env.JOKKO_COLLECTIVE_ENABLED = 'true';
process.env.JOKKO_PROTECTED_FUNDS_ENABLED = 'true';
after(async () => {
  const r = await checkCollectiveInvariants();
  assert.ok(r.ok, JSON.stringify(r.violations));
  await assertInvariants(prisma);
  await prisma.$disconnect();
});
const key = () => crypto.randomBytes(8).toString('hex');
const bal = async (u) => (await prisma.wallet.findUnique({ where: { userId: u.id } })).koriBalance;
const people = async (n, kori = 20_000) => Promise.all(Array.from({ length: n }, () => createUserWithWallet({ koriBalance: kori, tier: 2 })));
async function activeGroup(us, extra = {}) {
  const [org, ...rest] = us;
  const g = await C.createGroup(org.id, { kind: 'rotating', name: `A-${key().slice(0, 5)}`, contributionKori: 1000, frequency: 'weekly', graceDays: 1, ...extra });
  await C.inviteMembers(g.id, org.id, rest.map((u) => u.handle));
  for (const u of rest) await C.respondToInvite(g.id, u.id, true);
  const p = await C.proposeRules(g.id, org.id, { order: extra.rotationMethod === 'fixed' ? us.map((u) => u.id) : null, startAt: new Date(Date.now() + 1000) });
  for (const u of us) await C.acceptRules(g.id, u.id, { rulesHash: p.rulesHash });
  return g.id;
}

test('simultaneous withdrawals of a goal share never pay out more than the share', async () => {
  const us = await people(2);
  const id = await activeGroup(us, { kind: 'goal', cycleCount: 2, withdrawPolicy: 'anytime' });
  await C.contribute(id, us[0].id, { idempotencyKey: key() });
  const before = await bal(us[0]);
  const rs = await Promise.allSettled(Array.from({ length: 6 }, () => C.withdrawShare(id, us[0].id, { idempotencyKey: key(), amountKori: 400 })));
  const okCount = rs.filter((r) => r.status === 'fulfilled').length;
  assert.equal(okCount, 2, 'only 2 × 400 fit in a 1000 share');
  assert.equal(await bal(us[0]), before + 800);
});

test('concurrent ballots apply a passed vote exactly once', async () => {
  const us = await people(5);
  const id = await activeGroup(us);
  const v = await C.openVote(id, us[0].id, { topic: 'extend_grace', days: 2 });
  const before = (await prisma.collectiveObligation.findFirst({ where: { groupId: id, cycle: 1 } })).graceUntil;
  await Promise.allSettled(us.slice(1).map((u) => C.castBallot(v.vote.id, u.id, 'yes')));
  const after_ = (await prisma.collectiveObligation.findFirst({ where: { groupId: id, cycle: 1 } })).graceUntil;
  assert.equal(after_.getTime() - before.getTime(), 2 * 86_400_000, 'extended once, not once per ballot');
  assert.equal((await prisma.collectiveVote.findUnique({ where: { id: v.vote.id } })).status, 'passed');
});

test('colluding members can only ever pay the accepted recipient — never redirect the pot', async () => {
  const us = await people(4);
  const [org, a, b, c] = us;
  const id = await activeGroup(us, { rotationMethod: 'fixed' }); // order: org, a, b, c
  for (const u of [a, b, c]) await C.contribute(id, u.id, { idempotencyKey: key() }); // org (the recipient) does not pay
  await prisma.collectiveObligation.updateMany({ where: { groupId: id, cycle: 1 }, data: { graceUntil: new Date(Date.now() - 1000) } });
  const v = await C.openVote(id, a.id, { topic: 'partial_release' });
  await C.castBallot(v.vote.id, b.id, 'yes');
  const r = await C.castBallot(v.vote.id, c.id, 'yes');
  assert.equal(r.outcome, null, 'the recipient must agree too');
  const fin = await C.castBallot(v.vote.id, org.id, 'yes');
  assert.equal(fin.outcome.applied.recipientId, org.id, 'even a unanimous vote pays only the rotation recipient');
});

test('contributions racing to a protected goal never overfund; a replayed release pays once', async () => {
  const [org, rec, ap, ...donors] = await people(9);
  const f = await P.createFund(org.id, { kind: 'project', title: 'École', purpose: 'Tables et bancs pour l’école', goalKori: 1000, deadline: new Date(Date.now() + 5 * 86_400_000), recipientHandle: rec.handle, approverHandles: [ap.handle], approvalsRequired: 1, milestones: [{ title: 'Mobilier', amountKori: 1000 }] });
  await P.recipientRespond(f.id, rec.id, true);
  await P.approverAccept(f.id, ap.id);
  await P.publishFund(f.id, org.id);
  const rs = await Promise.allSettled(donors.map((d) => P.contribute(f.id, d.id, { amountKori: 300, idempotencyKey: key() })));
  const fresh = await prisma.protectedFund.findUnique({ where: { id: f.id } });
  assert.ok(fresh.raisedKori <= 1000);
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 3, '3 × 300 fit; the rest are refused, not partially taken');
  const last = donors.find((d, i) => rs[i].status === 'rejected');
  await P.contribute(f.id, last.id, { amountKori: 100, idempotencyKey: key() });
  await P.decideMilestone(f.id, ap.id, { decision: 'approve' });
  const ctx = { id: `test-${key()}`, requestedBy: 'op-a', approvedBy: 'op-b' };
  const before = await bal(rec);
  await Promise.allSettled([P.executeRelease(prisma, { fundId: f.id, seq: 1 }, ctx), P.executeRelease(prisma, { fundId: f.id, seq: 1 }, ctx)]);
  await P.executeRelease(prisma, { fundId: f.id, seq: 1 }, ctx);
  assert.equal(await bal(rec), before + 1000, 'released exactly once');
});

test('a frozen group moves nothing — not contributions, not payouts, not votes', async () => {
  const us = await people(2);
  const id = await activeGroup(us);
  await prisma.collectiveGroup.update({ where: { id }, data: { frozenAt: new Date(), frozenReason: 'test' } });
  for (const fn of [() => C.contribute(id, us[0].id, { idempotencyKey: key() }), () => C.releaseCycle(id, us[0].id), () => C.openVote(id, us[0].id, { topic: 'cancel' })]) {
    await assert.rejects(fn(), (e) => e.code === 'group_frozen');
  }
});

test('an outsider can never act on a group: every action answers not_found', async () => {
  const us = await people(2);
  const [outsider] = await people(1);
  const id = await activeGroup(us);
  for (const fn of [
    () => C.contribute(id, outsider.id, { idempotencyKey: key() }), () => C.releaseCycle(id, outsider.id), () => C.openVote(id, outsider.id, { topic: 'cancel' }),
    () => C.openDispute(id, outsider.id, { reason: 'je veux voir ce qui se passe' }), () => C.acceptRules(id, outsider.id, { rulesHash: 'x' }), () => C.withdrawShare(id, outsider.id, { idempotencyKey: key() }),
  ]) await assert.rejects(fn(), (e) => e.code === 'not_found');
});
