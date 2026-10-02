import crypto from 'node:crypto';
import { prisma } from './prisma.js';
import { reference } from '../api/_lib/auth.js';
import { completeCashIn } from './rail-service.js';
import { lockWallets, runMoneyTransaction } from './wallet-atomic.js';
import { buildAgentDepositUrl, buildAgentWithdrawUrl } from './k21-qr.js';
import { distanceKm, formatDistanceKm } from './geo.js';
import { coordsFromArrondissement } from './dakar-coords.js';
import { createInAppNotification } from './notify-service.js';
import { nationalToKori } from './kori.js';
import { debitNational } from './wallet-atomic.js';

export const AGENT_TIER_STANDARD = 'standard';
export const AGENT_TIER_BUSINESS = 'business';
export const LARGE_WITHDRAW_THRESHOLD_XOF = 500_000;

export const AGENT_TIER_DEFAULTS = {
  [AGENT_TIER_STANDARD]: {
    floatLimit: 500_000,
    maxDepositXof: 500_000,
    maxWithdrawXof: 500_000,
  },
  [AGENT_TIER_BUSINESS]: {
    floatLimit: 10_000_000,
    maxDepositXof: 2_000_000,
    maxWithdrawXof: 5_000_000,
  },
};

function tierDefaults(tier) {
  return AGENT_TIER_DEFAULTS[tier === AGENT_TIER_BUSINESS ? AGENT_TIER_BUSINESS : AGENT_TIER_STANDARD];
}

export class AgentError extends Error {
  constructor(message, code = 'agent_error') {
    super(message);
    this.name = 'AgentError';
    this.code = code;
  }
}

export function agentErrorStatus(error) {
  if (!(error instanceof AgentError)) return 500;
  if (error.code === 'not_agent' || error.code === 'agent_inactive') return 403;
  if (error.code === 'not_found' || error.code === 'invalid_deposit') return 404;
  if (error.code === 'expired' || error.code === 'already_processed') return 409;
  if (error.code === 'insufficient_float' || error.code === 'amount_too_low' || error.code === 'amount_too_high') {
    return 400;
  }
  if (error.code === 'business_agent_required') return 403;
  if (error.code === 'insufficient_balance') return 400;
  return 400;
}

export function agentShape(agent, extras = {}) {
  return {
    id: agent.id,
    userId: agent.userId,
    agentCode: agent.agentCode,
    displayName: agent.displayName,
    locationLabel: agent.locationLabel ?? null,
    arrondissement: agent.arrondissement ?? null,
    lat: agent.lat ?? null,
    lng: agent.lng ?? null,
    floatBalance: agent.floatBalance,
    floatLimit: agent.floatLimit,
    tier: agent.tier ?? AGENT_TIER_STANDARD,
    maxDepositXof: agent.maxDepositXof ?? tierDefaults(agent.tier).maxDepositXof,
    maxWithdrawXof: agent.maxWithdrawXof ?? tierDefaults(agent.tier).maxWithdrawXof,
    commissionBps: agent.commissionBps,
    status: agent.status,
    user: agent.user
      ? {
          id: agent.user.id,
          name: agent.user.name ?? '',
          phone: agent.user.phone ?? '',
          handle: agent.user.handle ?? '',
        }
      : undefined,
    ...extras,
  };
}

export function agentWithdrawShape(withdrawal, user) {
  return {
    id: withdrawal.id,
    reference: withdrawal.reference,
    token: withdrawal.token,
    amountXof: withdrawal.amountXof,
    status: withdrawal.status,
    expiresAt: withdrawal.expiresAt.toISOString(),
    confirmedAt: withdrawal.confirmedAt?.toISOString() ?? null,
    createdAt: withdrawal.createdAt.toISOString(),
    requiresBusinessAgent: withdrawal.amountXof > LARGE_WITHDRAW_THRESHOLD_XOF,
    user: user
      ? {
          id: user.id,
          name: user.name ?? '',
          phone: user.phone ?? '',
          handle: user.handle ?? '',
          verified: (user.verificationTier ?? 1) >= 2,
        }
      : undefined,
  };
}

export function agentDepositShape(deposit, user) {
  return {
    id: deposit.id,
    reference: deposit.reference,
    token: deposit.token,
    amountXof: deposit.amountXof,
    status: deposit.status,
    expiresAt: deposit.expiresAt.toISOString(),
    confirmedAt: deposit.confirmedAt?.toISOString() ?? null,
    createdAt: deposit.createdAt.toISOString(),
    user: user
      ? {
          id: user.id,
          name: user.name ?? '',
          phone: user.phone ?? '',
          handle: user.handle ?? '',
          verified: (user.verificationTier ?? 1) >= 2,
        }
      : undefined,
  };
}

