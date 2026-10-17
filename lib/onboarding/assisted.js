import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { requireBusinessCapability } from '../business-access.js';
import { DISTRIBUTION_MODES } from '../business/distribution.js';
import { ensureBusinessWallet } from '../business-wallet-service.js';
import { recordIdentityEvent } from '../identity/audit.js';
import { requireOperatingAgent } from '../agents/lifecycle.js';

/**
 * J6.12 — assisted merchant onboarding (reusable by distributors and by agent
 * service points permitted for merchant assistance).
 *
 *   rep starts (introducer org + rep + territory recorded)
 *     → merchant, on THEIR OWN account, verifies identity (J3 KYC tier ≥ 2)
 *     → confirms the business and their authority over it
 *     → accepts → the business is created with the MERCHANT as owner.
 *
 * The rep never becomes owner, manager, finance, payroll or a financial agent
 * of that business; no membership, capability or money access is created for
 * the rep or the introducing organization. The introduction is a record only.
 */
export class AssistError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'AssistError';
    this.code = code;
    this.status = status;
  }
}

const TTL_MS = 7 * 86_400_000;
const hash = (c) => crypto.createHash('sha256').update(`assist:${String(c).trim().toUpperCase()}`).digest('hex');

export async function startAssist(repUserId, { introducerType, introducerId, territoryId, proposedName, proposedCategory }) {
  const name = String(proposedName ?? '').trim();
  if (name.length < 2 || name.length > 80) throw new AssistError('invalid_name', 'Nom du commerce requis', 400);
  if (introducerType === 'distribution_business') {
    await requireBusinessCapability(repUserId, String(introducerId), 'business.distribution.invite');
    const b = await prisma.business.findUnique({ where: { id: String(introducerId) }, select: { operatingMode: true, status: true } });
    if (!b || !DISTRIBUTION_MODES.has(b.operatingMode) || b.status !== 'active') throw new AssistError('not_distributor', 'Réservé aux distributeurs actifs', 403);
    if (territoryId) {
      const t = await prisma.territory.findUnique({ where: { id: String(territoryId) } });
      if (!t || t.distributorBusinessId !== String(introducerId)) throw new AssistError('invalid_territory', 'Territoire inconnu', 400);
    }
  } else if (introducerType === 'agent_organization') {
    const { agent, servicePoint } = await requireOperatingAgent(prisma, repUserId);
    if (!servicePoint.merchantAssistPermitted || !servicePoint.merchantAssist) throw new AssistError('merchant_assist_not_permitted', 'Assistance marchands non autorisée pour ce point', 403);
    if (String(introducerId) !== agent.organizationId) throw new AssistError('wrong_organization', 'Organisation incorrecte', 403);
  } else {
    throw new AssistError('invalid_introducer', 'introducerType: distribution_business | agent_organization', 400);
  }
  const code = crypto.randomBytes(5).toString('hex').toUpperCase();
  const row = await prisma.merchantOnboardingAssist.create({
    data: {
      introducerType, introducerId: String(introducerId), repUserId, territoryId: territoryId ? String(territoryId) : null,
      codeHash: hash(code), proposedName: name, proposedCategory: proposedCategory ? String(proposedCategory).slice(0, 60) : null,
      expiresAt: new Date(Date.now() + TTL_MS),
    },
  });
  return { id: row.id, code, status: row.status, expiresAt: row.expiresAt.toISOString() };
}

async function byCode(db, code) {
  const row = await db.merchantOnboardingAssist.findUnique({ where: { codeHash: hash(code) } });
  if (!row) throw new AssistError('invalid_code', 'Code invalide', 404);
  if (row.expiresAt <= new Date() && !['accepted', 'declined'].includes(row.status)) throw new AssistError('expired', 'Code expiré', 409);
  return row;
}

