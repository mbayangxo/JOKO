import { prisma } from '../prisma.js';
import { OrgAccessError, requireBusinessCapability } from '../business-access.js';
import { businessAccess } from './identity.js';
import { emitCommerceEvent } from '../commerce/events.js';
import { createInAppNotification } from '../notify-service.js';

/**
 * J5 distribution foundation (docs/JOKKO-ECONOMIC-OS-ARCHITECTURE.md §6).
 *
 * Distributor → territory → reps → merchant relationships → wholesale catalog
 * → orders / invoices / terms → fulfilment → collections → returns.
 * J5 builds the identity + relationship layer; wholesale ordering reuses the
 * existing B2B order / trade-account / invoice model; routes, collections and
 * returns are DORMANT until J7/J8.
 *
 * THE RULE: inviting or assisting a merchant creates NO ownership and NO
 * access. The merchant (its owner, or a member with
 * business.relationships.manage) accepts; the relationship then carries
 * explicit scopes (wholesale catalog / ordering). It never grants membership,
 * so the distributor still cannot see the merchant's wallet, sales,
 * suppliers, payroll, customers, transactions or private information.
 */
export const DISTRIBUTION_MODES = new Set(['distribution', 'wholesale', 'manufacturer']);
export const RELATIONSHIP_SCOPES = ['wholesale_catalog', 'wholesale_ordering'];

export class DistributionError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'DistributionError';
    this.code = code;
    this.status = status;
  }
}

async function requireDistributor(userId, businessId, capability) {
  const business = await requireBusinessCapability(userId, businessId, capability);
  if (!DISTRIBUTION_MODES.has(business.operatingMode)) {
    throw new DistributionError('not_a_distributor', 'Activez le mode distribution / grossiste pour ce commerce', 409);
  }
  return business;
}

export async function createTerritory(userId, distributorId, { name, region, department, communes }) {
  await requireDistributor(userId, distributorId, 'business.distribution.manage');
  const t = await prisma.territory.create({ data: { distributorBusinessId: distributorId, name, region: region ?? null, department: department ?? null, communes: communes ?? null } });
  return { id: t.id, name: t.name, region: t.region, department: t.department, communes: t.communes, active: t.active };
}

export async function listTerritories(userId, distributorId) {
  await requireDistributor(userId, distributorId, 'business.distribution.invite');
  const rows = await prisma.territory.findMany({ where: { distributorBusinessId: distributorId }, orderBy: { createdAt: 'asc' } });
  return rows.map((t) => ({ id: t.id, name: t.name, region: t.region, department: t.department, communes: t.communes, active: t.active }));
}

/**
 * Invite an existing merchant business (by id) or assist a person who has no
 * business yet (by handle). Either way: status 'invited', no access.
 */
export async function inviteMerchant(userId, distributorId, { merchantBusinessId, merchantHandle, territoryId, assisted = false }) {
  const distributor = await requireDistributor(userId, distributorId, 'business.distribution.invite');
  if (!merchantBusinessId === !merchantHandle) throw new DistributionError('invalid', 'Indique un commerce OU un @identifiant', 400);
  if (territoryId) {
    const t = await prisma.territory.findFirst({ where: { id: territoryId, distributorBusinessId: distributorId, active: true } });
    if (!t) throw new DistributionError('territory_not_found', 'Territoire introuvable', 404);
  }
  let target = {};
  let notifyUserId;
  if (merchantBusinessId) {
    if (merchantBusinessId === distributorId) throw new DistributionError('invalid', 'Un distributeur ne s’invite pas lui-même', 400);
    const m = await prisma.business.findUnique({ where: { id: merchantBusinessId }, select: { id: true, ownerId: true } });
    if (!m) throw new DistributionError('merchant_not_found', 'Commerce introuvable', 404);
    target = { merchantBusinessId: m.id };
    notifyUserId = m.ownerId;
  } else {
    const u = await prisma.user.findFirst({ where: { handle: String(merchantHandle).replace(/^@/, '').toLowerCase() }, select: { id: true } });
    if (!u) throw new DistributionError('user_not_found', 'Utilisateur introuvable', 404);
    target = { invitedUserId: u.id };
    notifyUserId = u.id;
  }
  const open = await prisma.merchantRelationship.findFirst({ where: { distributorBusinessId: distributorId, ...target, status: { in: ['invited', 'active'] } } });
  if (open) return relationshipForDistributor(open);
  const rel = await prisma.$transaction(async (tx) => {
    const r = await tx.merchantRelationship.create({
      data: { distributorBusinessId: distributorId, ...target, introducedByUserId: userId, territoryId: territoryId ?? null, assistedOnboarding: Boolean(assisted || merchantHandle) },
    });
    await emitCommerceEvent(tx, { type: 'relationship.invited', businessId: distributorId, aggregateType: 'merchant_relationship', aggregateId: r.id, payload: { territoryId: territoryId ?? null } });
    return r;
  });
  await createInAppNotification(notifyUserId, 'Invitation distributeur', `${distributor.name} propose une relation commerciale (catalogue et commandes en gros). Elle ne donne aucun accès à ton commerce.`, { kind: 'distribution_invitation', refId: rel.id }).catch(() => {});
  return relationshipForDistributor(rel);
}