function depositToken() {
  return crypto.randomBytes(12).toString('base64url').slice(0, 16);
}

export async function getAgentByUserId(userId, db = prisma) {
  return db.agentProfile.findUnique({
    where: { userId },
    include: { user: { select: { id: true, name: true, phone: true, handle: true } } },
  });
}

export async function requireActiveAgent(userId, db = prisma) {
  const role = await db.accountRole.findFirst({
    where: { userId, role: 'agent', status: 'active' },
  });
  if (!role) throw new AgentError('Rôle agent requis', 'not_agent');

  const agent = await getAgentByUserId(userId, db);
  if (!agent || agent.status !== 'active') {
    throw new AgentError('Profil agent inactif', 'agent_inactive');
  }
  return agent;
}

export async function createAgentDepositSession(userId, amountXof) {
  if (amountXof < 500) throw new AgentError('Minimum 500 FCFA', 'amount_too_low');
  if (amountXof > AGENT_TIER_DEFAULTS[AGENT_TIER_STANDARD].maxDepositXof) {
    throw new AgentError('Maximum 500 000 FCFA par dépôt standard', 'amount_too_high');
  }

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { wallet: true },
  });
  if (!user.wallet) throw new AgentError('Wallet introuvable', 'wallet_missing');

  const token = depositToken();
  const ref = reference('AGD');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  const deposit = await prisma.agentDeposit.create({
    data: {
      reference: ref,
      token,
      userId,
      amountXof,
      status: 'pending',
      expiresAt,
    },
  });

  return {
    ...agentDepositShape(deposit, user),
    qrUrl: buildAgentDepositUrl(token),
  };
}

export async function getAgentDepositByReference(reference, userId) {
  const deposit = await prisma.agentDeposit.findUnique({
    where: { reference },
    include: { user: { select: { id: true, name: true, phone: true, handle: true, verificationTier: true } } },
  });
  if (!deposit || deposit.userId !== userId) return null;
  return agentDepositShape(deposit, deposit.user);
}

export async function scanAgentDeposit(token, agentUserId) {
  await requireActiveAgent(agentUserId);

  const deposit = await prisma.agentDeposit.findUnique({
    where: { token },
    include: { user: { select: { id: true, name: true, phone: true, handle: true, verificationTier: true } } },
  });
  if (!deposit) throw new AgentError('QR invalide', 'not_found');
  if (deposit.status !== 'pending') throw new AgentError('Dépôt déjà traité', 'already_processed');
  if (deposit.expiresAt < new Date()) throw new AgentError('QR expiré — demande un nouveau code', 'expired');

  return agentDepositShape(deposit, deposit.user);
}

export async function confirmAgentDeposit(depositId, agentUserId) {
  const agent = await requireActiveAgent(agentUserId);

  return runMoneyTransaction(prisma, async (tx) => {
    await tx.$executeRaw`SELECT id FROM "AgentProfile" WHERE id = ${agent.id} FOR UPDATE`;
    await tx.$executeRaw`SELECT id FROM "AgentDeposit" WHERE id = ${depositId} FOR UPDATE`;

    const deposit = await tx.agentDeposit.findUnique({ where: { id: depositId } });
    if (!deposit || deposit.status !== 'pending') {
      throw new AgentError('Dépôt invalide', 'invalid_deposit');
    }
    if (deposit.expiresAt < new Date()) {
      throw new AgentError('QR expiré', 'expired');
    }

    const agentRow = await tx.agentProfile.findUniqueOrThrow({ where: { id: agent.id } });
    if (agentRow.floatBalance < deposit.amountXof) {
      throw new AgentError('Float insuffisant — contacte K21 pour recharger', 'insufficient_float');
    }

    const user = await tx.user.findUniqueOrThrow({
      where: { id: deposit.userId },
      include: { wallet: true },
    });
    if (!user.wallet) throw new AgentError('Wallet introuvable', 'wallet_missing');

    await lockWallets(tx, [user.wallet.id]);

    const settled = await completeCashIn(tx, {
      userId: user.id,
      walletId: user.wallet.id,
      country: user.country ?? 'SN',
      amount: deposit.amountXof,
      reference: deposit.reference,
      sourceNote: `Agent ${agentRow.agentCode}`,
    });

    const newFloat = agentRow.floatBalance - deposit.amountXof;
    await tx.agentProfile.update({
      where: { id: agent.id },
      data: { floatBalance: newFloat },
    });

    await tx.agentFloatEntry.create({
      data: {
        agentId: agent.id,
        type: 'deposit_payout',
        amountXof: -deposit.amountXof,
        balanceAfter: newFloat,
        reference: `${deposit.reference}-FLOAT`,
        depositId: deposit.id,
        note: `Cash-in ${user.name ?? user.phone}`,
      },
    });

    await tx.agentDeposit.update({
      where: { id: deposit.id },
      data: {
        status: 'confirmed',
        agentId: agent.id,
        confirmedAt: new Date(),
      },
    });

    const wallet = await tx.wallet.findUnique({ where: { id: user.wallet.id } });
    return {
      deposit: agentDepositShape(deposit, user),
      mint: settled.mint,
      wallet: wallet
        ? { balance: wallet.balance, koriBalance: wallet.koriBalance, currency: wallet.currency }
        : null,
      agentFloatBalance: newFloat,
    };
  });
}

