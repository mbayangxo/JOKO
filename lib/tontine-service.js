import { reference } from '../api/_lib/auth.js';
import { InsufficientFundsError, lockProjections, lockWallets, runMoneyTransaction } from './wallet-atomic.js';
import { legacyNationalToKori } from './kori-primary.js';
import { prisma } from './prisma.js';
import { notifyMoneyReceived, createInAppNotification } from './notify-service.js';
import { tontineMoneyAllowed } from './runtime-safety.js';
import { account as ledgerAccount, customer, move } from './money-kernel/flows.js';

/**
 * Tontine — consent + dedicated escrow model.
 *
 * Membership:  invited → accepted | declined;  accepted → left | removed (forming only).
 *   An invitation NEVER authorizes a debit. Only a member who explicitly
 *   accepted can take on an obligation, and only for a group they joined.
 * Group:       forming → active → completed | cancelled.
 *   The creator starts the group once ≥ 2 members accepted; the rotation is
 *   fixed at that moment among accepted members only.
 * Contribution: each accepted member explicitly authorizes each cycle's
 *   contribution ("cotiser"). It debits ONLY their own wallet, for the amount
 *   fixed at start, into the group's escrow pot — never into anyone's wallet.
 *   One per member per cycle (DB unique) → retries/duplicates are idempotent.
 * Payout:      only when every participating member has contributed for the
 *   current cycle, only to the scheduled recipient, exactly once per cycle
 *   (DB unique), for exactly the escrowed amount. No early/partial release.
 * Cancel:      creator only; refunds the current cycle's escrowed contributions
 *   to the people who paid them. Completed cycles are final.
 * Every pot movement writes an append-only TontinePotEntry; potBalance must
 * equal their sum. All money operations lock the group row (FOR UPDATE).
 */

const FREQUENCY_MS = {
  weekly: 7 * 24 * 60 * 60 * 1000,
  hebdo: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  mensuel: 30 * 24 * 60 * 60 * 1000,
  'bi-mensuel': 15 * 24 * 60 * 60 * 1000,
};

export const TONTINE_MAX_AMOUNT_XOF = 5_000_000;
export const TONTINE_MAX_MEMBERS = 50;

export function nextDueFrom(frequency, from = new Date()) {
  const ms = FREQUENCY_MS[String(frequency).toLowerCase()] ?? FREQUENCY_MS.monthly;
  return new Date(from.getTime() + ms);
}

export class TontineError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.name = 'TontineError';
    this.status = status;
  }
}

const PARTICIPATING = 'accepted';

function assertMoneyAllowed() {
  if (!tontineMoneyAllowed()) {
    throw new TontineError(
      'tontine_collections_paused',
      'Les cotisations de tontine sont suspendues pour sécuriser les comptes. Aucun montant n’a été prélevé.',
      503,
    );
  }
}

async function lockGroup(tx, groupId) {
  await lockProjections(tx, { TontineGroup: [groupId] });
  const group = await tx.tontineGroup.findUnique({
    where: { id: groupId },
    include: { memberships: { orderBy: { rotationOrder: 'asc' } } },
  });
  if (!group) throw new TontineError('tontine_not_found', 'Tontine introuvable', 404);
  return group;
}

function participants(group) {
  return group.memberships
    .filter((m) => m.status === PARTICIPATING)
    .sort((a, b) => a.rotationOrder - b.rotationOrder);
}

async function requireMembership(db, groupId, userId) {
  const m = await db.tontineMembership.findUnique({
    where: { groupId_userId: { groupId, userId } },
    include: { group: true },
  });
  if (!m) throw new TontineError('tontine_not_member', 'Tu n’es pas membre de cette tontine', 403);
  return m;
}

// ─── Membership lifecycle (no money) ──────────────────────────────────────────