/** The merchant opens the invitation on their own account: sees who introduced them, nothing else happens. */
export async function openAssist(merchantUserId, code) {
  const row = await byCode(prisma, code);
  if (row.repUserId === merchantUserId) throw new AssistError('self_assist', 'Le commercial ne peut pas accepter pour le marchand', 403);
  const user = await prisma.user.findUnique({ where: { id: merchantUserId }, select: { verificationTier: true } });
  const introducer = row.introducerType === 'distribution_business'
    ? (await prisma.business.findUnique({ where: { id: row.introducerId }, select: { name: true } }))?.name
    : (await prisma.agentOrganization.findUnique({ where: { id: row.introducerId }, select: { name: true } }))?.name;
  return {
    status: row.status,
    proposedName: row.proposedName,
    proposedCategory: row.proposedCategory,
    introducer: { type: row.introducerType, name: introducer ?? null },
    identityVerified: (user?.verificationTier ?? 1) >= 2,
    nextStep: (user?.verificationTier ?? 1) >= 2 ? 'Confirme ton commerce et ton autorité, puis accepte.' : 'Vérifie d’abord ton identité (CNI) dans ton profil.',
    youWillOwn: true,
    introducerGetsAccess: false,
  };
}

export async function acceptAssist(merchantUserId, code, { businessName, category, confirmAuthority }) {
  if (confirmAuthority !== true) throw new AssistError('authority_unconfirmed', 'Confirme que tu es responsable de ce commerce', 400);
  return prisma.$transaction(async (tx) => {
    const row0 = await byCode(tx, code);
    await tx.$executeRaw`SELECT id FROM "MerchantOnboardingAssist" WHERE id = ${row0.id} FOR UPDATE`;
    const row = await tx.merchantOnboardingAssist.findUnique({ where: { id: row0.id } });
    if (row.status === 'accepted') {
      if (row.merchantUserId !== merchantUserId) throw new AssistError('invalid_code', 'Code invalide', 404);
      return { businessId: row.businessId, status: 'accepted', replayed: true };
    }
    if (row.status !== 'started') throw new AssistError('not_open', `Invitation ${row.status}`);
    if (row.repUserId === merchantUserId) throw new AssistError('self_assist', 'Le commercial ne peut pas accepter pour le marchand', 403);
    const user = await tx.user.findUnique({ where: { id: merchantUserId }, select: { verificationTier: true } });
    if ((user?.verificationTier ?? 1) < 2) throw new AssistError('identity_required', 'Vérifie d’abord ton identité (CNI)', 403);
    const name = String(businessName ?? row.proposedName).trim().slice(0, 80);
    const business = await tx.business.create({ data: { ownerId: merchantUserId, name, category: category ? String(category).slice(0, 60) : row.proposedCategory, type: 'merchant', settlementMode: 'business' } });
    await ensureBusinessWallet(business.id, tx);
    await tx.merchantOnboardingAssist.update({ where: { id: row.id }, data: { status: 'accepted', merchantUserId, businessId: business.id, consentAt: new Date() } });
    await recordIdentityEvent(tx, {
      actorType: 'user', actorId: merchantUserId, action: 'merchant_onboarded_assisted', subjectType: 'business', subjectId: business.id,
      after: { introducerType: row.introducerType, introducerId: row.introducerId, repUserId: row.repUserId, territoryId: row.territoryId },
    });
    return { businessId: business.id, status: 'accepted', owner: 'you', introducerAccess: 'none' };
  });
}

export async function declineAssist(merchantUserId, code) {
  const row = await byCode(prisma, code);
  if (row.repUserId === merchantUserId) throw new AssistError('self_assist', 'Refus réservé au marchand', 403);
  const r = await prisma.merchantOnboardingAssist.updateMany({ where: { id: row.id, status: 'started' }, data: { status: 'declined', merchantUserId } });
  if (!r.count) throw new AssistError('not_open', 'Invitation déjà traitée');
  return { status: 'declined' };
}

/** What the rep / introducer may see: status of their own introductions, never the merchant's account. */
export async function listMyAssists(repUserId) {
  const rows = await prisma.merchantOnboardingAssist.findMany({ where: { repUserId }, orderBy: { createdAt: 'desc' }, take: 100 });
  return rows.map((r) => ({ id: r.id, proposedName: r.proposedName, status: r.status === 'started' && r.expiresAt <= new Date() ? 'expired' : r.status, territoryId: r.territoryId, introducerType: r.introducerType, createdAt: r.createdAt.toISOString(), consentAt: r.consentAt?.toISOString() ?? null }));
}
