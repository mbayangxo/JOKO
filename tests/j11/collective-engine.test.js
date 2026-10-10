/**
 * J11 collective engine (models A rotating tontine, B goal savings) — lifecycle, money and adversarial
 * cases at the service level. HTTP authorization is covered in collective-http.test.js.
 */
import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createUserWithWallet, prisma } from '../helpers/db.js';
import * as C from '../../lib/collective/engine.js';

process.env.JOKKO_COLLECTIVE_ENABLED = 'true';
after(() => prisma.$disconnect());

const bal = async (u) => (await prisma.wallet.findUnique({ where: { userId: u.id } })).koriBalance;
const key = () => crypto.randomBytes(8).toString('hex');
const code = (p) => p.then(() => 'ok', (e) => e.code ?? e.message);
const pot = async (g) => Number((await prisma.ledgerAccount.findUnique({ where: { code: `collective:${g}:pot` } }))?.balance ?? 0);

async function people(n, kori = 10_000) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(await createUserWithWallet({ koriBalance: kori }));
  return out;
}
/** Organizer + members joined, rules proposed (optionally a fixed order) and accepted by everyone → active. */
async function activeGroup(us, { kind = 'rotating', contributionKori = 1000, order = null, ...extra } = {}) {
  const [org, ...rest] = us;
  const g = await C.createGroup(org.id, { kind, name: `G-${key().slice(0, 6)}`, contributionKori, frequency: 'weekly', graceDays: 2, rotationMethod: order ? 'fixed' : 'draw', ...extra });
  await C.inviteMembers(g.id, org.id, rest.map((u) => u.handle));
  for (const u of rest) await C.respondToInvite(g.id, u.id, true);
  const p = await C.proposeRules(g.id, org.id, { order: order?.map((u) => u.id) ?? null, startAt: new Date(Date.now() + 1000) });
  for (const u of us) await C.acceptRules(g.id, u.id, { rulesHash: p.rulesHash });
  return { id: g.id, rulesHash: p.rulesHash, rules: p.rules };
}

test('consent: an invitation, or joining, never allows money; rules must be approved by every member at the exact hash', async () => {
  const [org, a, b] = await people(3);
  const g = await C.createGroup(org.id, { kind: 'rotating', name: 'Consent', contributionKori: 500, frequency: 'weekly' });
  await C.inviteMembers(g.id, org.id, [a.handle, `@${b.handle}`]);
  assert.equal(await code(C.contribute(g.id, a.id, { idempotencyKey: key() })), 'not_found', 'an invitee is not a member');
  await C.respondToInvite(g.id, a.id, true);
  assert.equal(await code(C.contribute(g.id, a.id, { idempotencyKey: key() })), 'not_active', 'joined but no accepted rules → no money');
  const p1 = await C.proposeRules(g.id, org.id, { startAt: new Date(Date.now() + 1000) });
  await C.acceptRules(g.id, org.id, { rulesHash: p1.rulesHash });
  // b joins after the proposal → the proposal is void for everyone (membership is part of the rules)
  await C.respondToInvite(g.id, b.id, true);
  assert.equal(await code(C.acceptRules(g.id, a.id, { rulesHash: p1.rulesHash })), 'no_rules_pending');
  const p2 = await C.proposeRules(g.id, org.id, { startAt: new Date(Date.now() + 1000) });
  assert.notEqual(p2.rulesHash, p1.rulesHash);
  assert.equal(await code(C.acceptRules(g.id, a.id, { rulesHash: p1.rulesHash })), 'rules_changed', 'an old hash is refused');
  await C.acceptRules(g.id, org.id, { rulesHash: p2.rulesHash });
  const r = await C.acceptRules(g.id, a.id, { rulesHash: p2.rulesHash });
  assert.equal(r.status, 'awaiting_acceptance', 'one member still has to approve');
  assert.equal((await C.acceptRules(g.id, b.id, { rulesHash: p2.rulesHash })).status, 'active');
  assert.equal(await prisma.collectiveObligation.count({ where: { groupId: g.id } }), 9, '3 cycles × 3 members, created at activation');
  for (const u of [org, a, b]) assert.equal(await bal(u), 10_000, 'activation moves no money');
});

