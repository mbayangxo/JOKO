import { prisma } from '../prisma.js';
import { runMoneyTransaction } from '../wallet-atomic.js';
import { notifyEvent } from '../community/notify.js';
import { CollectiveError } from './contract.js';
import { _internal as E } from './engine.js';

/**
 * J11 operator side. collective_ops rules disputes and may freeze a group (protective: stops every money
 * move). It never moves money: a ruling with a money consequence becomes an approval that a DIFFERENT
 * operator with `collective.disputes.settle` (finance) executes once. Unfreezing needs a different
 * operator from the one who froze. Every action is in the group's immutable history and the admin audit.
 *
 * Ruling outcomes for the disputed cycle:
 *   continue        — no money; the dispute closes and the normal rule applies (payout when complete)
 *   release_collected — pay what the pot holds for the cycle to the rotation's recipient (basis dispute_ruling)
 *   skip_recipient  — the recipient's turn is skipped and the cycle's pot refunded to its payers (e.g. a
 *                     compromised or fraudulent recipient account); they leave the rotation, claim recorded
 */
export const RULINGS = ['continue', 'release_collected', 'skip_recipient'];

async function audit(adminId, action, targetId, detail) {
  await prisma.adminAuditLog.create({ data: { adminUserId: adminId, action, targetType: 'collective_group', targetId, detailJson: JSON.stringify(detail) } }).catch(() => {});
}

export async function adminGroups({ status = null, limit = 100 } = {}) {
  const rows = await prisma.collectiveGroup.findMany({ where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: Math.min(Number(limit) || 100, 500), include: { _count: { select: { members: true } } } });
  return {
    groups: rows.map((g) => ({
      id: g.id, kind: g.kind, status: g.status, frozen: Boolean(g.frozenAt), contributionKori: g.contributionKori, frequency: g.frequency,
      currentCycle: g.currentCycle, cycleCount: g.cycleCount, members: g._count.members, rulesHash: g.rulesHash, createdAt: g.createdAt.toISOString(),
    })),
  };
}

/** Operator view: ids and amounts only (no names or phones); member identity is looked up case by case. */
export async function adminGroupDetail(groupId) {
  const g = await prisma.collectiveGroup.findUnique({ where: { id: String(groupId) }, include: { members: true, payouts: true } });
  if (!g) throw new CollectiveError('not_found', 'Groupe introuvable', 404);
  const [obligations, events, disputes, pot] = await Promise.all([
    prisma.collectiveObligation.groupBy({ by: ['cycle', 'status'], where: { groupId: g.id }, _count: true, _sum: { amountPaidKori: true, amountDueKori: true } }),
    prisma.collectiveEvent.findMany({ where: { groupId: g.id }, orderBy: { createdAt: 'asc' }, take: 500 }),
    prisma.collectiveDispute.findMany({ where: { groupId: g.id }, orderBy: { createdAt: 'asc' } }),
    prisma.ledgerAccount.findUnique({ where: { code: `collective:${g.id}:pot` } }),
  ]);
  return {
    id: g.id, kind: g.kind, status: g.status, frozenAt: g.frozenAt?.toISOString() ?? null, frozenReason: g.frozenReason, rulesHash: g.rulesHash, rulesVersion: g.rulesVersion,
    currentCycle: g.currentCycle, cycleCount: g.cycleCount, potKori: pot ? Number(pot.balance) : 0,
    members: g.members.map((m) => ({ userId: m.userId, status: m.status, position: m.position, acceptedCurrentRules: m.acceptedRulesHash === g.rulesHash })),
    payouts: g.payouts.map((p) => ({ cycle: p.cycle, recipientId: p.recipientId, amountKori: p.amountKori, basis: p.basis, at: p.createdAt.toISOString() })),
    obligations: obligations.map((o) => ({ cycle: o.cycle, status: o.status, count: o._count, paidKori: o._sum.amountPaidKori, dueKori: o._sum.amountDueKori })),
    disputes: disputes.map((d) => ({ id: d.id, cycle: d.cycle, status: d.status, outcome: d.outcome, reason: d.reason, ruledBy: d.ruledBy, createdAt: d.createdAt.toISOString() })),
    events: events.map((e) => ({ action: e.action, actorType: e.actorType, actorId: e.actorId, detail: e.detailJson ? JSON.parse(e.detailJson) : null, at: e.createdAt.toISOString() })),
  };
}

export async function adminDisputes({ status = 'open' } = {}) {
  const rows = await prisma.collectiveDispute.findMany({ where: { status }, orderBy: { createdAt: 'asc' }, take: 200 });
  return { disputes: rows.map((d) => ({ id: d.id, groupId: d.groupId, cycle: d.cycle, status: d.status, outcome: d.outcome, reason: d.reason, createdAt: d.createdAt.toISOString() })) };
}

export async function ruleDispute(adminId, disputeId, { outcome, note }) {
  if (!RULINGS.includes(outcome)) throw new CollectiveError('invalid', 'Décision inconnue', 400);
  const d0 = await prisma.collectiveDispute.findUnique({ where: { id: String(disputeId) } });
  if (!d0) throw new CollectiveError('not_found', 'Litige introuvable', 404);
  const r = await prisma.$transaction(async (tx) => {
    const group = await E.lockGroup(tx, d0.groupId);
    const d = await tx.collectiveDispute.findUnique({ where: { id: d0.id } });
    if (d.status !== 'open') return { dispute: d, replayed: true };
    const status = outcome === 'continue' ? 'dismissed' : 'awaiting_settlement';
    const u = await tx.collectiveDispute.updateMany({ where: { id: d.id, status: 'open' }, data: { status, outcome, ruledBy: adminId, ruledAt: new Date(), rulingNote: String(note).slice(0, 500) } });
    if (u.count !== 1) throw new CollectiveError('conflict', 'Déjà tranché', 409);
    await E.event(tx, group.id, 'admin', adminId, 'dispute_ruled', { disputeId: d.id, outcome });
    return { dispute: await tx.collectiveDispute.findUnique({ where: { id: d.id } }) };
  });
  await audit(adminId, 'collective.dispute.rule', d0.groupId, { disputeId: d0.id, outcome });
  return r;
}