async function activateAgentInTx(tx, agent) {
  await tx.accountRole.upsert({
    where: { userId_role: { userId: agent.userId, role: 'agent' } },
    create: { userId: agent.userId, role: 'agent', status: 'active' },
    update: { status: 'active' },
  });
  if (agent.status !== 'active') {
    return tx.agentProfile.update({
      where: { id: agent.id },
      data: { status: 'active' },
      include: { user: { select: { id: true, name: true, phone: true, handle: true } } },
    });
  }
  return tx.agentProfile.findUniqueOrThrow({
    where: { id: agent.id },
    include: { user: { select: { id: true, name: true, phone: true, handle: true } } },
  });
}

export async function approveAgentProfile(agentId, adminId, note) {
  const agent = await prisma.agentProfile.findUnique({
    where: { id: agentId },
    include: { user: { select: { id: true, name: true, phone: true, handle: true } } },
  });
  if (!agent) throw new AgentError('Agent introuvable', 'not_found');
  if (agent.status === 'rejected') throw new AgentError('Demande refusée — recrée une demande', 'agent_inactive');

  const updated = await prisma.$transaction(async (tx) => activateAgentInTx(tx, agent));

  await createInAppNotification(
    agent.userId,
    'Agent K21 activé ✓',
    note ?? `Ton point ${updated.agentCode} est actif. Contacte K21 pour charger ton float.`,
    { kind: 'agent_approved', refId: updated.id },
  );

  return agentShape(updated);
}

export async function rejectAgentProfile(agentId, adminId, reason) {
  const agent = await prisma.agentProfile.findUnique({ where: { id: agentId } });
  if (!agent) throw new AgentError('Agent introuvable', 'not_found');
  if (agent.status === 'active' && agent.floatBalance > 0) {
    throw new AgentError('Agent actif avec float — suspendre avant refus', 'float_limit');
  }

  const updated = await prisma.agentProfile.update({
    where: { id: agentId },
    data: { status: 'rejected' },
    include: { user: { select: { id: true, name: true, phone: true, handle: true } } },
  });

  await prisma.accountRole.updateMany({
    where: { userId: agent.userId, role: 'agent' },
    data: { status: 'inactive' },
  });

  await createInAppNotification(
    agent.userId,
    'Demande agent refusée',
    reason ?? 'Contacte le support K21 pour plus d\'infos.',
    { kind: 'agent_rejected', refId: agentId },
  );

  return agentShape(updated);
}

export async function getAgentApplication(userId, db = prisma) {
  const agent = await getAgentByUserId(userId, db);
  if (!agent) return null;
  return {
    ...agentShape(agent),
    canOperate: agent.status === 'active',
    message:
      agent.status === 'pending'
        ? 'Demande en cours — un admin charge ton float sous 48h.'
        : agent.status === 'rejected'
          ? 'Demande refusée — tu peux contacter le support.'
          : 'Point agent actif.',
  };
}

