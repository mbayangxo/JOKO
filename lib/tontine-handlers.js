import { z } from 'zod';
import { prisma } from './prisma.js';
import { validationError } from './validation.js';
import { InsufficientFundsError } from './wallet-atomic.js';
import { ensureTontineThread, postTontineEscrowCard } from './mbolo-commerce-service.js';
import {
  TontineError,
  cancelTontine,
  contribute,
  createTontine,
  getTontineDetail,
  inviteMembers,
  leaveTontine,
  releaseCyclePayout,
  removeMember,
  respondToInvitation,
  startTontine,
} from './tontine-service.js';

const TONTINE_FREQ = { hebdo: 'hebdo', weekly: 'hebdo', mensuel: 'mensuel', monthly: 'mensuel', 'bi-mensuel': 'bi-mensuel' };

const MEMBER_INCLUDE = {
  memberships: {
    include: { user: { select: { id: true, name: true, handle: true, avatarEmoji: true } } },
    orderBy: { rotationOrder: 'asc' },
  },
  contributions: true,
  payouts: { orderBy: { cycle: 'asc' } },
};

export function tontineGroupShape(group, userId) {
  const memberships = group.memberships ?? [];
  const mine = memberships.find((m) => m.userId === userId);
  const participants = memberships.filter((m) => m.status === 'accepted');
  const cycleContribs = (group.contributions ?? []).filter((c) => c.cycle === group.currentCycle && c.status === 'settled');
  const paid = new Set(cycleContribs.map((c) => c.userId));
  const recipient = group.status === 'active' ? participants.sort((a, b) => a.rotationOrder - b.rotationOrder)[group.rotationIndex] : null;
  const contributionKori = group.contributionKori ?? null;
  return {
    id: group.id,
    name: group.name,
    status: group.status,
    amountPerMember: group.amountPerMember,
    amountPerMemberNational: group.amountPerMember,
    contributionKori,
    frequency: group.frequency,
    potBalance: group.potBalance,
    currentCycle: group.currentCycle,
    rotationIndex: group.rotationIndex,
    memberCount: participants.length,
    expectedPot: contributionKori != null ? contributionKori * participants.length : null,
    isCreator: group.createdBy === userId,
    myStatus: mine?.status ?? null,
    myContributionThisCycle: paid.has(userId),
    canContribute: group.status === 'active' && mine?.status === 'accepted' && !paid.has(userId),
    cycleFunded: group.status === 'active' && participants.length > 0 && participants.every((m) => paid.has(m.userId)),
    recipientThisCycle: recipient ? { userId: recipient.userId, name: recipient.user?.name, handle: recipient.user?.handle } : null,
    isMyTurn: recipient?.userId === userId,
    members: memberships.map((m) => ({
      userId: m.userId,
      name: m.user?.name,
      handle: m.user?.handle,
      avatarEmoji: m.user?.avatarEmoji,
      status: m.status,
      rotationOrder: m.rotationOrder,
      hasReceivedPayout: m.hasReceivedPayout,
      paidThisCycle: paid.has(m.userId),
    })),
    payouts: (group.payouts ?? []).map((p) => ({ cycle: p.cycle, recipientId: p.recipientId, amountKori: p.amountKori, reference: p.reference, at: p.createdAt })),
    nextDueAt: group.nextDueAt,
    startedAt: group.startedAt,
    createdAt: group.createdAt,
  };
}

