/**
 * P-J11-8 — post-payout termination, five things kept apart:
 *   1. member APPROVAL (vote)            → status only; a vote never moves money
 *   2. CLAIMS and outstanding obligations → explicit immutable claims at close (Σ owes = Σ owed)
 *   3. MONEY HELD                          → only the open cycle's pot, returned to exactly who paid it
 *   4. settlement ELIGIBILITY              → settlement_pending, not frozen, no open dispute
 *   5. EXECUTION                           → only via the finance-executed approval, once
 * Cases: partial pots, missed contributions, frozen groups, simultaneous settlements, retries, disputes.
 */
import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createUserWithWallet, prisma } from '../helpers/db.js';
import * as C from '../../lib/collective/engine.js';
import { executeTerminationSettlement, ruleDispute } from '../../lib/collective/ops.js';
import { checkCollectiveInvariants } from '../../lib/collective/invariants.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';

process.env.JOKKO_COLLECTIVE_ENABLED = 'true';
after(async () => {
  const r = await checkCollectiveInvariants();
  assert.ok(r.ok, JSON.stringify(r.violations));
  await assertInvariants(prisma);
  await prisma.$disconnect();
});
const key = () => crypto.randomBytes(8).toString('hex');
const ctx = () => ({ id: `appr-${key()}`, requestedBy: 'op-collective', approvedBy: 'op-finance' });
const bal = async (u) => (await prisma.wallet.findUnique({ where: { userId: u.id } })).koriBalance;
const balances = (us) => Promise.all(us.map(bal));
const pot = async (g) => Number((await prisma.ledgerAccount.findUnique({ where: { code: `collective:${g}:pot` } }))?.balance ?? 0);
const code = (p) => p.then(() => 'ok', (e) => e.code ?? e.message);

async function rotating(n, order = true) {
  const us = [];
  for (let i = 0; i < n; i += 1) us.push(await createUserWithWallet({ koriBalance: 20_000 }));
  const [org, ...rest] = us;
  const g = await C.createGroup(org.id, { kind: 'rotating', name: `T-${key().slice(0, 5)}`, contributionKori: 1000, frequency: 'weekly', graceDays: 1, rotationMethod: order ? 'fixed' : 'draw' });
  await C.inviteMembers(g.id, org.id, rest.map((u) => u.handle));
  for (const u of rest) await C.respondToInvite(g.id, u.id, true);
  const p = await C.proposeRules(g.id, org.id, { order: us.map((u) => u.id), startAt: new Date(Date.now() + 1000) });
  for (const u of us) await C.acceptRules(g.id, u.id, { rulesHash: p.rulesHash });
  return { id: g.id, us };
}
const pay = (id, u) => C.contribute(id, u.id, { idempotencyKey: key() });
/** Members who have not received vote to end the group (unanimous). */
async function voteEnd(id, voters) {
  const v = await C.openVote(id, voters[0].id, { topic: 'cancel' });
  let last = v;
  for (const u of voters.slice(1)) last = await C.castBallot(v.vote.id, u.id, 'yes');
  return last.outcome ?? v.outcome;
}

test('a vote to end never moves money — even before any payout; settlement does, once', async () => {
  const { id, us } = await rotating(3);
  await pay(id, us[1]); // a partial pot: 1 of 3 paid in cycle 1
  const before = await balances(us);
  const out = await voteEnd(id, us);
  assert.deepEqual(out.applied, { settlementPending: true });
  assert.deepEqual(await balances(us), before, 'approval moved nothing');
  assert.equal(await pot(id), 1000, 'the money held is still held');
  assert.equal(await code(pay(id, us[0])), 'not_active', 'no new money while settlement is pending');
  const r = await executeTerminationSettlement(prisma, { groupId: id }, ctx());
  assert.equal(r.refundedKori, 1000, 'only the money held goes back, to exactly who paid it');
  assert.deepEqual((await balances(us)).map((b, i) => b - before[i]), [0, 1000, 0]);
  assert.deepEqual(r.claims, [], 'before any payout nobody owes anybody');
});