export async function listAgentFloatEntries(agentId, limit = 50) {
  return prisma.agentFloatEntry.findMany({
    where: { agentId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export async function createAgentProfile({ userId, displayName, locationLabel, floatLimit, initialFloat, adminId, tier = AGENT_TIER_STANDARD }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AgentError('Utilisateur introuvable', 'user_not_found');

  const existing = await prisma.agentProfile.findUnique({ where: { userId } });
  if (existing) throw new AgentError('Déjà agent K21', 'already_agent');

  const defs = tierDefaults(tier);
  const count = await prisma.agentProfile.count();
  const agentCode = tier === AGENT_TIER_BUSINESS ? `BAG-${String(count + 1).padStart(4, '0')}` : `AGT-${String(count + 1).padStart(4, '0')}`;
  const startFloat = Math.max(0, Number(initialFloat ?? 0));
  const limit = Math.max(startFloat, Number(floatLimit ?? defs.floatLimit));

  return prisma.$transaction(async (tx) => {
    await tx.accountRole.upsert({
      where: { userId_role: { userId, role: 'agent' } },
      create: { userId, role: 'agent', status: 'active' },
      update: { status: 'active' },
    });

    const profile = await tx.agentProfile.create({
      data: {
        userId,
        agentCode,
        displayName: displayName || user.name || user.phone,
        locationLabel: locationLabel ?? null,
        tier,
        floatLimit: limit,
        floatBalance: startFloat,
        maxDepositXof: defs.maxDepositXof,
        maxWithdrawXof: defs.maxWithdrawXof,
      },
      include: { user: { select: { id: true, name: true, phone: true, handle: true } } },
    });

    if (startFloat > 0) {
      await tx.agentFloatEntry.create({
        data: {
          agentId: profile.id,
          type: 'top_up',
          amountXof: startFloat,
          balanceAfter: startFloat,
          reference: reference('AFT'),
          note: 'Float initial',
          adminId: adminId ?? null,
        },
      });
    }

    return agentShape(profile);
  });
}

export function agentDiscoveryShape(agent, { lat, lng, amountXof, mode = 'deposit' } = {}) {
  const agentLat = agent.lat;
  const agentLng = agent.lng;
  const dist = lat != null && lng != null ? distanceKm(lat, lng, agentLat, agentLng) : null;
  const defs = tierDefaults(agent.tier);
  const maxForMode = mode === 'withdraw' ? (agent.maxWithdrawXof ?? defs.maxWithdrawXof) : (agent.maxDepositXof ?? defs.maxDepositXof);
  const canServeAmount = amountXof == null || amountXof <= maxForMode;
  const hasFloatForWithdraw =
    mode !== 'withdraw' || amountXof == null || agent.floatBalance + amountXof <= agent.floatLimit;
  const isBusiness = (agent.tier ?? AGENT_TIER_STANDARD) === AGENT_TIER_BUSINESS;

  // PUBLIC shape for ordinary users: no personal phone, internal user id,
  // cash-on-hand (float), commission, or exact coordinates. Location is
  // rounded to ~100 m — enough to find the shop, not to track the agent.
  const approx = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
  return {
    id: agent.id,
    agentCode: agent.agentCode,
    displayName: agent.displayName,
    locationLabel: agent.locationLabel ?? null,
    arrondissement: agent.arrondissement ?? null,
    lat: approx(agentLat),
    lng: approx(agentLng),
    status: agent.status,
    distanceKm: dist == null ? null : Math.round(dist * 10) / 10,
    distanceLabel: formatDistanceKm(dist),
    tier: agent.tier ?? AGENT_TIER_STANDARD,
    isBusinessAgent: isBusiness,
    maxWithdrawXof: agent.maxWithdrawXof ?? defs.maxWithdrawXof,
    maxDepositXof: agent.maxDepositXof ?? defs.maxDepositXof,
    canServe:
      agent.status === 'active' &&
      agent.floatBalance >= 500 &&
      canServeAmount &&
      hasFloatForWithdraw,
    openNow: agent.status === 'active' && agent.floatBalance >= 500,
  };
}

export async function listNearbyAgents(db = prisma, { lat, lng, limit = 30, mode = 'deposit', amountXof = null } = {}) {
  const where = { status: 'active' };
  if (mode === 'withdraw' && amountXof != null && amountXof > LARGE_WITHDRAW_THRESHOLD_XOF) {
    where.tier = AGENT_TIER_BUSINESS;
  }

  const agents = await db.agentProfile.findMany({
    where,
    take: 100,
  });

  const shaped = agents
    .map((a) => ({ public: agentDiscoveryShape(a, { lat, lng, amountXof, mode }), float: a.floatBalance }))
    .filter((a) => a.public.canServe);
  if (lat != null && lng != null) {
    shaped.sort((a, b) => {
      if (a.public.distanceKm == null && b.public.distanceKm == null) return 0;
      if (a.public.distanceKm == null) return 1;
      if (b.public.distanceKm == null) return -1;
      return a.public.distanceKm - b.public.distanceKm;
    });
  } else {
    shaped.sort((a, b) => b.float - a.float);
  }

  return shaped.slice(0, limit).map((a) => a.public);
}

export async function updateAgentLocation(userId, { locationLabel, arrondissement, lat, lng }) {
  const agent = await prisma.agentProfile.findUnique({ where: { userId } });
  if (!agent) throw new AgentError('Pas agent K21', 'not_agent');

  let resolvedLat = lat;
  let resolvedLng = lng;
  if ((resolvedLat == null || resolvedLng == null) && arrondissement) {
    const c = coordsFromArrondissement(arrondissement);
    resolvedLat = c.lat;
    resolvedLng = c.lng;
  }

  const updated = await prisma.agentProfile.update({
    where: { id: agent.id },
    data: {
      locationLabel: locationLabel ?? agent.locationLabel,
      arrondissement: arrondissement ?? agent.arrondissement,
      lat: resolvedLat ?? agent.lat,
      lng: resolvedLng ?? agent.lng,
    },
    include: { user: { select: { id: true, name: true, phone: true, handle: true } } },
  });
  return agentShape(updated);
}

/** Self-serve merchant/agent signup — pending until admin activates float. */
export async function applyForAgentProfile({ userId, displayName, locationLabel, arrondissement, lat, lng }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AgentError('Utilisateur introuvable', 'user_not_found');

  const existing = await prisma.agentProfile.findUnique({ where: { userId } });
  if (existing) {
    return agentShape(existing);
  }

  const arr = arrondissement ?? user.arrondissementKey ?? null;
  const coords =
    lat != null && lng != null ? { lat, lng } : coordsFromArrondissement(arr);

  const count = await prisma.agentProfile.count();
  const agentCode = `AGT-${String(count + 1).padStart(4, '0')}`;

  const profile = await prisma.agentProfile.create({
    data: {
      userId,
      agentCode,
      displayName: displayName || user.name || user.phone,
      locationLabel: locationLabel ?? user.arrondissementName ?? null,
      arrondissement: arr,
      lat: coords.lat,
      lng: coords.lng,
      floatBalance: 0,
      floatLimit: 500_000,
      maxDepositXof: AGENT_TIER_DEFAULTS[AGENT_TIER_STANDARD].maxDepositXof,
      maxWithdrawXof: AGENT_TIER_DEFAULTS[AGENT_TIER_STANDARD].maxWithdrawXof,
      tier: AGENT_TIER_STANDARD,
      status: 'pending',
    },
    include: { user: { select: { id: true, name: true, phone: true, handle: true } } },
  });

  return agentShape(profile);
}

export async function topUpAgentFloat(agentId, amountXof, adminId, note) {
  if (amountXof <= 0) throw new AgentError('Montant invalide', 'amount_too_low');

  let activated = false;

  const result = await runMoneyTransaction(prisma, async (tx) => {
    await tx.$executeRaw`SELECT id FROM "AgentProfile" WHERE id = ${agentId} FOR UPDATE`;
    const agent = await tx.agentProfile.findUniqueOrThrow({ where: { id: agentId } });
    const newFloat = agent.floatBalance + amountXof;
    if (newFloat > agent.floatLimit) {
      throw new AgentError('Dépasse la limite de float', 'float_limit');
    }

    if (agent.status === 'pending' && newFloat >= 500) {
      await activateAgentInTx(tx, agent);
      activated = true;
    }

    await tx.agentProfile.update({ where: { id: agentId }, data: { floatBalance: newFloat } });
    await tx.agentFloatEntry.create({
      data: {
        agentId,
        type: 'top_up',
        amountXof,
        balanceAfter: newFloat,
        reference: reference('AFT'),
        note: note ?? 'Recharge admin',
        adminId: adminId ?? null,
      },
    });

    return { floatBalance: newFloat, floatLimit: agent.floatLimit, status: activated ? 'active' : agent.status };
  });

  if (activated) {
    const agent = await prisma.agentProfile.findUnique({ where: { id: agentId } });
    if (agent) {
      await createInAppNotification(
        agent.userId,
        'Agent K21 activé ✓',
        `Float chargé — ton point ${agent.agentCode} est opérationnel.`,
        { kind: 'agent_approved', refId: agent.id },
      );
    }
  }

  return result;
}

export async function listAgents(db = prisma) {
  const agents = await db.agentProfile.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      user: { select: { id: true, name: true, phone: true, handle: true } },
      _count: { select: { deposits: true } },
    },
  });
  return agents.map((a) => agentShape(a, { depositCount: a._count.deposits }));
}

export async function getAgentReconciliation(db = prisma) {
  const [agents, floatAgg, depositAgg, ledgerGroups, pendingDeposits] = await Promise.all([
    db.agentProfile.findMany({
      orderBy: { agentCode: 'asc' },
      include: {
        user: { select: { name: true, phone: true, handle: true } },
        _count: { select: { deposits: { where: { status: 'confirmed' } } } },
      },
    }),
    db.agentProfile.aggregate({ _sum: { floatBalance: true, floatLimit: true } }),
    db.agentDeposit.aggregate({
      where: { status: 'confirmed' },
      _sum: { amountXof: true },
      _count: true,
    }),
    db.agentFloatEntry.groupBy({
      by: ['type'],
      _sum: { amountXof: true },
      _count: true,
    }),
    db.agentDeposit.count({ where: { status: 'pending', expiresAt: { gt: new Date() } } }),
  ]);

  const topUps = ledgerGroups.find((g) => g.type === 'top_up')?._sum.amountXof ?? 0;
  const payouts = ledgerGroups.find((g) => g.type === 'deposit_payout')?._sum.amountXof ?? 0;
  const totalFloat = floatAgg._sum.floatBalance ?? 0;
  const totalPaidOut = Math.abs(payouts);

  return {
    agents: agents.map((a) =>
      agentShape(a, {
        confirmedDeposits: a._count.deposits,
      }),
    ),
    summary: {
      agentCount: agents.length,
      totalFloatBalanceXof: totalFloat,
      totalFloatLimitXof: floatAgg._sum.floatLimit ?? 0,
      totalConfirmedDepositsXof: depositAgg._sum.amountXof ?? 0,
      confirmedDepositCount: depositAgg._count ?? 0,
      pendingDepositSessions: pendingDeposits,
      ledgerTopUpsXof: topUps,
      ledgerPayoutsXof: payouts,
      /** Cash agents should hold ≈ top-ups − float remaining */
      impliedCashHeldXof: topUps + payouts - totalFloat,
      floatLedgerByType: ledgerGroups.map((g) => ({
        type: g.type,
        totalXof: g._sum.amountXof ?? 0,
        count: g._count,
      })),
    },
  };
}

export async function createAgentWithdrawSession(userId, amountXof) {
  if (amountXof < 500) throw new AgentError('Minimum 500 FCFA', 'amount_too_low');
  if (amountXof > AGENT_TIER_DEFAULTS[AGENT_TIER_BUSINESS].maxWithdrawXof) {
    throw new AgentError('Maximum 5 000 000 FCFA par retrait', 'amount_too_high');
  }

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { wallet: true },
  });
  if (!user.wallet) throw new AgentError('Wallet introuvable', 'wallet_missing');

  const koriRequired = nationalToKori(amountXof, user.country ?? 'SN');
  if (user.wallet.koriBalance < koriRequired) {
    throw new AgentError('Solde insuffisant', 'insufficient_balance');
  }

  const token = depositToken();
  const ref = reference('AGW');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  const withdrawal = await prisma.agentWithdrawal.create({
    data: {
      reference: ref,
      token,
      userId,
      amountXof,
      status: 'pending',
      expiresAt,
    },
  });

  return {
    ...agentWithdrawShape(withdrawal, user),
    qrUrl: buildAgentWithdrawUrl(token),
    requiresBusinessAgent: amountXof > LARGE_WITHDRAW_THRESHOLD_XOF,
  };
}