export async function createTontine(creatorId, { name, amountPerMember, frequency, memberHandles = [] }) {
  if (!Number.isInteger(amountPerMember) || amountPerMember <= 0 || amountPerMember > TONTINE_MAX_AMOUNT_XOF) {
    throw new TontineError('tontine_invalid_amount', `Montant par membre invalide (1 – ${TONTINE_MAX_AMOUNT_XOF.toLocaleString('fr-FR')} F)`);
  }
  if (legacyNationalToKori(amountPerMember, 'SN') < 1) {
    throw new TontineError('tontine_invalid_amount', 'Montant par membre trop petit');
  }
  const handles = [...new Set(memberHandles.map((h) => String(h).replace(/^@/, '').toLowerCase()))].slice(0, TONTINE_MAX_MEMBERS);
  const invitees = handles.length
    ? await prisma.user.findMany({ where: { handle: { in: handles }, NOT: { id: creatorId } }, select: { id: true } })
    : [];

  const now = new Date();
  return prisma.tontineGroup.create({
    data: {
      name,
      amountPerMember,
      frequency,
      createdBy: creatorId,
      status: 'forming',
      memberships: {
        create: [
          // Creating the group is the creator's explicit consent to join it.
          { userId: creatorId, rotationOrder: 0, status: PARTICIPATING, acceptedAt: now, respondedAt: now },
          ...invitees.map((u, i) => ({ userId: u.id, rotationOrder: i + 1, status: 'invited', invitedById: creatorId })),
        ],
      },
    },
    include: { memberships: true },
  });
}

export async function inviteMembers(groupId, actorId, memberHandles = []) {
  const membership = await requireMembership(prisma, groupId, actorId);
  if (membership.group.createdBy !== actorId) throw new TontineError('tontine_forbidden', 'Seul l’organisateur peut inviter', 403);
  if (membership.group.status !== 'forming') throw new TontineError('tontine_not_forming', 'La tontine a déjà commencé', 409);
  const handles = [...new Set(memberHandles.map((h) => String(h).replace(/^@/, '').toLowerCase()))];
  const users = await prisma.user.findMany({ where: { handle: { in: handles } }, select: { id: true } });
  const count = await prisma.tontineMembership.count({ where: { groupId } });
  let order = count;
  for (const u of users) {
    await prisma.tontineMembership.upsert({
      where: { groupId_userId: { groupId, userId: u.id } },
      update: {},
      create: { groupId, userId: u.id, rotationOrder: order++, status: 'invited', invitedById: actorId },
    });
  }
  return prisma.tontineGroup.findUniqueOrThrow({ where: { id: groupId }, include: { memberships: true } });
}

/** The invited user — and only they — accepts or declines. */
export async function respondToInvitation(groupId, userId, accept) {
  return prisma.$transaction(async (tx) => {
    const group = await lockGroup(tx, groupId);
    const m = group.memberships.find((x) => x.userId === userId);
    if (!m) throw new TontineError('tontine_not_member', 'Aucune invitation pour toi', 403);
    if (group.status !== 'forming') throw new TontineError('tontine_not_forming', 'La tontine a déjà commencé', 409);
    if (m.status !== 'invited') throw new TontineError('tontine_already_responded', 'Tu as déjà répondu', 409);
    const now = new Date();
    return tx.tontineMembership.update({
      where: { id: m.id },
      data: accept
        ? { status: PARTICIPATING, acceptedAt: now, respondedAt: now }
        : { status: 'declined', respondedAt: now },
    });
  });
}

/** Members may leave only before money moves; afterwards obligations are fixed. */
export async function leaveTontine(groupId, userId) {
  return prisma.$transaction(async (tx) => {
    const group = await lockGroup(tx, groupId);
    const m = group.memberships.find((x) => x.userId === userId);
    if (!m) throw new TontineError('tontine_not_member', 'Tu n’es pas membre de cette tontine', 403);
    if (group.createdBy === userId) {
      throw new TontineError('tontine_creator_cannot_leave', 'L’organisateur annule la tontine au lieu de la quitter', 409);
    }
    if (group.status !== 'forming') {
      throw new TontineError('tontine_active_cannot_leave', 'Impossible de quitter une tontine en cours', 409);
    }
    return tx.tontineMembership.update({ where: { id: m.id }, data: { status: 'left', leftAt: new Date() } });
  });
}