test('full rotating cycle: each member receives the pot once, in the accepted order; everyone ends where they started', async () => {
  const us = await people(3);
  const [org, a, b] = us;
  const g = await activeGroup(us, { order: [a, b, org] }); // fixed order, approved by all: the organizer is LAST
  const start = await Promise.all(us.map(bal));
  const recipients = [];
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    let r;
    for (const u of us) r = await C.contribute(g.id, u.id, { idempotencyKey: key() });
    assert.ok(r.payout, `cycle ${cycle} pays out on the last contribution`);
    recipients.push(r.payout.recipientId);
    assert.equal(r.payout.amountKori, 3000);
  }
  assert.deepEqual(recipients, [a.id, b.id, org.id]);
  assert.deepEqual(await Promise.all(us.map(bal)), start, 'a completed tontine is net zero for every member');
  assert.equal((await prisma.collectiveGroup.findUnique({ where: { id: g.id } })).status, 'completed');
  assert.equal(await pot(g.id), 0);
  assert.equal(await code(C.contribute(g.id, a.id, { idempotencyKey: key() })), 'not_active');
});

test('J11-F2 regression — a malicious organizer cannot drain: no early release, no unilateral cancel, no exit after receiving, no rule change', async () => {
  const us = await people(3);
  const [org, a, b] = us;
  const g = await activeGroup(us, { order: [org, a, b] }); // even when the members accept the organizer first
  assert.equal(await code(C.cancelBeforeStart(g.id, org.id)), 'use_cancel_vote', 'no unilateral cancel after activation');
  await C.contribute(g.id, org.id, { idempotencyKey: key() });
  await C.contribute(g.id, a.id, { idempotencyKey: key() });
  assert.equal(await code(C.releaseCycle(g.id, org.id)), 'cycle_incomplete', 'no early payout of a partial pot');
  const r = await C.contribute(g.id, b.id, { idempotencyKey: key() });
  assert.equal(r.payout.recipientId, org.id, 'cycle 1 pays the accepted recipient');
  // The organizer now has the pot. Every escape route is closed:
  assert.equal(await code(C.openVote(g.id, org.id, { topic: 'cancel' })), 'not_eligible', 'who already received cannot vote to cancel');
  assert.equal(await code(C.openVote(g.id, org.id, { topic: 'exit' })), 'received_cannot_exit', 'who already received cannot exit');
  assert.equal(await code(C.leaveGroup(g.id, org.id)), 'use_exit_vote');
  await assert.rejects(prisma.collectiveGroup.update({ where: { id: g.id }, data: { contributionKori: 1 } }), /locked after activation/, 'the database refuses a rule change');
  await assert.rejects(prisma.collectivePayment.deleteMany({ where: { groupId: g.id } }), /append-only|append_only|immutable/i, 'history cannot be erased');
  // P-J11-8: the members who have NOT received vote to end it — that only requests termination. No money
  // moves until a controlled settlement (operator request, executed by a different finance operator).
  await C.contribute(g.id, a.id, { idempotencyKey: key() });
  const v = await C.openVote(g.id, a.id, { topic: 'cancel' });
  const done = await C.castBallot(v.vote.id, b.id, 'yes');
  assert.equal(done.outcome.passed, true);
  assert.deepEqual(done.outcome.applied, { settlementPending: true });
  assert.equal(await pot(g.id), 1000, 'no money moved by the vote itself');
  assert.equal(await code(C.contribute(g.id, b.id, { idempotencyKey: key() })), 'not_active', 'a group awaiting settlement takes no money');
  const { executeTerminationSettlement } = await import('../../lib/collective/ops.js');
  const settled = await executeTerminationSettlement(prisma, { groupId: g.id }, { id: `t-${key()}`, requestedBy: 'op-a', approvedBy: 'op-b' });
  const st = settled.statement;
  const orgLine = st.find((s) => s.userId === org.id);
  assert.equal(orgLine.netKori, 2000, 'the organizer received 3000 having paid 1000: recorded, not hidden');
  assert.equal(st.find((s) => s.userId === a.id).netKori, -1000, 'a paid cycle 1 and got the cycle-2 payment refunded');
  assert.equal(await pot(g.id), 0, 'nothing left in the pot');
  const obs = await prisma.collectiveObligation.findMany({ where: { groupId: g.id, userId: org.id, cycle: { gte: 2 } } });
  assert.ok(obs.every((o) => o.status === 'cancelled'), 'future cycles cancelled — no automatic debit of anyone');
  const again = await executeTerminationSettlement(prisma, { groupId: g.id }, { id: `t-${key()}`, requestedBy: 'op-a', approvedBy: 'op-b' });
  assert.equal(again.replayed, true, 'settles once');
});

