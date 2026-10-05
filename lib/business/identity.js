import { prisma } from '../prisma.js';
import { BUSINESS_CAPABILITY_LIST, BUSINESS_ROLES } from '../authz/catalog.js';
import { OrgAccessError, requireBusinessCapability } from '../business-access.js';
import { recordIdentityEvent } from '../identity/audit.js';

/**
 * J5 business identity (docs/JOKKO-J5-REPORT.md §1). A business is its own
 * identity: owner (accountable person, Business.ownerId), members with
 * capability-based roles, its own wallet (J2 `business:<id>:wallet`), its own
 * locations, and a verification lifecycle decided by operators — never by
 * the business itself.
 */

export const VERIFICATION_STATES = ['unverified', 'pending', 'verified', 'rejected'];

/** What the caller may do on this business (drives the merchant UI; the server re-checks every action). */
export async function businessAccess(userId, businessId, db = prisma) {
  const business = await db.business.findUnique({ where: { id: businessId }, select: { id: true, ownerId: true } });
  if (!business) throw new OrgAccessError('Business not found', 404);
  if (business.ownerId === userId) {
    return { isOwner: true, roles: ['owner'], capabilities: [...BUSINESS_CAPABILITY_LIST] };
  }
  const rows = await db.businessMember.findMany({ where: { businessId, userId, status: 'active' }, select: { role: true } });
  if (!rows.length) throw new OrgAccessError('Not a member of this business');
  const caps = new Set(rows.flatMap((r) => BUSINESS_ROLES[r.role]?.caps ?? []));
  return { isOwner: false, roles: rows.map((r) => r.role), capabilities: BUSINESS_CAPABILITY_LIST.filter((c) => caps.has(c)) };
}

function locationShape(l) {
  return { id: l.id, name: l.name, address: l.address, lat: l.lat, lng: l.lng, isPrimary: l.isPrimary, active: l.active };
}

/** Every business has exactly one primary location; created lazily for businesses that predate J5. */
export async function ensurePrimaryLocation(businessId, db = prisma) {
  const existing = await db.businessLocation.findFirst({ where: { businessId, isPrimary: true } });
  if (existing) return existing;
  const b = await db.business.findUniqueOrThrow({ where: { id: businessId } });
  return db.businessLocation.create({
    data: { businessId, name: b.name, address: b.address, lat: b.lat, lng: b.lng, isPrimary: true },
  });
}

/** Operating profile for members (owner/staff). Public pages use the existing public shapes. */
export async function businessProfile(userId, businessId) {
  const access = await businessAccess(userId, businessId);
  const b = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
  await ensurePrimaryLocation(businessId);
  const locations = await prisma.businessLocation.findMany({ where: { businessId }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] });
  return {
    id: b.id,
    name: b.name,
    type: b.type,
    category: b.category,
    description: b.description,
    address: b.address,
    phone: access.capabilities.includes('business.profile.manage') ? b.phone : undefined,
    imageUrl: b.imageUrl,
    kebuId: b.kebuId,
    verification: { status: b.verificationStatus, verified: b.verified, note: access.isOwner ? b.verificationNote : undefined, verifiedAt: b.verifiedAt?.toISOString() ?? null },
    settlement: { mode: b.settlementMode, label: b.settlementMode === 'business' ? 'Portefeuille du commerce' : 'Portefeuille personnel du propriétaire (ancien mode)' },
    orderSettings: { pauseOrders: b.pauseOrders, acceptOrdersWhenOutOfStock: b.acceptOrdersWhenOutOfStock, lowStockAlertEnabled: b.lowStockAlertEnabled },
    locations: locations.map(locationShape),
    me: access,
  };
}

export async function updateBusinessProfile(userId, businessId, patch) {
  await requireBusinessCapability(userId, businessId, 'business.profile.manage');
  const data = {};
  for (const k of ['name', 'category', 'description', 'address', 'phone', 'imageUrl', 'lat', 'lng']) if (patch[k] !== undefined) data[k] = patch[k];
  const b = await prisma.business.update({ where: { id: businessId }, data });
  await recordIdentityEvent(prisma, { actorType: 'user', actorId: userId, action: 'business_profile_updated', subjectType: 'business', subjectId: businessId, after: { fields: Object.keys(data) } });
  return { id: b.id, updated: Object.keys(data) };
}