export async function getAgentWithdrawByReference(reference, userId) {
  const withdrawal = await prisma.agentWithdrawal.findUnique({
    where: { reference },
    include: { user: { select: { id: true, name: true, phone: true, handle: true, verificationTier: true } } },
  });
  if (!withdrawal || withdrawal.userId !== userId) return null;
  return agentWithdrawShape(withdrawal, withdrawal.user);
}

export async function scanAgentWithdraw(token, agentUserId) {
  const agent = await requireActiveAgent(agentUserId);

  const withdrawal = await prisma.agentWithdrawal.findUnique({
    where: { token },
    include: { user: { select: { id: true, name: true, phone: true, handle: true, verificationTier: true } } },
  });
  if (!withdrawal) throw new AgentError('QR invalide', 'not_found');
  if (withdrawal.status !== 'pending') throw new AgentError('Retrait déjà traité', 'already_processed');
  if (withdrawal.expiresAt < new Date()) throw new AgentError('QR expiré — demande un nouveau code', 'expired');

  if (withdrawal.amountXof > (agent.maxWithdrawXof ?? tierDefaults(agent.tier).maxWithdrawXof)) {
    throw new AgentError('Montant trop élevé pour ce point — dirige vers un agent business', 'amount_too_high');
  }
  if (
    withdrawal.amountXof > LARGE_WITHDRAW_THRESHOLD_XOF &&
    (agent.tier ?? AGENT_TIER_STANDARD) !== AGENT_TIER_BUSINESS
  ) {
    throw new AgentError('Gros retrait — agent business K21 requis', 'business_agent_required');
  }
  if (agent.floatBalance + withdrawal.amountXof > agent.floatLimit) {
    throw new AgentError('Float agent insuffisant pour ce retrait', 'insufficient_float');
  }

  return agentWithdrawShape(withdrawal, withdrawal.user);
}