async function relationshipForDistributor(r) {
  const [merchant, introducer, territory] = await Promise.all([
    r.merchantBusinessId ? prisma.business.findUnique({ where: { id: r.merchantBusinessId }, select: { name: true, category: true, verified: true } }) : null,
    prisma.user.findUnique({ where: { id: r.introducedByUserId }, select: { handle: true } }),
    r.territoryId ? prisma.territory.findUnique({ where: { id: r.territoryId }, select: { name: true } }) : null,
  ]);
  // Only what the relationship legitimately needs: who, where, status — never money or operations.
  return {
    id: r.id,
    status: r.status,
    merchant: merchant ? { name: merchant.name, category: merchant.category, verified: merchant.verified } : { pendingOnboarding: true },
    territory: territory?.name ?? null,
    introducedBy: introducer?.handle ?? null,
    assistedOnboarding: r.assistedOnboarding,
    scopes: JSON.parse(r.scopesJson),
    invitedAt: r.invitedAt.toISOString(),
    respondedAt: r.respondedAt?.toISOString() ?? null,
    endedAt: r.endedAt?.toISOString() ?? null,
  };
}

/** Distributor view: managers see all; reps see the relationships they introduced or were assigned (J7.4). Paginated variant: lib/b2b/network.js relationshipsPage. */
export async function distributorRelationships(userId, distributorId) {
  await requireDistributor(userId, distributorId, 'business.distribution.invite');
  const caps = new Set((await businessAccess(userId, distributorId)).capabilities);
  const rows = await prisma.merchantRelationship.findMany({
    where: { distributorBusinessId: distributorId, ...(caps.has('business.distribution.manage') ? {} : { OR: [{ introducedByUserId: userId }, { assignedRepUserId: userId }] }) },
    orderBy: { invitedAt: 'desc' },
    take: 500,
  });
  return Promise.all(rows.map(relationshipForDistributor));
}

/** Merchant view of its distributor relationships. */
export async function merchantRelationships(userId, merchantId) {
  await requireBusinessCapability(userId, merchantId, 'business.relationships.manage');
  const rows = await prisma.merchantRelationship.findMany({ where: { merchantBusinessId: merchantId }, orderBy: { invitedAt: 'desc' } });
  const dists = await prisma.business.findMany({ where: { id: { in: rows.map((r) => r.distributorBusinessId) } }, select: { id: true, name: true, verified: true } });
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    distributor: dists.find((d) => d.id === r.distributorBusinessId) ? { name: dists.find((d) => d.id === r.distributorBusinessId).name, verified: dists.find((d) => d.id === r.distributorBusinessId).verified } : null,
    scopes: JSON.parse(r.scopesJson),
    assistedOnboarding: r.assistedOnboarding,
    invitedAt: r.invitedAt.toISOString(),
  }));
}

/** Invitations addressed to a PERSON (assisted onboarding before they had a business). */
export async function myDistributionInvitations(userId) {
  const rows = await prisma.merchantRelationship.findMany({ where: { invitedUserId: userId, status: 'invited' }, orderBy: { invitedAt: 'desc' } });
  const dists = await prisma.business.findMany({ where: { id: { in: rows.map((r) => r.distributorBusinessId) } }, select: { id: true, name: true } });
  return rows.map((r) => ({ id: r.id, distributor: dists.find((d) => d.id === r.distributorBusinessId)?.name ?? null, scopes: JSON.parse(r.scopesJson), invitedAt: r.invitedAt.toISOString() }));
}

