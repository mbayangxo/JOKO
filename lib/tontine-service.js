import { reference } from '../api/_lib/auth.js';
import { transferNational, InsufficientFundsError, runMoneyTransaction } from './wallet-atomic.js';
import { prisma } from './prisma.js';
import { notifyMoneyReceived } from './notify-service.js';

const FREQUENCY_MS = {
  weekly: 7 * 24 * 60 * 60 * 1000,
  hebdo: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  mensuel: 30 * 24 * 60 * 60 * 1000,
  'bi-mensuel': 15 * 24 * 60 * 60 * 1000,
};

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

/**
 * Collect member dues and release pot to rotation winner when all paid.
 * Same logic as the daily cron, scoped to one group.
 */
/**
 * P0 containment (tontine drain): legacy collection debits every listed member — who never consented —
 * into the creator's personal wallet. Money movement is suspended until the consent + escrow model ships.
 * Fail-closed: no environment change is needed to stay safe.
 */
export const LEGACY_TONTINE_MONEY_SUSPENDED = true;

export async function processTontineGroup(groupId, db = prisma, now = new Date()) {
  if (LEGACY_TONTINE_MONEY_SUSPENDED) {
    throw new TontineError('tontine_suspended', 'Les tontines sont temporairement suspendues pour votre sécurité. Aucun prélèvement n’est effectué.', 503);
  }
  const group = await db.tontineGroup.findUnique({
    where: { id: groupId },
    include: {
      memberships: {
        include: { user: { include: { wallet: true } } },
        orderBy: { rotationOrder: 'asc' },
      },
    },
  });

  if (!group) throw new TontineError('tontine_not_found', 'Tontine introuvable', 404);
  if (!group.active) throw new TontineError('tontine_inactive', 'Cette tontine est fermée', 400);

  const ref = reference('TONTINE');
  const memberCount = group.memberships.length;
  if (memberCount === 0) throw new TontineError('tontine_no_members', 'Aucun membre', 400);

  const collections = [];
  let collectionFailed = false;
  let payoutUserId = null;
  let payoutAmount = 0;
  const expectedPot = group.amountPerMember * memberCount;

  await runMoneyTransaction(db, async (tx) => {
    const potWallet = await tx.wallet.findUnique({ where: { userId: group.createdBy } });
    if (!potWallet) throw new TontineError('tontine_no_pot', 'Portefeuille pot manquant', 500);

    for (const membership of group.memberships) {
      const memberWallet = membership.user.wallet;
      if (!memberWallet) {
        collectionFailed = true;
        collections.push({ userId: membership.userId, ok: false, error: 'no_wallet' });
        continue;
      }

      try {
        await transferNational(tx, {
          amount: group.amountPerMember,
          senderWalletId: memberWallet.id,
          recipientWalletId: potWallet.id,
          senderUserId: membership.userId,
          recipientUserId: group.createdBy,
          reference: `${ref}-C-${membership.userId}`,
          senderLedger: {
            type: 'tontine_contribution',
            counterpartyName: group.name,
            note: 'Cotisation tontine',
          },
          recipientLedger: {
            type: 'tontine_pot_in',
            counterpartyName: membership.user.name,
            note: 'Cotisation reçue',
            reference: `${ref}-C-${membership.userId}-R`,
          },
        });
        collections.push({ userId: membership.userId, amount: group.amountPerMember, ok: true });
      } catch (error) {
        collectionFailed = true;
        collections.push({
          userId: membership.userId,
          ok: false,
          error: error instanceof InsufficientFundsError ? 'insufficient' : 'failed',
        });
      }
    }

    const collectedThisRound = collectionFailed
      ? collections.filter((c) => c.ok && c.userId !== group.createdBy).reduce((sum, c) => sum + c.amount, 0)
      : expectedPot;

    await tx.tontineGroup.update({
      where: { id: group.id },
      data: {
        potBalance: collectedThisRound,
        lastProcessedAt: now,
        nextDueAt: nextDueFrom(group.frequency, now),
      },
    });

    if (!collectionFailed) {
      const recipientMembership = group.memberships.find((m) => m.rotationOrder === group.rotationIndex);
      if (recipientMembership?.user.wallet) {
        const payoutRef = `${ref}-PAYOUT`;
        await transferNational(tx, {
          amount: expectedPot,
          senderWalletId: potWallet.id,
          recipientWalletId: recipientMembership.user.wallet.id,
          senderUserId: group.createdBy,
          recipientUserId: recipientMembership.userId,
          reference: payoutRef,
          senderLedger: {
            type: 'tontine_payout',
            counterpartyName: recipientMembership.user.name,
            note: `Pot tontine ${group.name}`,
          },
          recipientLedger: {
            type: 'tontine_receive',
            counterpartyName: group.name,
            note: 'Pot tontine reçu',
            reference: `${payoutRef}-R`,
          },
        });

        await tx.tontineMembership.update({
          where: { id: recipientMembership.id },
          data: { hasReceivedPayout: true },
        });

        const nextIndex = (group.rotationIndex + 1) % memberCount;
        await tx.tontineGroup.update({
          where: { id: group.id },
          data: { rotationIndex: nextIndex, potBalance: 0 },
        });

        payoutUserId = recipientMembership.userId;
        payoutAmount = expectedPot;
      }
    }
  });

  if (payoutUserId) {
    await notifyMoneyReceived(payoutUserId, {
      amount: payoutAmount,
      currency: 'national',
      senderLabel: group.name,
    });
  }

  return {
    groupId: group.id,
    ok: !collectionFailed,
    collected: collections.filter((c) => c.ok).length,
    payoutUserId,
    payoutAmount: payoutUserId ? payoutAmount : 0,
    partial: collectionFailed,
    collections,
  };
}

/** Manual release — creator or current turn holder triggers collection + payout. */
export async function releaseTontinePot(groupId, actorUserId, db = prisma) {
  const membership = await db.tontineMembership.findUnique({
    where: { groupId_userId: { groupId, userId: actorUserId } },
    include: { group: true },
  });
  if (!membership) throw new TontineError('tontine_not_member', 'Tu n\'es pas membre de cette tontine', 403);

  const { group } = membership;
  const isCreator = group.createdBy === actorUserId;
  const isTurnHolder =
    membership.rotationOrder === group.rotationIndex && !membership.hasReceivedPayout;

  if (!isCreator && !isTurnHolder) {
    throw new TontineError('tontine_not_your_turn', 'Ce n\'est pas encore ton tour', 403);
  }

  return processTontineGroup(groupId, db);
}