export async function confirmAgentWithdraw(withdrawalId, agentUserId) {
  const agent = await requireActiveAgent(agentUserId);

  return runMoneyTransaction(prisma, async (tx) => {
    await tx.$executeRaw`SELECT id FROM "AgentProfile" WHERE id = ${agent.id} FOR UPDATE`;
    await tx.$executeRaw`SELECT id FROM "AgentWithdrawal" WHERE id = ${withdrawalId} FOR UPDATE`;

    const withdrawal = await tx.agentWithdrawal.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal || withdrawal.status !== 'pending') {
      throw new AgentError('Retrait invalide', 'invalid_withdrawal');
    }
    if (withdrawal.expiresAt < new Date()) {
      throw new AgentError('QR expiré', 'expired');
    }

    const agentRow = await tx.agentProfile.findUniqueOrThrow({ where: { id: agent.id } });
    if (withdrawal.amountXof > (agentRow.maxWithdrawXof ?? tierDefaults(agentRow.tier).maxWithdrawXof)) {
      throw new AgentError('Montant trop élevé pour ce point', 'amount_too_high');
    }
    if (
      withdrawal.amountXof > LARGE_WITHDRAW_THRESHOLD_XOF &&
      (agentRow.tier ?? AGENT_TIER_STANDARD) !== AGENT_TIER_BUSINESS
    ) {
      throw new AgentError('Gros retrait — agent business requis', 'business_agent_required');
    }
    if (agentRow.floatBalance + withdrawal.amountXof > agentRow.floatLimit) {
      throw new AgentError('Float agent insuffisant', 'insufficient_float');
    }

    const user = await tx.user.findUniqueOrThrow({
      where: { id: withdrawal.userId },
      include: { wallet: true },
    });
    if (!user.wallet) throw new AgentError('Wallet introuvable', 'wallet_missing');

    const koriAmount = nationalToKori(withdrawal.amountXof, user.country ?? 'SN');
    await debitNational(tx, {
      walletId: user.wallet.id,
      userId: user.id,
      amount: koriAmount,
      reference: withdrawal.reference,
      ledger: {
        type: 'agent_withdraw',
        counterpartyName: agentRow.displayName,
        counterpartyHandle: agentRow.agentCode,
        note: `Retrait agent ${agentRow.agentCode}`,
      },
    });

    const newFloat = agentRow.floatBalance + withdrawal.amountXof;
    await tx.agentProfile.update({
      where: { id: agent.id },
      data: { floatBalance: newFloat },
    });

    await tx.agentFloatEntry.create({
      data: {
        agentId: agent.id,
        type: 'withdraw_collect',
        amountXof: withdrawal.amountXof,
        balanceAfter: newFloat,
        reference: `${withdrawal.reference}-FLOAT`,
        withdrawalId: withdrawal.id,
        note: `Cash-out ${user.name ?? user.phone}`,
      },
    });

    await tx.agentWithdrawal.update({
      where: { id: withdrawal.id },
      data: {
        status: 'confirmed',
        agentId: agent.id,
        confirmedAt: new Date(),
      },
    });

    const wallet = await tx.wallet.findUnique({ where: { id: user.wallet.id } });
    return {
      withdrawal: agentWithdrawShape(withdrawal, user),
      wallet: wallet
        ? { balance: wallet.balance, koriBalance: wallet.koriBalance, currency: wallet.currency }
        : null,
      agentFloatBalance: newFloat,
    };
  });
}