test('missed payment: recorded, never auto-debited; partial release only by unanimous paid members incl. the recipient; late payment catches up', async () => {
  const us = await people(3);
  const [org, a, b] = us;
  const g = await activeGroup(us, { order: [a, org, b] });
  await C.contribute(g.id, a.id, { idempotencyKey: key() });
  await C.contribute(g.id, org.id, { idempotencyKey: key() });
  const bBefore = await bal(b);
  assert.equal(await code(C.openVote(g.id, a.id, { topic: 'partial_release' })), 'grace_running');
  await prisma.collectiveObligation.updateMany({ where: { groupId: g.id, cycle: 1 }, data: { graceUntil: new Date(Date.now() - 1000) } }); // time passes
  const m = await C.runCollectiveMaintenance();
  assert.ok(m.missed >= 1);
  assert.equal((await prisma.collectiveObligation.findUnique({ where: { groupId_cycle_userId: { groupId: g.id, cycle: 1, userId: b.id } } })).status, 'missed');
  assert.equal(await bal(b), bBefore, 'a missed payment is never taken');
  assert.equal(await code(C.openVote(g.id, b.id, { topic: 'partial_release' })), 'not_eligible', 'the defaulter does not vote on it');
  const v = await C.openVote(g.id, org.id, { topic: 'partial_release' });
  assert.equal(v.outcome, null, 'the recipient must agree too');
  const aBefore = await bal(a);
  const res = await C.castBallot(v.vote.id, a.id, 'yes');
  assert.equal(res.outcome.applied.amountKori, 2000);
  assert.equal(await bal(a), aBefore + 2000);
  // b pays late: the oldest debt first, and it goes on to a (the short-paid recipient)
  const late = await C.contribute(g.id, b.id, { idempotencyKey: key() });
  assert.equal(late.obligation.cycle, 1);
  assert.equal(late.obligation.status, 'late_paid');
  assert.deepEqual(late.catchUp, { cycle: 1, amountKori: 1000, recipientId: a.id });
  assert.equal(await bal(a), aBefore + 3000, 'a ends with the full pot');
  assert.equal(await pot(g.id), 0);
});

test('idempotency and concurrency: a retried contribution debits once; racing last contributions pay the cycle exactly once', async () => {
  const us = await people(3);
  const [org, a, b] = us;
  const g = await activeGroup(us, { order: [b, a, org] });
  const k = key();
  const before = await bal(a);
  const [r1, r2] = await Promise.allSettled([C.contribute(g.id, a.id, { idempotencyKey: k }), C.contribute(g.id, a.id, { idempotencyKey: k })]);
  assert.ok([r1, r2].every((r) => r.status === 'fulfilled'));
  assert.equal(await bal(a), before - 1000, 'one debit for one key');
  assert.equal(await code(C.contribute(g.id, a.id, { idempotencyKey: k, amountKori: 5 })), 'idempotency_conflict');
  const rs = await Promise.allSettled([C.contribute(g.id, org.id, { idempotencyKey: key() }), C.contribute(g.id, b.id, { idempotencyKey: key() }), C.releaseCycle(g.id, a.id)]);
  assert.equal(await prisma.collectivePayout.count({ where: { groupId: g.id, cycle: 1 } }), 1);
  assert.ok(rs.filter((r) => r.status === 'fulfilled').length >= 2);
  assert.equal(await pot(g.id), 0);
  // overpay / pay-ahead are refused: a member pays only what is due now
  await C.contribute(g.id, a.id, { idempotencyKey: key() });
  assert.equal(await code(C.contribute(g.id, a.id, { idempotencyKey: key() })), 'nothing_due');
});

