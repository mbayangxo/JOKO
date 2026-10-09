import { transferNational, runMoneyTransaction } from './wallet-atomic.js';
import { createInAppNotification } from './notify-service.js';
import { formatKori } from './kori.js';

export function solidarityCampaignShape(row, extras = {}) {
  const goal = row.goalAmount;
  const raised = row.raisedAmount;
  const pct = goal > 0 ? Math.min(100, Math.round((raised / goal) * 100)) : 0;
  return {
    id: row.id,
    title: row.title,
    story: row.story,
    goalAmount: goal,
    raisedAmount: raised,
    progressPct: pct,
    coverPhotoUrl: row.coverPhotoUrl,
    status: row.status,
    // J11: every Jekkal campaign is a DIRECT gift (protected campaigns are a separate, dormant product).
    mode: row.mode ?? 'direct',
    disclosure: 'Don direct : chaque don arrive tout de suite chez le bénéficiaire. Il n’est pas remboursé si l’objectif n’est pas atteint.',
    awaitingBeneficiary: row.status === 'pending_beneficiary',
    fundedAt: row.fundedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    creator: row.creator
      ? { id: row.creator.id, name: row.creator.name, handle: row.creator.handle }
      : null,
    beneficiary: row.beneficiary
      ? { id: row.beneficiary.id, name: row.beneficiary.name, handle: row.beneficiary.handle }
      : null,
    contributions: extras.contributions ?? undefined,
    contributionCount: extras.contributionCount ?? undefined,
  };
}

export function contributionShape(row) {
  return {
    id: row.id,
    amount: row.amount,
    message: row.message,
    anonymous: row.anonymous,
    createdAt: row.createdAt.toISOString(),
    donor: row.anonymous
      ? null
      : row.donor
        ? { name: row.donor.name, handle: row.donor.handle }
        : null,
  };
}

export async function createSolidarityCampaign(db, params) {
  return db.solidarityCampaign.create({
    data: {
      creatorId: params.creatorId,
      beneficiaryUserId: params.beneficiaryUserId,
      title: params.title,
      story: params.story ?? null,
      goalAmount: params.goalAmount,
      coverPhotoUrl: params.coverPhotoUrl ?? null,
      mode: 'direct',
      // J11-F3: a campaign for someone else stays closed until that person consents.
      ...(params.beneficiaryUserId === params.creatorId ? { beneficiaryConsentAt: new Date() } : { status: 'pending_beneficiary' }),
    },
    include: {
      creator: true,
      beneficiary: true,
    },
  });
}

export async function contributeToCampaign(db, params) {
  const ref = params.reference;
  const amount = params.amount;

  return runMoneyTransaction(db, async (tx) => {
    await tx.$executeRaw`SELECT id FROM "SolidarityCampaign" WHERE id = ${params.campaignId} FOR UPDATE`;

    const campaign = await tx.solidarityCampaign.findUnique({
      where: { id: params.campaignId },
      include: {
        beneficiary: { include: { wallet: true } },
      },
    });

    if (!campaign || campaign.status !== 'active') {
      const err = new Error('Collecte introuvable ou fermée');
      err.code = 'campaign_closed';
      throw err;
    }

    if (!campaign.beneficiary.wallet) {
      const err = new Error('Bénéficiaire sans portefeuille');
      err.code = 'no_wallet';
      throw err;
    }

    const donorWallet = await tx.wallet.findUnique({ where: { userId: params.donorId } });
    if (!donorWallet) {
      const err = new Error('Portefeuille introuvable');
      err.code = 'no_wallet';
      throw err;
    }

    await transferNational(tx, {
      amount,
      senderWalletId: donorWallet.id,
      recipientWalletId: campaign.beneficiary.wallet.id,
      senderUserId: params.donorId,
      recipientUserId: campaign.beneficiaryUserId,
      reference: ref,
      senderLedger: {
        type: 'solidarity_donate',
        counterpartyName: campaign.title,
        note: params.message ?? null,
      },
      recipientLedger: {
        type: 'solidarity_receive',
        counterpartyName: campaign.title,
        note: params.message ?? null,
        reference: `${ref}-P`,
      },
    });

    const contribution = await tx.solidarityContribution.create({
      data: {
        campaignId: campaign.id,
        donorId: params.donorId,
        amount,
        message: params.message ?? null,
        anonymous: params.anonymous ?? false,
        reference: ref,
      },
      include: { donor: true },
    });

    const updated = await tx.solidarityCampaign.update({
      where: { id: campaign.id },
      data: { raisedAmount: { increment: amount } },
      include: { creator: true, beneficiary: true },
    });

    if (updated.raisedAmount >= updated.goalAmount && updated.status === 'active') {
      await tx.solidarityCampaign.update({
        where: { id: campaign.id },
        data: { status: 'funded', fundedAt: new Date() },
      });
      updated.status = 'funded';
      updated.fundedAt = new Date();
    }

    return { campaign: updated, contribution };
  });
}

export async function notifySolidarityContribution(campaign, contribution, donorLabel) {
  await createInAppNotification(campaign.beneficiaryUserId, 'Nouveau don Jëkkal', `${donorLabel} — ${formatKori(contribution.amount)} pour « ${campaign.title} »`, {
    kind: 'jekkal',
    refId: campaign.id,
    actionLabel: 'Voir',
  });
  if (campaign.creatorId !== campaign.beneficiaryUserId) {
    await createInAppNotification(campaign.creatorId, 'Don reçu', `${formatKori(contribution.amount)} pour « ${campaign.title} »`, {
      kind: 'jekkal',
      refId: campaign.id,
    });
  }
}

export async function notifySolidarityFunded(campaign) {
  if (campaign.status === 'funded') {
    await createInAppNotification(campaign.beneficiaryUserId, 'Objectif atteint 🎉', `« ${campaign.title} » est financé`, {
      kind: 'jekkal',
      refId: campaign.id,
    });
  }
}

/** J11-F3: the named beneficiary accepts (the campaign opens) or refuses (it closes). Once only. */
export async function respondAsBeneficiary(db, { campaignId, userId, accept }) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "SolidarityCampaign" WHERE id = ${campaignId} FOR UPDATE`;
    const c = await tx.solidarityCampaign.findUnique({ where: { id: campaignId } });
    if (!c || c.beneficiaryUserId !== userId) return null;
    if (c.status !== 'pending_beneficiary') return { campaign: c, replayed: true };
    const updated = await tx.solidarityCampaign.update({
      where: { id: c.id },
      data: accept ? { status: 'active', beneficiaryConsentAt: new Date() } : { status: 'declined' },
      include: { creator: true, beneficiary: true },
    });
    return { campaign: updated };
  });
}