/** The approved money consequence of a ruling. Idempotent: a settled dispute is never executed twice. */
export async function executeDisputeSettlement(db, { disputeId }, ctx) {
  return runMoneyTransaction(db, async (tx) => {
    const d0 = await tx.collectiveDispute.findUnique({ where: { id: String(disputeId) } });
    if (!d0) throw new CollectiveError('not_found', 'Litige introuvable', 404);
    const group = await E.lockGroup(tx, d0.groupId);
    const d = await tx.collectiveDispute.findUnique({ where: { id: d0.id } });
    if (d.status === 'settled') return { disputeId: d.id, replayed: true };
    if (d.status !== 'awaiting_settlement') throw new CollectiveError('not_settleable', `Litige ${d.status}`, 409);
    if (group.status !== 'active') throw new CollectiveError('not_active', 'Le groupe n’est plus en cours', 409);
    if (d.cycle !== group.currentCycle) throw new CollectiveError('stale_ruling', 'Le cycle a changé depuis la décision', 409);
    // Mark first so the payout path no longer sees an open dispute on this cycle.
    await tx.collectiveDispute.update({ where: { id: d.id }, data: { status: 'settled', settledAt: new Date() } });
    const actor = { type: 'admin', id: ctx.approvedBy };
    let result;
    if (d.outcome === 'release_collected') {
      result = await E.payCycle(tx, group, d.cycle, 'dispute_ruling', actor);
    } else {
      const recipient = group.members.find((m) => m.position === d.cycle && m.status === 'joined');
      if (!recipient) throw new CollectiveError('no_recipient', 'Aucun bénéficiaire pour ce cycle', 409);
      result = await E.exitMember(tx, group, recipient.userId, `dispute:${d.id}:approval:${ctx.id}`, 'removed');
    }
    await E.event(tx, group.id, 'admin', ctx.approvedBy, 'dispute_settled', { disputeId: d.id, outcome: d.outcome, requestedBy: ctx.requestedBy });
    for (const m of group.members.filter((x) => x.status === 'joined')) {
      await notifyEvent(tx, m.userId, { category: 'money', kind: 'collective_dispute', refId: group.id, title: 'Litige tranché', body: `K21 a tranché le litige du cycle ${d.cycle} de « ${group.name} ». Le détail est dans l’historique du groupe.`, dedupeKey: `collective:dispute:${d.id}:settled` });
    }
    return { disputeId: d.id, outcome: d.outcome, result };
  });
}

export async function freezeGroup(adminId, groupId, { reason }) {
  const r = await prisma.$transaction(async (tx) => {
    const g = await E.lockGroup(tx, groupId);
    if (g.frozenAt) return { frozen: true, replayed: true };
    await tx.collectiveGroup.update({ where: { id: g.id }, data: { frozenAt: new Date(), frozenReason: String(reason).slice(0, 300) } });
    await E.event(tx, g.id, 'admin', adminId, 'frozen', { reason: String(reason).slice(0, 300) });
    return { frozen: true };
  });
  await audit(adminId, 'collective.freeze', String(groupId), { reason });
  return r;
}

export async function unfreezeGroup(adminId, groupId, { reason }) {
  const r = await prisma.$transaction(async (tx) => {
    const g = await E.lockGroup(tx, groupId);
    if (!g.frozenAt) return { frozen: false, replayed: true };
    const by = await tx.collectiveEvent.findFirst({ where: { groupId: g.id, action: 'frozen' }, orderBy: { createdAt: 'desc' } });
    if (by?.actorId === adminId) throw new CollectiveError('same_operator', 'Un autre opérateur doit lever le gel', 403);
    await tx.collectiveGroup.update({ where: { id: g.id }, data: { frozenAt: null, frozenReason: null } });
    await E.event(tx, g.id, 'admin', adminId, 'unfrozen', { reason: String(reason).slice(0, 300) });
    return { frozen: false };
  });
  await audit(adminId, 'collective.unfreeze', String(groupId), { reason });
  return r;
}

/** P-J11-8: the controlled settlement of a group whose members voted to end it after a payout. Once only. */
export async function executeTerminationSettlement(db, { groupId }, ctx) {
  return runMoneyTransaction(db, async (tx) => {
    const group = await E.lockGroup(tx, groupId);
    if (group.status === 'cancelled') return { groupId: group.id, replayed: true };
    if (group.status !== 'settlement_pending') throw new CollectiveError('not_pending', `Groupe ${group.status}`, 409);
    if (group.frozenAt) throw new CollectiveError('group_frozen', 'Groupe gelé', 423);
    const r = await E.cancelActive(tx, group, `termination:approval:${ctx.id}:requested_by:${ctx.requestedBy}`);
    await E.event(tx, group.id, 'admin', ctx.approvedBy, 'termination_settled', { requestedBy: ctx.requestedBy, refundedKori: r.refundedKori });
    return { groupId: group.id, refundedKori: r.refundedKori, statement: r.statement };
  });
}