export function floatTopUpRequestShape(row) {
  return {
    id: row.id,
    agentId: row.agentId,
    amountXof: row.amountXof,
    note: row.note,
    status: row.status,
    responseNote: row.responseNote,
    createdAt: row.createdAt.toISOString(),
    respondedAt: row.respondedAt?.toISOString() ?? null,
    agent: row.agent
      ? {
          id: row.agent.id,
          agentCode: row.agent.agentCode,
          displayName: row.agent.displayName,
          floatBalance: row.agent.floatBalance,
          floatLimit: row.agent.floatLimit,
        }
      : undefined,
  };
}

/** Agent asks for more float instead of having to find K21 support outside the app. */
export async function requestAgentFloatTopUp(userId, amountXof, note) {
  const agent = await requireActiveAgent(userId);
  if (!Number.isInteger(amountXof) || amountXof <= 0) {
    throw new AgentError('Montant invalide', 'amount_too_low');
  }

  const pending = await prisma.agentFloatTopUpRequest.findFirst({
    where: { agentId: agent.id, status: 'pending' },
  });
  if (pending) throw new AgentError('Une demande est déjà en attente', 'already_processed');

  if (agent.floatBalance + amountXof > agent.floatLimit) {
    throw new AgentError('Dépasse la limite de float de ton palier', 'float_limit');
  }

  const row = await prisma.agentFloatTopUpRequest.create({
    data: { agentId: agent.id, amountXof, note: note?.trim() || null },
    include: { agent: true },
  });
  return floatTopUpRequestShape(row);
}

