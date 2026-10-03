import { prisma } from '../prisma.js';
import { ADMIN_ROLES, conflictingRole, permissionsForRoles } from './catalog.js';
import { recordIdentityEvent } from '../identity/audit.js';

/**
 * Operator authorization (docs/JOKKO-J3-DESIGN.md §9). There is no god-mode:
 * an AdminUser holds only the permissions of its active AdminRoleGrant rows.
 * The retired shared ADMIN_API_KEY authorizes nothing.
 */
export class AdminAuthzError extends Error {
  constructor(code, message, status = 403) {
    super(message);
    this.name = 'AdminAuthzError';
    this.code = code;
    this.status = status;
  }
}

export async function activeAdminRoles(adminUserId, db = prisma) {
  const grants = await db.adminRoleGrant.findMany({
    where: { adminUserId, revokedAt: null },
    select: { role: true },
  });
  return [...new Set(grants.map((g) => g.role).filter((r) => ADMIN_ROLES[r]))];
}

/** Attach roles + permissions to an authenticated admin request. */
export async function loadAdminAuthz(req, db = prisma) {
  const roles = req.adminId ? await activeAdminRoles(req.adminId, db) : [];
  req.adminRoles = roles;
  req.adminPermissions = permissionsForRoles(roles);
  return req.adminPermissions;
}

export function adminCan(req, permission) {
  return Boolean(req.adminPermissions?.has(permission));
}

export function assertAdminPermission(req, permission) {
  if (!adminCan(req, permission)) {
    throw new AdminAuthzError('permission_denied', `Missing operator permission: ${permission}`);
  }
}

/**
 * Grant a role. Called only by the maker-checker executor (approved request)
 * or the offline break-glass script. Enforces separation-of-duty conflicts.
 */
export async function grantAdminRole(db, { adminUserId, role, grantedBy, approvedBy = null, reason, actorType = 'admin' }) {
  if (!ADMIN_ROLES[role]) throw new AdminAuthzError('unknown_role', `Unknown operator role ${role}`, 400);
  if (!reason || String(reason).trim().length < 10) throw new AdminAuthzError('reason_required', 'A reason (≥ 10 characters) is required', 400);
  const target = await db.adminUser.findUnique({ where: { id: adminUserId } });
  if (!target?.active) throw new AdminAuthzError('admin_not_found', 'Operator not found or inactive', 404);
  const current = await activeAdminRoles(adminUserId, db);
  if (current.includes(role)) return { alreadyGranted: true, role };
  const conflict = conflictingRole(current, role);
  if (conflict) {
    throw new AdminAuthzError('sod_conflict', `Separation of duties: ${role} cannot be combined with ${conflict}`, 409);
  }
  const grant = await db.adminRoleGrant.create({
    data: { adminUserId, role, grantedBy, approvedBy, reason: String(reason).slice(0, 500) },
  });
  await recordIdentityEvent(db, {
    actorType,
    actorId: approvedBy ?? grantedBy,
    action: 'admin_role_granted',
    subjectType: 'admin',
    subjectId: adminUserId,
    reason,
    before: { roles: current },
    after: { roles: [...current, role], requestedBy: grantedBy, approvedBy },
  });
  return { grantId: grant.id, role };
}

/** Revoking is protective: one sysadmin may do it immediately (audited). */
export async function revokeAdminRole(db, { adminUserId, role, revokedBy, reason }) {
  if (!reason || String(reason).trim().length < 10) throw new AdminAuthzError('reason_required', 'A reason (≥ 10 characters) is required', 400);
  const before = await activeAdminRoles(adminUserId, db);
  const r = await db.adminRoleGrant.updateMany({
    where: { adminUserId, role, revokedAt: null },
    data: { revokedAt: new Date(), revokedBy, revokeReason: String(reason).slice(0, 500) },
  });
  if (r.count === 0) throw new AdminAuthzError('not_granted', 'Role is not active for this operator', 404);
  await recordIdentityEvent(db, {
    actorType: 'admin',
    actorId: revokedBy,
    action: 'admin_role_revoked',
    subjectType: 'admin',
    subjectId: adminUserId,
    reason,
    before: { roles: before },
    after: { roles: before.filter((x) => x !== role) },
  });
  return { revoked: r.count };
}
