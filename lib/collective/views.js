import { prisma } from '../prisma.js';
import { CollectiveError, POLICIES } from './contract.js';

/**
 * Member views. A group exists only for its members (and invitees, who see what they are invited to and
 * the rules — never the money history). Members see the schedule, each cycle's payment status (the
 * transparency they accepted in the rules), the full history and their own statement.
 */
const notFound = () => new CollectiveError('not_found', 'Groupe introuvable', 404);
const who = (u) => (u ? { handle: u.handle, name: u.name } : null);

export async function myGroups(userId) {
  const ms = await prisma.collectiveMember.findMany({ where: { userId, status: { in: ['invited', 'joined', 'exited'] } }, include: { group: true }, orderBy: { createdAt: 'desc' }, take: 100 });
  const out = [];
  for (const m of ms) {
    const g = m.group;
    const due = g.status === 'active' ? await prisma.collectiveObligation.findFirst({ where: { groupId: g.id, userId, status: { in: ['open', 'partial', 'missed'] }, cycle: { lte: g.currentCycle } }, orderBy: { cycle: 'asc' } }) : null;
    out.push({
      id: g.id, kind: g.kind, name: g.name, status: g.status, frozen: Boolean(g.frozenAt), myStatus: m.status, contributionKori: g.contributionKori, frequency: g.frequency,
      currentCycle: g.currentCycle, cycleCount: g.cycleCount, myPosition: m.position,
      needsMyApproval: g.status === 'awaiting_acceptance' && m.status === 'joined' && m.acceptedRulesHash !== g.rulesHash,
      due: due ? { cycle: due.cycle, dueKori: due.amountDueKori - due.amountPaidKori, dueAt: due.dueAt.toISOString(), status: due.status } : null,
    });
  }
  return { groups: out };
}