export async function getMyFloatTopUpRequests(userId, limit = 20) {
  const agent = await getAgentByUserId(userId);
  if (!agent) return [];
  const rows = await prisma.agentFloatTopUpRequest.findMany({
    where: { agentId: agent.id },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows.map((r) => floatTopUpRequestShape(r));
}

export async function listFloatTopUpRequests(status = 'pending') {
  const rows = await prisma.agentFloatTopUpRequest.findMany({
    where: status ? { status } : undefined,
    include: { agent: { include: { user: { select: { id: true, name: true, phone: true, handle: true } } } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    ...floatTopUpRequestShape(r),
    agentUser: r.agent?.user
      ? { id: r.agent.user.id, name: r.agent.user.name, phone: r.agent.user.phone, handle: r.agent.user.handle }
      : null,
  }));
}

export async function approveFloatTopUpRequest(requestId, adminId, responseNote) {
  const request = await prisma.agentFloatTopUpRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new AgentError('Demande introuvable', 'not_found');
  if (request.status !== 'pending') throw new AgentError('Demande déjà traitée', 'already_processed');

  await topUpAgentFloat(request.agentId, request.amountXof, adminId, responseNote ?? 'Recharge approuvée');

  const updated = await prisma.agentFloatTopUpRequest.update({
    where: { id: requestId },
    data: { status: 'approved', adminId, responseNote: responseNote ?? null, respondedAt: new Date() },
    include: { agent: true },
  });

  await createInAppNotification(
    updated.agent.userId,
    'Rechargement approuvé ✓',
    `${amountXofLabel(request.amountXof)} ajoutés à ton float.`,
    { kind: 'agent_float_topup_approved', refId: requestId },
  );

  return floatTopUpRequestShape(updated);
}

export async function rejectFloatTopUpRequest(requestId, adminId, reason) {
  const request = await prisma.agentFloatTopUpRequest.findUnique({ where: { id: requestId }, include: { agent: true } });
  if (!request) throw new AgentError('Demande introuvable', 'not_found');
  if (request.status !== 'pending') throw new AgentError('Demande déjà traitée', 'already_processed');

  const updated = await prisma.agentFloatTopUpRequest.update({
    where: { id: requestId },
    data: { status: 'rejected', adminId, responseNote: reason ?? null, respondedAt: new Date() },
    include: { agent: true },
  });

  await createInAppNotification(
    request.agent.userId,
    'Rechargement refusé',
    reason ?? 'Contacte le support K21 pour plus de détails.',
    { kind: 'agent_float_topup_rejected', refId: requestId },
  );

  return floatTopUpRequestShape(updated);
}

function amountXofLabel(amountXof) {
  return `${Math.round(amountXof).toLocaleString('fr-FR')} F`;
}

export async function patchAgentProfile(agentId, { tier, maxWithdrawXof, maxDepositXof, floatLimit, status }) {
  const agent = await prisma.agentProfile.findUnique({ where: { id: agentId } });
  if (!agent) throw new AgentError('Agent introuvable', 'not_found');

  const nextTier = tier ?? agent.tier ?? AGENT_TIER_STANDARD;
  const defs = tierDefaults(nextTier);

  const updated = await prisma.agentProfile.update({
    where: { id: agentId },
    data: {
      tier: tier ?? undefined,
      maxWithdrawXof: maxWithdrawXof ?? (tier ? defs.maxWithdrawXof : undefined),
      maxDepositXof: maxDepositXof ?? (tier ? defs.maxDepositXof : undefined),
      floatLimit: floatLimit ?? (tier ? defs.floatLimit : undefined),
      status: status ?? undefined,
    },
    include: { user: { select: { id: true, name: true, phone: true, handle: true } } },
  });

  return agentShape(updated);
}