test('partial pot + missed contributions after payouts: claims mirror real money flows; nothing forgiven, created or redistributed', async () => {
  const { id, us } = await rotating(4); // order: u0, u1, u2, u3
  const [u0, u1, u2, u3] = us;
  for (const u of us) await pay(id, u); // cycle 1 → u0 (+4000)
  await pay(id, u0); await pay(id, u1); await pay(id, u2); // u3 misses cycle 2
  await prisma.collectiveObligation.updateMany({ where: { groupId: id, cycle: 2 }, data: { graceUntil: new Date(Date.now() - 1000) } });
  await C.runCollectiveMaintenance();
  const pv = await C.openVote(id, u0.id, { topic: 'partial_release' });
  await C.castBallot(pv.vote.id, u1.id, 'yes');
  await C.castBallot(pv.vote.id, u2.id, 'yes');
  await C.releaseCycle(id, u0.id); // cycle 2 → u1 (+3000, short 1000)
  await pay(id, u0); await pay(id, u1); // cycle 3 partial pot: 2000 held
  const totalBefore = (await balances(us)).reduce((a, b) => a + b, 0);
  await voteEnd(id, [u2, u3]); // those who have not received
  const r = await executeTerminationSettlement(prisma, { groupId: id }, ctx());
  assert.equal(r.refundedKori, 2000, 'the partial pot returns to u0 and u1');
  const byUser = Object.fromEntries(r.claims.map((c) => [c.userId, [c.direction, c.amountKori]]));
  // u0: paid 1000+1000+1000(refunded) → paid 2000 net of refund... statement counts the refund as received:
  // paid 3000, received 4000 + 1000 refund = 5000 → owes 2000. u1: paid 3000, received 3000 + 1000 → owes 1000.
  // u2: paid 2000, received 0 → owed 2000. u3: paid 1000 (missed cycle 2), received 0 → owed 1000.
  assert.deepEqual(byUser, { [u0.id]: ['owes', 2000], [u1.id]: ['owes', 1000], [u2.id]: ['owed', 2000], [u3.id]: ['owed', 1000] });
  const owes = r.claims.filter((c) => c.direction === 'owes').reduce((a, c) => a + c.amountKori, 0);
  const owed = r.claims.filter((c) => c.direction === 'owed').reduce((a, c) => a + c.amountKori, 0);
  assert.equal(owes, owed, 'Σ owes = Σ owed');
  assert.equal((await balances(us)).reduce((a, b) => a + b, 0), totalBefore + 2000, 'only the held 2000 moved (pot → its payers)');
  assert.equal(await pot(id), 0);
  const missed = await prisma.collectiveObligation.findUnique({ where: { groupId_cycle_userId: { groupId: id, cycle: 2, userId: u3.id } } });
  assert.equal(missed.status, 'missed', 'a past missed payment stays on record (never relabelled as cancelled)');
  const future = await prisma.collectiveObligation.count({ where: { groupId: id, cycle: 4, status: 'terminated' } });
  assert.equal(future, 4, 'future obligations are closed as terminated, their value captured in the claims');
  await assert.rejects(prisma.collectiveClaim.updateMany({ where: { groupId: id }, data: { amountKori: 1 } }), /append-only/, 'a claim cannot be edited or erased');
});

test('eligibility: frozen → refused; open dispute → refused until ruled; simultaneous settlements and retries execute once', async () => {
  const { id, us } = await rotating(3);
  for (const u of us) await pay(id, u); // cycle 1 → u0
  await pay(id, us[1]);
  await voteEnd(id, [us[1], us[2]]);
  await prisma.collectiveGroup.update({ where: { id }, data: { frozenAt: new Date(), frozenReason: 'vérification' } });
  assert.equal(await code(executeTerminationSettlement(prisma, { groupId: id }, ctx())), 'group_frozen');
  await prisma.collectiveGroup.update({ where: { id }, data: { frozenAt: null, frozenReason: null } });
  const d = await C.openDispute(id, us[0].id, { reason: 'Je conteste le calcul de ma position finale' });
  assert.equal(await code(executeTerminationSettlement(prisma, { groupId: id }, ctx())), 'disputed');
  await ruleDispute('op-collective', d.dispute.id, { outcome: 'continue', note: 'Calcul vérifié avec le membre' });
  const before = await balances(us);
  const rs = await Promise.allSettled([1, 2, 3].map(() => executeTerminationSettlement(prisma, { groupId: id }, ctx())));
  assert.ok(rs.every((r) => r.status === 'fulfilled'), JSON.stringify(rs.map((r) => r.reason?.code)));
  assert.equal(rs.filter((r) => !r.value.replayed).length, 1, 'exactly one execution');
  assert.deepEqual((await balances(us)).map((b, i) => b - before[i]), [0, 1000, 0], 'refunded once');
  assert.equal(await prisma.collectiveClaim.count({ where: { groupId: id } }), 3, 'claims written once');
  const retry = await executeTerminationSettlement(prisma, { groupId: id }, ctx());
  assert.equal(retry.replayed, true);
});

test('an exit vote moves no money; leaving on one’s own turn needs a dispute ruling, never a vote', async () => {
  const { id, us } = await rotating(3); // order u0, u1, u2
  for (const u of us) await pay(id, u); // cycle 1 → u0; now cycle 2 = u1's turn
  assert.equal(await code(C.openVote(id, us[1].id, { topic: 'exit' })), 'own_turn_in_progress');
  const before = await balances(us);
  const v = await C.openVote(id, us[2].id, { topic: 'exit' });
  await C.castBallot(v.vote.id, us[0].id, 'yes');
  await C.castBallot(v.vote.id, us[1].id, 'yes');
  assert.deepEqual(await balances(us), before, 'the exit itself moved nothing');
  assert.equal((await prisma.collectiveMember.findFirst({ where: { groupId: id, userId: us[2].id } })).status, 'exited');
});

test('normal completion with an exited member: their contributions become an explicit claim at close', async () => {
  const { id, us } = await rotating(3); // u0, u1, u2
  for (const u of us) await pay(id, u); // cycle 1 → u0 (u2 paid 1000)
  const v = await C.openVote(id, us[2].id, { topic: 'exit' });
  await C.castBallot(v.vote.id, us[0].id, 'yes');
  await C.castBallot(v.vote.id, us[1].id, 'yes');
  await pay(id, us[0]);
  await pay(id, us[1]); // cycle 2 → u1; cycle 3 (u2's turn) skipped → completed
  const g = await prisma.collectiveGroup.findUnique({ where: { id } });
  assert.equal(g.status, 'completed');
  const claims = await prisma.collectiveClaim.findMany({ where: { groupId: id } });
  const by = Object.fromEntries(claims.map((c) => [c.userId, [c.direction, c.amountKori]]));
  assert.deepEqual(by[us[2].id], ['owed', 1000], 'the leaver is owed what they paid in — recorded, not forgotten');
  assert.equal(claims.filter((c) => c.direction === 'owes').reduce((a, c) => a + c.amountKori, 0), 1000);
});
