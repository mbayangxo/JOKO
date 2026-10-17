import { prisma } from './prisma.js';
import { BUSINESS_CAPABILITIES } from './authz/catalog.js';

/**
 * Business authority (docs/JOKKO-J3-DESIGN.md §8). Personal identity and
 * business authority are separate: a person acts for a business only as its
 * owner (Business.ownerId, the accountable/beneficial owner) or as an ACTIVE
 * BusinessMember whose role carries the capability. Invited or removed
 * members have no authority; removal takes effect immediately and the
 * member's historical records stay attributed to them.
 */
export class OrgAccessError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.name = 'OrgAccessError';
    this.status = status;
  }
}

const ADMIN_ROLES = new Set(BUSINESS_CAPABILITIES['business.admin']);
const FINANCE_ROLES = new Set(BUSINESS_CAPABILITIES['business.treasury']);
const PAY_ROLES = new Set(BUSINESS_CAPABILITIES['business.pay']);

async function requireCapability(userId, businessId, roles, message, db = prisma) {
  const business = await db.business.findUnique({ where: { id: businessId } });
  if (!business) throw new OrgAccessError('Business not found', 404);
  if (business.ownerId === userId) return business;
  const member = await db.businessMember.findFirst({
    where: { businessId, userId, status: 'active', ...(roles ? { role: { in: [...roles] } } : {}) },
  });
  if (!member) throw new OrgAccessError(message);
  return business;
}

export const requireBusinessFinance = (userId, businessId, db = prisma) =>
  requireCapability(userId, businessId, FINANCE_ROLES, 'Not authorized for treasury on this business', db);

export const requireBusinessPay = (userId, businessId, db = prisma) =>
  requireCapability(userId, businessId, PAY_ROLES, 'Not authorized to pay from this business', db);

/** Owner or business member with payroll/admin role. */
export const requireBusinessAdmin = (userId, businessId, db = prisma) =>
  requireCapability(userId, businessId, ADMIN_ROLES, 'Not authorized for this business', db);

/** Any ACTIVE member or owner. */
export const requireBusinessMember = (userId, businessId, db = prisma) =>
  requireCapability(userId, businessId, null, 'Not a member of this business', db);

/** Generic capability check (lib/authz/catalog.js BUSINESS_CAPABILITIES). */
export function requireBusinessCapability(userId, businessId, capability, db = prisma) {
  const roles = BUSINESS_CAPABILITIES[capability];
  if (!roles) throw new OrgAccessError(`Unknown business capability ${capability}`, 500);
  return requireCapability(userId, businessId, new Set(roles), 'Not authorized for this business', db);
}

/**
 * Re-check authority INSIDE a money transaction, locking the membership row
 * (FOR SHARE) so a concurrent removal either commits first (and this check
 * fails) or waits until the payment commits. Closes the check-then-act gap
 * for "employee removed while their payment is in flight".
 */
export async function assertBusinessAuthorityInTx(tx, userId, businessId, capability) {
  const roles = BUSINESS_CAPABILITIES[capability];
  const rows = await tx.$queryRaw`
    SELECT b."ownerId" AS "ownerId", m.id AS "memberId", m.role AS role
      FROM "Business" b
      LEFT JOIN "BusinessMember" m
        ON m."businessId" = b.id AND m."userId" = ${userId} AND m.status = 'active'
     WHERE b.id = ${businessId}
     FOR SHARE OF b`;
  if (!rows.length) throw new OrgAccessError('Business not found', 404);
  if (rows[0].ownerId === userId) return true;
  const memberIds = rows.filter((r) => r.memberId && roles.includes(r.role)).map((r) => r.memberId);
  if (!memberIds.length) throw new OrgAccessError('Not authorized for this business (authority changed)');
  // The locking re-check is authoritative: if a removal committed between the read above and this lock,
  // Postgres re-evaluates `status = 'active'` on the latest row version and returns nothing → refuse
  // (J11 carry-forward: the result used to be ignored, letting a just-removed member's payment through).
  const locked = await tx.$queryRaw`SELECT id FROM "BusinessMember" WHERE id = ANY(${memberIds}) AND status = 'active' FOR SHARE`;
  if (!locked.length) throw new OrgAccessError('Not authorized for this business (authority changed)');
  return true;
}

/**
 * Owner, any active staff member, or — for schools/universities — a user whose
 * active K21 Pass Étudiant is linked to that business. Gates who can post a
 * community status on a business's public page (distinct from the single
 * owner-authored business status).
 */
export async function requireCommunityAffiliate(userId, businessId, db = prisma) {
  const business = await db.business.findUnique({ where: { id: businessId } });
  if (!business) throw new OrgAccessError('Business not found', 404);
  if (business.ownerId === userId) return business;

  const member = await db.businessMember.findFirst({ where: { businessId, userId, status: 'active' } });
  if (member) return business;

  if (business.type === 'school') {
    const user = await db.user.findUnique({ where: { id: userId } });
    if (user?.studentPassBusinessId === businessId && user.studentPassStatus === 'active') {
      return business;
    }
  }
  throw new OrgAccessError('Pas de lien avec ce lieu');
}

export function handleOrgAccessError(res, error) {
  if (error instanceof OrgAccessError) {
    res.status(error.status).json({ error: error.message });
    return true;
  }
  return false;
}