export async function groupView(groupId, userId) {
  const g = await prisma.collectiveGroup.findUnique({ where: { id: String(groupId) }, include: { members: true } });
  const me = g?.members.find((m) => m.userId === userId);
  if (!g || !me || ['declined', 'removed', 'left'].includes(me.status)) throw notFound();
  const users = new Map((await prisma.user.findMany({ where: { id: { in: [...g.members.map((m) => m.userId), g.organizerId] } }, select: { id: true, handle: true, name: true } })).map((u) => [u.id, u]));
  const base = {
    id: g.id, kind: g.kind, name: g.name, status: g.status, frozen: Boolean(g.frozenAt), organizer: who(users.get(g.organizerId)), iAmOrganizer: g.organizerId === userId,
    contributionKori: g.contributionKori, frequency: g.frequency, graceDays: g.graceDays, rotationMethod: g.rotationMethod, cycleCount: g.cycleCount, currentCycle: g.currentCycle,
    targetKori: g.targetKori, withdrawPolicy: g.withdrawPolicy, startAt: g.startAt?.toISOString() ?? null,
    rules: g.rulesJson ? { version: g.rulesVersion, hash: g.rulesHash, terms: JSON.parse(g.rulesJson) } : null, policies: POLICIES,
    myStatus: me.status, myPosition: me.position, myRulesAccepted: Boolean(g.rulesHash) && me.acceptedRulesHash === g.rulesHash,
    members: g.members.filter((m) => ['invited', 'joined', 'exited', 'removed'].includes(m.status) && (me.status !== 'invited' || m.status === 'joined')).map((m) => ({
      ...who(users.get(m.userId)), me: m.userId === userId, status: m.status, position: m.position, rulesAccepted: Boolean(g.rulesHash) && m.acceptedRulesHash === g.rulesHash,
    })),
  };
  if (me.status === 'invited' || g.status === 'proposed' || g.status === 'awaiting_acceptance') return base;

  const [obligations, payments, payouts, votes, disputes, pot, share, shares] = await Promise.all([
    prisma.collectiveObligation.findMany({ where: { groupId: g.id }, orderBy: [{ cycle: 'asc' }] }),
    prisma.collectivePayment.findMany({ where: { groupId: g.id }, orderBy: { createdAt: 'asc' }, take: 1000 }),
    prisma.collectivePayout.findMany({ where: { groupId: g.id } }),
    prisma.collectiveVote.findMany({ where: { groupId: g.id }, include: { ballots: true }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.collectiveDispute.findMany({ where: { groupId: g.id }, orderBy: { createdAt: 'desc' } }),
    prisma.ledgerAccount.findUnique({ where: { code: `collective:${g.id}:pot` } }),
    prisma.ledgerAccount.findUnique({ where: { code: `collective:${g.id}:share:${userId}` } }),
    g.kind === 'goal' ? prisma.ledgerAccount.findMany({ where: { code: { startsWith: `collective:${g.id}:share:` } } }) : [],
  ]);
  const rules = JSON.parse(g.rulesJson);
  const schedule = rules.schedule.map((s) => {
    const obs = obligations.filter((o) => o.cycle === s.cycle);
    const recipient = g.kind === 'rotating' ? g.members.find((m) => m.position === s.cycle) : null;
    const po = payouts.find((p) => p.cycle === s.cycle);
    return {
      cycle: s.cycle, dueAt: s.dueAt, graceUntil: obs[0]?.graceUntil.toISOString() ?? s.graceUntil, current: s.cycle === g.currentCycle,
      recipient: recipient ? { ...who(users.get(recipient.userId)), me: recipient.userId === userId, status: recipient.status } : null,
      payout: po ? { amountKori: po.amountKori, basis: po.basis, at: po.createdAt.toISOString() } : null,
      settled: obs.filter((o) => ['paid', 'late_paid'].includes(o.status)).length, live: obs.filter((o) => !['cancelled', 'refunded'].includes(o.status)).length,
      obligations: obs.map((o) => ({ ...who(users.get(o.userId)), me: o.userId === userId, status: o.status, paidKori: o.amountPaidKori, dueKori: o.amountDueKori })),
    };
  });
  const mine = payments.filter((p) => p.userId === userId);
  const paidKori = mine.filter((p) => p.kind === 'contribution').reduce((s, p) => s + p.amountKori, 0);
  const receivedKori = mine.filter((p) => ['payout', 'catch_up', 'refund', 'withdrawal'].includes(p.kind)).reduce((s, p) => s + p.amountKori, 0);
  return {
    ...base,
    schedule,
    potKori: pot ? Number(pot.balance) : 0,
    myShareKori: share ? Number(share.balance) : 0,
    groupSavedKori: g.kind === 'goal' ? shares.reduce((s, a) => s + Number(a.balance), 0) : null,
    myStatement: { paidKori, receivedKori, netKori: receivedKori - paidKori },
    myDue: obligations.filter((o) => o.userId === userId && ['open', 'partial', 'missed'].includes(o.status) && o.cycle <= g.currentCycle).map((o) => ({ cycle: o.cycle, dueKori: o.amountDueKori - o.amountPaidKori, dueAt: o.dueAt.toISOString(), status: o.status })),
    history: payments.map((p) => ({ kind: p.kind, cycle: p.cycle, amountKori: p.amountKori, late: p.late, ...who(users.get(p.userId)), me: p.userId === userId, at: p.createdAt.toISOString() })),
    votes: votes.map((v) => {
      const eligible = JSON.parse(v.eligibleJson);
      const mineB = v.ballots.find((b) => b.userId === userId);
      return {
        id: v.id, topic: v.topic, cycle: v.cycle, status: v.status, threshold: JSON.parse(v.payloadJson).threshold, days: JSON.parse(v.payloadJson).days ?? null,
        subject: v.subjectUser ? who(users.get(v.subjectUser)) : null, eligible: eligible.length, yes: v.ballots.filter((b) => b.choice === 'yes').length, no: v.ballots.filter((b) => b.choice === 'no').length,
        myBallot: mineB?.choice ?? null, canVote: v.status === 'open' && eligible.includes(userId) && !mineB, expiresAt: v.expiresAt.toISOString(),
      };
    }),
    disputes: disputes.map((d) => ({ id: d.id, cycle: d.cycle, status: d.status, outcome: d.outcome, mine: d.openedBy === userId, createdAt: d.createdAt.toISOString() })),
  };
}
