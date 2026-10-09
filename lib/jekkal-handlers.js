import { z } from 'zod';
import { prisma } from './prisma.js';
import { validationError } from './validation.js';
import { gateOrExecute } from './risk-gate.js';
import { assertStepUpForAmount, StepUpRequiredError } from './step-up.js';
import { runMoneyTransaction } from './wallet-atomic.js';
import {
  contributeToCampaign,
  contributionShape,
  createSolidarityCampaign,
  notifySolidarityContribution,
  notifySolidarityFunded,
  solidarityCampaignShape,
} from './jekkal-service.js';

export async function jekkalCampaigns(req, res) {
  if (req.method === 'GET') {
    const status = req.query.status ?? 'active';
    const rows = await prisma.solidarityCampaign.findMany({
      where: status === 'all' ? {} : { status: { in: ['active', 'funded'] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        creator: true,
        beneficiary: true,
        _count: { select: { contributions: true } },
      },
    });
    res.json(
      rows.map((r) =>
        solidarityCampaignShape(r, { contributionCount: r._count.contributions }),
      ),
    );
    return;
  }

  const schema = z.object({
    title: z.string().min(3).max(120),
    story: z.string().max(4000).optional(),
    goalAmount: z.number().int().positive(),
    beneficiaryHandle: z.string().min(3).optional(),
    coverPhotoUrl: z.string().max(720_000).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  let beneficiaryUserId = req.userId;
  if (parsed.data.beneficiaryHandle) {
    const beneficiary = await prisma.user.findUnique({
      where: { handle: parsed.data.beneficiaryHandle.replace(/^@/, '') },
    });
    if (!beneficiary) {
      res.status(404).json({ error: 'Bénéficiaire introuvable' });
      return;
    }
    beneficiaryUserId = beneficiary.id;
  }

  const row = await createSolidarityCampaign(prisma, {
    creatorId: req.userId,
    beneficiaryUserId,
    title: parsed.data.title,
    story: parsed.data.story,
    goalAmount: parsed.data.goalAmount,
    coverPhotoUrl: parsed.data.coverPhotoUrl,
  });
  res.status(201).json(solidarityCampaignShape(row));
}

export async function jekkalCampaignDetail(req, res) {
  const row = await prisma.solidarityCampaign.findUnique({
    where: { id: req.query.id },
    include: {
      creator: true,
      beneficiary: true,
      contributions: {
        orderBy: { createdAt: 'desc' },
        take: 30,
        include: { donor: true },
      },
      _count: { select: { contributions: true } },
    },
  });
  // A campaign awaiting (or refused by) its beneficiary is visible only to its creator and beneficiary.
  if (!row || (['pending_beneficiary', 'declined'].includes(row.status) && ![row.creatorId, row.beneficiaryUserId].includes(req.userId))) {
    res.status(404).json({ error: 'Collecte introuvable' });
    return;
  }
  res.json(
    solidarityCampaignShape(row, {
      contributionCount: row._count.contributions,
      contributions: row.contributions.map(contributionShape),
    }),
  );
}

export async function jekkalContribute(req, res) {
  const schema = z.object({
    amount: z.number().int().positive(),
    message: z.string().max(280).optional(),
    anonymous: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const donor = await prisma.user.findUniqueOrThrow({
    where: { id: req.userId },
    include: { wallet: true },
  });

  try {
    await assertStepUpForAmount(req, parsed.data.amount);
  } catch (error) {
    if (error instanceof StepUpRequiredError) {
      res.status(403).json({ error: error.message, code: 'step_up_required', methods: error.methods });
      return;
    }
    throw error;
  }

  try {
    const gate = await gateOrExecute(
      req,
      res,
      {
        operationType: 'solidarity_donate',
        amountNational: parsed.data.amount,
        payload: {
          campaignId: req.query.id,
          donorId: req.userId,
          amount: parsed.data.amount,
          message: parsed.data.message,
          anonymous: parsed.data.anonymous,
        },
      },
      async (ref) => {
        const { campaign, contribution } = await runMoneyTransaction(prisma, async (db) =>
          contributeToCampaign(db, {
            campaignId: req.query.id,
            donorId: req.userId,
            amount: parsed.data.amount,
            message: parsed.data.message,
            anonymous: parsed.data.anonymous,
            reference: ref,
          }),
        );
        return { campaign, contribution };
      },
    );
    if (gate.held) return;

    const { campaign, contribution } = gate.result;
    const donorLabel = parsed.data.anonymous ? 'Quelqu\'un' : donor.name ?? donor.handle;
    await notifySolidarityContribution(campaign, contribution, donorLabel);
    await notifySolidarityFunded(campaign);

    res.status(201).json({
      contribution: contributionShape(contribution),
      campaign: solidarityCampaignShape(campaign),
    });
  } catch (error) {
    if (error.code === 'campaign_closed' || error.code === 'no_wallet') {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
}

export async function jekkalMine(req, res) {
  const rows = await prisma.solidarityCampaign.findMany({
    where: {
      OR: [{ creatorId: req.userId }, { beneficiaryUserId: req.userId }],
    },
    orderBy: { createdAt: 'desc' },
    include: { creator: true, beneficiary: true },
  });
  res.json(rows.map((r) => solidarityCampaignShape(r)));
}

/** J11-F3: POST jekkal/campaigns/:id/beneficiary { accept } — only the named beneficiary. */
export async function jekkalBeneficiaryRespond(req, res) {
  const parsed = z.object({ accept: z.boolean() }).strict().safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, parsed.error);
  const { respondAsBeneficiary } = await import('./jekkal-service.js');
  const r = await respondAsBeneficiary(prisma, { campaignId: String(req.query.id), userId: req.userId, accept: parsed.data.accept });
  if (!r) return res.status(404).json({ error: 'Collecte introuvable' });
  res.json(solidarityCampaignShape(r.campaign));
}