test('exit by vote before receiving: their turn is skipped, future dues cancelled, their claim recorded', async () => {
  const us = await people(4);
  const [org, a, b, c] = us;
  const g = await activeGroup(us, { order: [a, b, c, org] });
  for (const u of us) await C.contribute(g.id, u.id, { idempotencyKey: key() }); // cycle 1 → a
  const v = await C.openVote(g.id, c.id, { topic: 'exit' });
  await C.castBallot(v.vote.id, org.id, 'yes');
  await C.castBallot(v.vote.id, a.id, 'yes');
  const r = await C.castBallot(v.vote.id, b.id, 'yes');
  assert.equal(r.outcome.applied.claim.paidKori, 1000, 'c paid cycle 1 and leaves with a recorded claim');
  assert.equal(await prisma.collectiveObligation.count({ where: { groupId: g.id, cycle: 3, status: { not: 'cancelled' } } }), 0, "c's own turn is skipped");
  for (const u of [org, a, b]) await C.contribute(g.id, u.id, { idempotencyKey: key() }); // cycle 2 → b
  const fin = await C.contribute(g.id, a.id, { idempotencyKey: key() }).catch((e) => e.code);
  assert.equal(await prisma.collectivePayout.count({ where: { groupId: g.id } }), 2);
  assert.equal((await prisma.collectiveGroup.findUnique({ where: { id: g.id } })).currentCycle, 4, 'cycle 3 skipped');
  assert.ok(fin);
});

test('goal savings: each member saves into and withdraws from their OWN share only; locked until the end if the rules say so', async () => {
  const us = await people(3);
  const [org, a, b] = us;
  const g = await activeGroup(us, { kind: 'goal', contributionKori: 2000, cycleCount: 3, withdrawPolicy: 'end' });
  await C.contribute(g.id, a.id, { idempotencyKey: key() });
  await C.contribute(g.id, b.id, { idempotencyKey: key(), amountKori: 500 });
  assert.equal(await code(C.withdrawShare(g.id, a.id, { idempotencyKey: key() })), 'locked_until_end');
  assert.equal(await code(C.releaseCycle(g.id, org.id)), 'invalid', 'no pot to release in a goal group');
  const share = async (u) => Number((await prisma.ledgerAccount.findUnique({ where: { code: `collective:${g.id}:share:${u.id}` } }))?.balance ?? 0);
  assert.equal(await share(a), 2000);
  assert.equal(await share(b), 500);
  // cancellation by all members returns each share to its owner — never pooled to anyone else
  const aB = await bal(a);
  const v = await C.openVote(g.id, org.id, { topic: 'cancel' });
  await C.castBallot(v.vote.id, a.id, 'yes');
  await C.castBallot(v.vote.id, b.id, 'yes');
  assert.equal(await bal(a), aB + 2000);
  assert.equal(await share(b), 0);
});

test('goal savings with `anytime`: a member can withdraw their own share, never more, never someone else’s', async () => {
  const us = await people(2);
  const [org, a] = us;
  const g = await activeGroup(us, { kind: 'goal', contributionKori: 1000, cycleCount: 2, withdrawPolicy: 'anytime' });
  await C.contribute(g.id, org.id, { idempotencyKey: key() });
  assert.equal(await code(C.withdrawShare(g.id, a.id, { idempotencyKey: key(), amountKori: 1 })), 'invalid_amount', 'a has saved nothing: cannot take the organizer’s savings');
  const before = await bal(org);
  await C.withdrawShare(g.id, org.id, { idempotencyKey: key(), amountKori: 400 });
  assert.equal(await bal(org), before + 400);
  assert.equal(await code(C.withdrawShare(g.id, org.id, { idempotencyKey: key(), amountKori: 601 })), 'invalid_amount');
});

test('disabled by default: every entry point refuses when the flag is off', async () => {
  const [u] = await people(1);
  process.env.JOKKO_COLLECTIVE_ENABLED = 'false';
  try {
    assert.equal(await code(C.createGroup(u.id, { kind: 'rotating', name: 'x', contributionKori: 100, frequency: 'weekly' })), 'collective_not_enabled');
    assert.deepEqual(await C.runCollectiveMaintenance(), { skipped: 'collective_disabled' });
  } finally {
    process.env.JOKKO_COLLECTIVE_ENABLED = 'true';
  }
});