/**
 * Accept / decline. For a business invitation: a member of that merchant
 * with business.relationships.manage. For a person invitation: that person,
 * attaching a business THEY OWN (assisted onboarding ends here).
 */
export async function respondToRelationship(userId, relationshipId, { accept, merchantBusinessId }) {
  const r = await prisma.merchantRelationship.findUnique({ where: { id: relationshipId } });
  if (!r || r.status !== 'invited') throw new DistributionError('not_found', 'Invitation introuvable', 404);
  let merchantId = r.merchantBusinessId;
  if (merchantId) {
    await requireBusinessCapability(userId, merchantId, 'business.relationships.manage').catch(() => {
      throw new DistributionError('not_found', 'Invitation introuvable', 404);
    });
  } else {
    if (r.invitedUserId !== userId) throw new DistributionError('not_found', 'Invitation introuvable', 404);
    if (accept) {
      const owned = merchantBusinessId ? await prisma.business.findFirst({ where: { id: merchantBusinessId, ownerId: userId } }) : null;
      if (!owned) throw new DistributionError('own_business_required', 'Choisis un commerce dont tu es propriétaire', 400);
      if (owned.id === r.distributorBusinessId) throw new DistributionError('invalid', 'Relation avec soi-même impossible', 400);
      merchantId = owned.id;
    }
  }
  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const res = await tx.merchantRelationship.updateMany({
      where: { id: r.id, status: 'invited' },
      data: { status: accept ? 'active' : 'declined', respondedAt: now, respondedBy: userId, ...(accept && !r.merchantBusinessId ? { merchantBusinessId: merchantId } : {}) },
    });
    if (res.count !== 1) throw new DistributionError('conflict', 'Invitation déjà traitée', 409);
    if (accept) await emitCommerceEvent(tx, { type: 'relationship.accepted', businessId: r.distributorBusinessId, aggregateType: 'merchant_relationship', aggregateId: r.id, payload: {} });
    return tx.merchantRelationship.findUnique({ where: { id: r.id } });
  });
  return { id: updated.id, status: updated.status };
}

/** Either side ends a relationship; history is kept. */
export async function endRelationship(userId, relationshipId) {
  const r = await prisma.merchantRelationship.findUnique({ where: { id: relationshipId } });
  if (!r || !['invited', 'active'].includes(r.status)) throw new DistributionError('not_found', 'Relation introuvable', 404);
  const asDistributor = await requireBusinessCapability(userId, r.distributorBusinessId, 'business.distribution.manage').then(() => true, () => false);
  const asMerchant = r.merchantBusinessId
    ? await requireBusinessCapability(userId, r.merchantBusinessId, 'business.relationships.manage').then(() => true, () => false)
    : r.invitedUserId === userId;
  if (!asDistributor && !asMerchant) throw new DistributionError('not_found', 'Relation introuvable', 404);
  await prisma.$transaction(async (tx) => {
    const res = await tx.merchantRelationship.updateMany({ where: { id: r.id, status: { in: ['invited', 'active'] } }, data: { status: 'ended', endedAt: new Date(), endedBy: userId } });
    if (res.count !== 1) throw new DistributionError('conflict', 'Relation déjà terminée', 409);
    await emitCommerceEvent(tx, { type: 'relationship.ended', businessId: r.distributorBusinessId, aggregateType: 'merchant_relationship', aggregateId: r.id, payload: { by: asDistributor ? 'distributor' : 'merchant' } });
  });
  return { id: r.id, status: 'ended' };
}

/** Wholesale ordering scope check — the ONLY thing an active relationship enables. */
export async function hasActiveRelationship(distributorId, merchantId, scope = 'wholesale_ordering') {
  const r = await prisma.merchantRelationship.findFirst({ where: { distributorBusinessId: distributorId, merchantBusinessId: merchantId, status: 'active' } });
  return Boolean(r && JSON.parse(r.scopesJson).includes(scope));
}

export function assertKnownOperatingMode(mode) {
  if (!['retail', 'services', 'restaurant', 'distribution', 'wholesale', 'manufacturer', 'cooperative'].includes(mode)) throw new OrgAccessError('Mode inconnu', 400);
}
