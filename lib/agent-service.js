import { prisma } from './prisma.js';
import { reference } from '../api/_lib/auth.js';
import { lockProjections, runMoneyTransaction } from './wallet-atomic.js';
import { coordsFromArrondissement } from './dakar-coords.js';
import { createInAppNotification } from './notify-service.js';
import { agentFloatTopUp } from './money-kernel/flows.js';
import { normalizeStatus } from './agents/lifecycle.js';

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

function maskPhone(phone) {
  const p = String(phone ?? '');
  if (!p || p.startsWith('e:')) return '';
  return `•••• ${p.slice(-4)}`;
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
          // Shown to the agent at the counter: enough to recognise the
          // customer, not their full phone number or internal id.
          name: user.name ?? '',
          phone: maskPhone(user.phone),
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
          // Shown to the agent at the counter: enough to recognise the
          // customer, not their full phone number or internal id.
          name: user.name ?? '',
          phone: maskPhone(user.phone),
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
  if (!agent || normalizeStatus(agent.status) !== 'active') {
    throw new AgentError('Profil agent inactif', 'agent_inactive');
  }
  return agent;
}

export async function getAgentDepositByReference(reference, userId) {
  const deposit = await prisma.agentDeposit.findUnique({
    where: { reference },
    include: { user: { select: { id: true, name: true, phone: true, handle: true, verificationTier: true } } },
  });
  if (!deposit || deposit.userId !== userId) return null;
  return agentDepositShape(deposit, deposit.user);
}

export async function getAgentApplication(userId, db = prisma) {
  const agent = await getAgentByUserId(userId, db);
  if (!agent) return null;
  const status = normalizeStatus(agent.status);
  const MSG = {
    applied: 'Demande reçue — vérification d’identité à venir.',
    under_review: 'Identité vérifiée — revue en cours.',
    approved: 'Demande approuvée — activation par un second opérateur.',
    active: 'Point agent actif.',
    suspended: 'Point agent suspendu — contacte le support.',
    terminated: 'Contrat agent terminé.',
    rejected: 'Demande refusée — tu peux contacter le support.',
  };
  return { ...agentShape(agent), status, canOperate: status === 'active', message: MSG[status] ?? '' };
}

export async function listAgentFloatEntries(agentId, limit = 50) {
  return prisma.agentFloatEntry.findMany({
    where: { agentId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
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
      // J6.14: never store more precision than needed (~1 km); discovery uses service points.
      lat: resolvedLat != null ? Math.round(resolvedLat * 100) / 100 : agent.lat,
      lng: resolvedLng != null ? Math.round(resolvedLng * 100) / 100 : agent.lng,
    },
    include: { user: { select: { id: true, name: true, phone: true, handle: true } } },
  });
  return agentShape(updated);
}

/**
 * J6: applications go through lib/agents/lifecycle.js (applied → identity →
 * review → maker-checker activation). These wrappers keep the old call
 * shapes for operators / tests; neither ever activates anyone.
 */
export async function applyForAgentProfile({ userId, displayName, locationLabel, arrondissement, lat, lng, servicePoint, agentType, businessId }) {
  const { applyAsAgent } = await import('./agents/lifecycle.js');
  const profile = await applyAsAgent(userId, { displayName, locationLabel, arrondissement, lat, lng, servicePoint, agentType, businessId });
  return agentShape(profile);
}

/** Operator-initiated application on behalf of a user (POST admin/agents): same lifecycle, still `applied`. */
export async function createAgentProfile({ userId, displayName, locationLabel, servicePoint, tier }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AgentError('Utilisateur introuvable', 'user_not_found');
  if (await prisma.agentProfile.findUnique({ where: { userId } })) throw new AgentError('Déjà agent K21', 'already_agent');
  const profile = await applyForAgentProfile({ userId, displayName, locationLabel, servicePoint });
  if (tier === AGENT_TIER_BUSINESS) {
    // A business tier is a limit profile only; it is granted to business agents at review.
    await prisma.agentProfile.update({ where: { id: profile.id }, data: { tier: AGENT_TIER_BUSINESS, ...tierDefaults(AGENT_TIER_BUSINESS) } });
  }
  return agentShape(await prisma.agentProfile.findUniqueOrThrow({ where: { id: profile.id }, include: { user: { select: { id: true, name: true, phone: true, handle: true } } } }));
}

export async function topUpAgentFloat(agentId, amountXof, adminId, note, { reference: topUpRef = reference('AFT') } = {}) {
  if (amountXof <= 0) throw new AgentError('Montant invalide', 'amount_too_low');

  // J3: a float top-up is a finance action. It never activates an agent —
  // activation is the compliance onboarding decision (approveAgentProfile).
  const result = await runMoneyTransaction(prisma, async (tx) => {
    await lockProjections(tx, { AgentProfile: [agentId] });
    const agent = await tx.agentProfile.findUniqueOrThrow({ where: { id: agentId } });
    const already = await tx.journalEntry.findUnique({ where: { reference: topUpRef } });
    if (already) {
      return { floatBalance: agent.floatBalance, floatLimit: agent.floatLimit, status: agent.status, replayed: true };
    }
    if (['rejected', 'terminated'].includes(normalizeStatus(agent.status))) {
      throw new AgentError('Agent refusé ou révoqué — pas de float', 'agent_inactive');
    }
    const newFloat = agent.floatBalance + amountXof;
    if (newFloat > agent.floatLimit) {
      throw new AgentError('Dépasse la limite de float', 'float_limit');
    }

    await agentFloatTopUp(tx, { agentId, amountMinor: amountXof, reference: topUpRef, adminId, note: note ?? 'Recharge admin' });

    return { floatBalance: newFloat, floatLimit: agent.floatLimit, status: agent.status };
  });

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

export async function getAgentWithdrawByReference(reference, userId) {
  const withdrawal = await prisma.agentWithdrawal.findUnique({
    where: { reference },
    include: { user: { select: { id: true, name: true, phone: true, handle: true, verificationTier: true } } },
  });
  if (!withdrawal || withdrawal.userId !== userId) return null;
  return agentWithdrawShape(withdrawal, withdrawal.user);
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

export async function patchAgentProfile(agentId, { tier, maxWithdrawXof, maxDepositXof, floatLimit }) {
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
      // J6: status is never patched — lifecycle transitions only (lib/agents/lifecycle.js).
    },
    include: { user: { select: { id: true, name: true, phone: true, handle: true } } },
  });

  return agentShape(updated);
}