function handleError(res, error) {
  if (error instanceof TontineError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  if (error instanceof InsufficientFundsError) {
    res.status(400).json({ error: error.message, code: 'insufficient' });
    return true;
  }
  return false;
}

async function respondWithGroup(res, groupId, userId, status = 200, extra = {}) {
  const group = await prisma.tontineGroup.findUniqueOrThrow({ where: { id: groupId }, include: MEMBER_INCLUDE });
  res.status(status).json({ ...tontineGroupShape(group, userId), ...extra });
}

/** GET: groups I belong to or am invited to. POST: create (no money moves). */
export async function tontineGroups(req, res) {
  if (req.method === 'GET') {
    const groups = await prisma.tontineGroup.findMany({
      where: { memberships: { some: { userId: req.userId, status: { in: ['invited', 'accepted'] } } } },
      include: MEMBER_INCLUDE,
      orderBy: { updatedAt: 'desc' },
    });
    res.json(groups.map((g) => tontineGroupShape(g, req.userId)));
    return;
  }

  const schema = z.object({
    name: z.string().min(2).max(80),
    amountPerMember: z.number().int().positive(),
    frequency: z.string().default('mensuel'),
    memberHandles: z.array(z.string()).max(50).default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const group = await createTontine(req.userId, {
      ...parsed.data,
      frequency: TONTINE_FREQ[parsed.data.frequency] ?? 'mensuel',
    });
    const thread = await ensureTontineThread(prisma, {
      groupId: group.id,
      creatorId: req.userId,
      memberIds: [req.userId],
      name: group.name,
    }).catch(() => null);
    if (thread) {
      await postTontineEscrowCard(prisma, {
        threadId: thread.id,
        senderId: req.userId,
        group,
        amountKori: 0,
        reference: `TONTINE-${group.id.slice(0, 8)}`,
        action: 'created',
      }).catch(() => null);
    }
    await respondWithGroup(res, group.id, req.userId, 201, { mboloThreadId: thread?.id ?? null });
  } catch (error) {
    if (handleError(res, error)) return;
    throw error;
  }
}

export async function tontineGroupGet(req, res) {
  try {
    const group = await getTontineDetail(req.query.id, req.userId);
    res.json(tontineGroupShape(group, req.userId));
  } catch (error) {
    if (handleError(res, error)) return;
    throw error;
  }
}

function action(run) {
  return async (req, res) => {
    try {
      const extra = (await run(req)) ?? {};
      await respondWithGroup(res, req.query.id, req.userId, 200, extra);
    } catch (error) {
      if (handleError(res, error)) return;
      throw error;
    }
  };
}

export const tontineAccept = action(async (req) => {
  await respondToInvitation(req.query.id, req.userId, true);
  // Accepted members join the group's Mboolo conversation.
  const thread = await prisma.mboloThread.findFirst({ where: { commerceType: 'tontine', commerceRefId: req.query.id } });
  if (thread) {
    await prisma.mboloMember
      .upsert({ where: { threadId_userId: { threadId: thread.id, userId: req.userId } }, update: {}, create: { threadId: thread.id, userId: req.userId } })
      .catch(() => null);
  }
  return null;
});
export const tontineDecline = action((req) => respondToInvitation(req.query.id, req.userId, false).then(() => null));
export const tontineLeave = action((req) => leaveTontine(req.query.id, req.userId).then(() => null));
export const tontineStart = action((req) => startTontine(req.query.id, req.userId).then(() => null));
export const tontineCancel = action((req) => cancelTontine(req.query.id, req.userId).then(() => null));

export const tontineInvite = action(async (req) => {
  const parsed = z.object({ memberHandles: z.array(z.string()).min(1).max(50) }).safeParse(req.body);
  if (!parsed.success) throw new TontineError('validation', 'memberHandles required', 400);
  await inviteMembers(req.query.id, req.userId, parsed.data.memberHandles);
  return null;
});

export const tontineRemove = action(async (req) => {
  const parsed = z.object({ userId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) throw new TontineError('validation', 'userId required', 400);
  await removeMember(req.query.id, req.userId, parsed.data.userId);
  return null;
});

export const tontineContribute = action(async (req) => {
  const key = typeof req.headers?.['idempotency-key'] === 'string' ? `${req.userId}:${req.headers['idempotency-key']}`.slice(0, 190) : undefined;
  const result = await contribute(req.query.id, req.userId, { idempotencyKey: key });
  return { contribution: { reference: result.contribution.reference, amountKori: result.contribution.amountKori, cycle: result.contribution.cycle, duplicate: result.duplicate } };
});

export const tontineRelease = action(async (req) => {
  const result = await releaseCyclePayout(req.query.id, req.userId);
  return { payout: result.payout };
});