export async function removeMember(groupId, actorId, targetUserId) {
  return prisma.$transaction(async (tx) => {
    const group = await lockGroup(tx, groupId);
    if (group.createdBy !== actorId) throw new TontineError('tontine_forbidden', 'Seul l’organisateur peut retirer un membre', 403);
    if (group.status !== 'forming') throw new TontineError('tontine_not_forming', 'La tontine a déjà commencé', 409);
    if (targetUserId === actorId) throw new TontineError('tontine_creator_cannot_leave', 'Annule la tontine à la place', 409);
    const m = group.memberships.find((x) => x.userId === targetUserId);
    if (!m) throw new TontineError('tontine_not_member', 'Membre introuvable', 404);
    return tx.tontineMembership.update({ where: { id: m.id }, data: { status: 'removed', leftAt: new Date() } });
  });
}

/** Creator starts the group: rotation fixed among ACCEPTED members only. */
export async function startTontine(groupId, actorId, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const group = await lockGroup(tx, groupId);
    if (group.createdBy !== actorId) throw new TontineError('tontine_forbidden', 'Seul l’organisateur peut démarrer', 403);
    if (group.status !== 'forming') throw new TontineError('tontine_not_forming', 'La tontine a déjà commencé', 409);
    const accepted = participants(group).sort((a, b) =>
      a.userId === group.createdBy ? -1 : b.userId === group.createdBy ? 1 : (a.acceptedAt?.getTime() ?? 0) - (b.acceptedAt?.getTime() ?? 0),
    );
    if (accepted.length < 2) {
      throw new TontineError('tontine_not_enough_members', 'Il faut au moins 2 membres qui ont accepté', 409);
    }
    for (let i = 0; i < accepted.length; i++) {
      await tx.tontineMembership.update({ where: { id: accepted[i].id }, data: { rotationOrder: i } });
    }
    return tx.tontineGroup.update({
      where: { id: groupId },
      data: {
        status: 'active',
        currentCycle: 1,
        rotationIndex: 0,
        contributionKori: legacyNationalToKori(group.amountPerMember, 'SN'),
        startedAt: now,
        nextDueAt: nextDueFrom(group.frequency, now),
      },
      include: { memberships: true },
    });
  });
}

// ─── Money (explicit, escrowed, idempotent) ───────────────────────────────────

/**
 * The member themself authorizes this cycle's contribution. Debits only the
 * caller's wallet into the group's escrow pot. Duplicate → returns the existing
 * contribution (no second debit).
 */
export async function contribute(groupId, userId, { idempotencyKey } = {}) {
  assertMoneyAllowed();
  return runMoneyTransaction(prisma, async (tx) => {
    const group = await lockGroup(tx, groupId);
    if (group.status !== 'active') throw new TontineError('tontine_not_active', 'La tontine n’est pas en cours', 409);
    const m = group.memberships.find((x) => x.userId === userId);
    if (!m || m.status !== PARTICIPATING) {
      throw new TontineError('tontine_not_participant', 'Seuls les membres ayant accepté peuvent cotiser', 403);
    }

    const existing = await tx.tontineContribution.findUnique({
      where: { groupId_cycle_userId: { groupId, cycle: group.currentCycle, userId } },
    });
    if (existing) return { contribution: existing, duplicate: true, group };

    const amount = group.contributionKori;
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new TontineError('wallet_missing', 'Portefeuille introuvable', 400);
    await lockWallets(tx, [wallet.id]);
    const fresh = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    if (fresh.koriBalance < amount) throw new InsufficientFundsError('Solde insuffisant pour cotiser');

    const ref = reference('TONC');
    // J2: member wallet → dedicated tontine pot (never the creator's wallet).
    await move(tx, {
      from: await customer(tx, userId),
      to: await ledgerAccount(tx, 'tontinePot', groupId),
      amount,
      reference: `${ref}-J`,
      kind: 'tontine_contribution',
      actor: { type: 'user', id: userId },
    });
    await tx.ledgerEntry.create({
      data: {
        walletId: wallet.id,
        userId,
        type: 'tontine_contribution',
        amount: -amount,
        counterpartyName: group.name,
        note: `Cotisation tontine · cycle ${group.currentCycle}`,
        reference: ref,
      },
    });
    const contribution = await tx.tontineContribution.create({
      data: {
        groupId,
        cycle: group.currentCycle,
        userId,
        amountKori: amount,
        reference: ref,
        idempotencyKey: idempotencyKey ?? null,
        dueAt: group.nextDueAt,
      },
    });
    await tx.tontinePotEntry.create({
      data: { groupId, cycle: group.currentCycle, type: 'contribution', amountKori: amount, userId, reference: `${ref}-POT` },
    });
    const updated = await tx.tontineGroup.findUniqueOrThrow({ where: { id: groupId }, include: { memberships: true } });
    return { contribution, duplicate: false, group: updated };
  });
}