export async function createLocation(userId, businessId, { name, address, lat, lng }) {
  await requireBusinessCapability(userId, businessId, 'business.profile.manage');
  await ensurePrimaryLocation(businessId);
  const l = await prisma.businessLocation.create({ data: { businessId, name, address: address ?? null, lat: lat ?? null, lng: lng ?? null } });
  return locationShape(l);
}

export async function updateLocation(userId, businessId, locationId, patch) {
  await requireBusinessCapability(userId, businessId, 'business.profile.manage');
  const l = await prisma.businessLocation.findFirst({ where: { id: locationId, businessId } });
  if (!l) throw new OrgAccessError('Lieu introuvable', 404);
  if (l.isPrimary && patch.active === false) throw new OrgAccessError('Le lieu principal ne peut pas être désactivé', 409);
  const data = {};
  for (const k of ['name', 'address', 'lat', 'lng', 'active']) if (patch[k] !== undefined) data[k] = patch[k];
  return locationShape(await prisma.businessLocation.update({ where: { id: l.id }, data }));
}

/**
 * Settlement: where customer payments land. One-way switch to the business
 * wallet, by the owner only (it changes where the owner's income lands).
 * Owner draws remain available through the existing treasury transfer.
 */
export async function switchSettlementToBusiness(userId, businessId) {
  const b = await prisma.business.findUnique({ where: { id: businessId } });
  if (!b) throw new OrgAccessError('Business not found', 404);
  if (b.ownerId !== userId) throw new OrgAccessError('Seul le propriétaire peut changer l’encaissement');
  if (b.settlementMode === 'business') return { mode: 'business', changed: false };
  await prisma.$transaction(async (tx) => {
    await tx.business.update({ where: { id: businessId }, data: { settlementMode: 'business' } });
    await recordIdentityEvent(tx, { actorType: 'user', actorId: userId, action: 'business_settlement_changed', subjectType: 'business', subjectId: businessId, before: { mode: b.settlementMode }, after: { mode: 'business' } });
  });
  return { mode: 'business', changed: true };
}

/** The owner asks for verification; operators decide (adminDecideVerification). */
export async function requestVerification(userId, businessId, { note } = {}) {
  const b = await prisma.business.findUnique({ where: { id: businessId } });
  if (!b) throw new OrgAccessError('Business not found', 404);
  if (b.ownerId !== userId) throw new OrgAccessError('Seul le propriétaire peut demander la vérification');
  if (!['unverified', 'rejected'].includes(b.verificationStatus)) return { status: b.verificationStatus, changed: false };
  await prisma.$transaction(async (tx) => {
    await tx.business.update({ where: { id: businessId }, data: { verificationStatus: 'pending', verificationNote: note ?? null } });
    await recordIdentityEvent(tx, { actorType: 'user', actorId: userId, action: 'business_verification_requested', subjectType: 'business', subjectId: businessId, before: { status: b.verificationStatus }, after: { status: 'pending' } });
  });
  return { status: 'pending', changed: true };
}

export async function adminDecideVerification(adminId, businessId, { decision, note }) {
  if (!['verified', 'rejected', 'unverified'].includes(decision)) throw new OrgAccessError('Décision invalide', 400);
  const b = await prisma.business.findUnique({ where: { id: businessId } });
  if (!b) throw new OrgAccessError('Business not found', 404);
  if (b.ownerId === adminId) throw new OrgAccessError('Un opérateur ne vérifie pas son propre commerce');
  await prisma.$transaction(async (tx) => {
    await tx.business.update({
      where: { id: businessId },
      data: {
        verificationStatus: decision,
        verified: decision === 'verified',
        verificationNote: note ?? null,
        verifiedAt: decision === 'verified' ? new Date() : null,
        verifiedBy: decision === 'verified' ? adminId : null,
      },
    });
    await recordIdentityEvent(tx, { actorType: 'admin', actorId: adminId, action: 'business_verification_decided', subjectType: 'business', subjectId: businessId, reason: note ?? null, before: { status: b.verificationStatus }, after: { status: decision } });
  });
  return { status: decision };
}