/**
 * Pay the current cycle's pot to the scheduled recipient — only when every
 * participating member has contributed. Any participant may trigger it; the
 * destination is fixed by the rotation, never chosen by the caller.
 */
export async function releaseCyclePayout(groupId, actorUserId) {
  assertMoneyAllowed();
  const result = await runMoneyTransaction(prisma, async (tx) => {
    const group = await lockGroup(tx, groupId);
    const actor = group.memberships.find((x) => x.userId === actorUserId);
    if (!actor || actor.status !== PARTICIPATING) {
      throw new TontineError('tontine_not_participant', 'Tu ne participes pas à cette tontine', 403);
    }
    if (group.status !== 'active') throw new TontineError('tontine_not_active', 'La tontine n’est pas en cours', 409);

    const members = participants(group);
    const contributions = await tx.tontineContribution.findMany({
      where: { groupId, cycle: group.currentCycle, status: 'settled' },
    });
    const paidIds = new Set(contributions.map((c) => c.userId));
    const missing = members.filter((m) => !paidIds.has(m.userId));
    if (missing.length) {
      throw new TontineError(
        'tontine_cycle_incomplete',
        `Le pot n’est pas complet : ${missing.length} cotisation(s) manquante(s). Aucun versement anticipé.`,
        409,
      );
    }

    const pot = contributions.reduce((s, c) => s + c.amountKori, 0);
    if (pot !== group.potBalance || pot !== group.contributionKori * members.length) {
      throw new TontineError('tontine_pot_mismatch', 'Le pot ne correspond pas aux cotisations — vérification requise', 409);
    }

    const recipient = members[group.rotationIndex];
    const recipientWallet = await tx.wallet.findUnique({ where: { userId: recipient.userId } });
    if (!recipientWallet) throw new TontineError('wallet_missing', 'Portefeuille du bénéficiaire introuvable', 409);

    const ref = reference('TONP');
    // Unique (groupId, cycle): a concurrent/duplicate release fails here and rolls back.
    await tx.tontinePayout.create({
      data: { groupId, cycle: group.currentCycle, recipientId: recipient.userId, amountKori: pot, reference: ref },
    });
    await tx.tontinePotEntry.create({
      data: { groupId, cycle: group.currentCycle, type: 'payout', amountKori: -pot, userId: recipient.userId, reference: `${ref}-POT` },
    });
    await move(tx, {
      from: await ledgerAccount(tx, 'tontinePot', groupId),
      to: await customer(tx, recipient.userId),
      amount: pot,
      reference: `${ref}-J`,
      kind: 'tontine_payout',
      actor: { type: 'user', id: actorUserId },
      authorization: 'tontine_rotation_rule',
    });
    await tx.ledgerEntry.create({
      data: {
        walletId: recipientWallet.id,
        userId: recipient.userId,
        type: 'tontine_receive',
        amount: pot,
        counterpartyName: group.name,
        note: `Pot tontine · cycle ${group.currentCycle}`,
        reference: ref,
      },
    });
    await tx.tontineMembership.update({ where: { id: recipient.id }, data: { hasReceivedPayout: true } });

    const lastCycle = group.currentCycle >= members.length;
    const now = new Date();
    const updated = await tx.tontineGroup.update({
      where: { id: groupId },
      data: lastCycle
        ? { status: 'completed', active: false, endedAt: now, lastProcessedAt: now }
        : {
            currentCycle: group.currentCycle + 1,
            rotationIndex: group.rotationIndex + 1,
            lastProcessedAt: now,
            nextDueAt: nextDueFrom(group.frequency, now),
          },
      include: { memberships: true },
    });
    return { payout: { cycle: group.currentCycle, recipientId: recipient.userId, amountKori: pot, reference: ref }, group: updated };
  }).catch((error) => {
    if (error?.code === 'P2002') {
      throw new TontineError('tontine_already_paid', 'Ce cycle a déjà été versé', 409);
    }
    throw error;
  });

  await notifyMoneyReceived(result.payout.recipientId, {
    amount: result.payout.amountKori,
    currency: 'kori',
    senderLabel: result.group.name,
  }).catch(() => {});
  return result;
}

/** Creator cancels: current-cycle escrow goes back to whoever paid it. */
export async function cancelTontine(groupId, actorId) {
  return runMoneyTransaction(prisma, async (tx) => {
    const group = await lockGroup(tx, groupId);
    if (group.createdBy !== actorId) throw new TontineError('tontine_forbidden', 'Seul l’organisateur peut annuler', 403);
    if (['completed', 'cancelled'].includes(group.status)) {
      throw new TontineError('tontine_closed', 'Cette tontine est déjà terminée', 409);
    }
    const open = await tx.tontineContribution.findMany({
      where: { groupId, cycle: group.currentCycle, status: 'settled' },
    });
    if (open.length) assertMoneyAllowed();
    for (const c of open) {
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: c.userId } });
      await move(tx, {
        from: await ledgerAccount(tx, 'tontinePot', groupId),
        to: await customer(tx, c.userId),
        amount: c.amountKori,
        reference: `${c.reference}-REFUND-J`,
        kind: 'tontine_refund',
        actor: { type: 'user', id: actorId },
        authorization: 'tontine_cancel_refund',
      });
      await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          userId: c.userId,
          type: 'tontine_refund',
          amount: c.amountKori,
          counterpartyName: group.name,
          note: 'Remboursement — tontine annulée',
          reference: `${c.reference}-REFUND`,
        },
      });
      await tx.tontinePotEntry.create({
        data: { groupId, cycle: c.cycle, type: 'refund', amountKori: -c.amountKori, userId: c.userId, reference: `${c.reference}-REFUND-POT` },
      });
      await tx.tontineContribution.update({ where: { id: c.id }, data: { status: 'refunded', refundedAt: new Date() } });
    }
    const refunded = open.reduce((s, c) => s + c.amountKori, 0);
    return tx.tontineGroup.update({
      where: { id: groupId },
      data: { status: 'cancelled', active: false, endedAt: new Date() },
      include: { memberships: true },
    });
  });
}

/** Members (any status) can read the group; strangers cannot. */
export async function getTontineDetail(groupId, userId) {
  await requireMembership(prisma, groupId, userId);
  const group = await prisma.tontineGroup.findUniqueOrThrow({
    where: { id: groupId },
    include: {
      memberships: {
        include: { user: { select: { id: true, name: true, handle: true, avatarEmoji: true } } },
        orderBy: { rotationOrder: 'asc' },
      },
      contributions: { orderBy: { createdAt: 'asc' } },
      payouts: { orderBy: { cycle: 'asc' } },
    },
  });
  return group;
}

/**
 * Daily job: reminders only. Collections are never automatic — a member must
 * authorize each contribution themself.
 */
export async function remindDueContributions(db = prisma, now = new Date()) {
  const due = await db.tontineGroup.findMany({
    where: { status: 'active', nextDueAt: { lte: now } },
    include: { memberships: true, contributions: true },
  });
  const results = [];
  for (const g of due) {
    const paid = new Set(g.contributions.filter((c) => c.cycle === g.currentCycle && c.status === 'settled').map((c) => c.userId));
    const late = g.memberships.filter((m) => m.status === PARTICIPATING && !paid.has(m.userId));
    for (const m of late) {
      await createInAppNotification(m.userId, `Tontine ${g.name}`, `Ta cotisation du cycle ${g.currentCycle} est attendue.`).catch(() => {});
    }
    results.push({ groupId: g.id, cycle: g.currentCycle, late: late.length });
  }
  return results;
}

/** @deprecated Auto-debiting members is gone; kept so old imports fail closed. */
export async function processTontineGroup() {
  throw new TontineError('tontine_auto_collect_removed', 'La collecte automatique est désactivée — chaque membre cotise lui-même.', 410);
}

/** @deprecated Old "release" = rule-based cycle payout now. */
export async function releaseTontinePot(groupId, actorUserId) {
  return releaseCyclePayout(groupId, actorUserId);
}
