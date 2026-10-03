import { prisma } from '../prisma.js';
import { SELF_SERVICE_ROLES, USER_ROLES } from '../authz/catalog.js';
import { recordIdentityEvent } from './audit.js';

/**
 * AccountRole lifecycle (docs/JOKKO-J3-DESIGN.md §2, §8).
 *
 *   (none) ─apply→ pending ─approve→ active ─suspend→ suspended ─approve→ active
 *                     │                 └─revoke→ revoked (final)
 *                     └─reject→ revoked
 *
 * No endpoint grants an application role (driver, agent) as a side effect of
 * performing an action: only an operator with the role's approver permission
 * moves it to `active`. Self-service roles carry no money privilege.
 */
export class RoleError extends Error {
  constructor(code, message, status = 403) {
    super(message);
    this.name = 'RoleError';
    this.code = code;
    this.status = status;
  }
}

const LIVE = new Set(['active']);

export async function hasActiveRole(userId, role, db = prisma) {
  if (!userId) return false;
  const r = await db.accountRole.findUnique({ where: { userId_role: { userId, role } } });
  return LIVE.has(r?.status);
}

/** A user switching on a self-service role (no money privilege). */
export async function enableSelfServiceRole(userId, role, db = prisma) {
  if (!SELF_SERVICE_ROLES.has(role)) {
    throw new RoleError('role_requires_onboarding', `Le rôle « ${role} » ne peut pas être activé soi-même.`, 403);
  }
  const existing = await db.accountRole.findUnique({ where: { userId_role: { userId, role } } });
  if (existing?.status === 'suspended' || existing?.status === 'revoked') {
    throw new RoleError('role_blocked', 'Ce rôle a été suspendu par K21.', 403);
  }
  if (existing?.status === 'active') return existing;
  const row = await db.accountRole.upsert({
    where: { userId_role: { userId, role } },
    create: { userId, role, status: 'active', grantedBy: `self:${userId}`, statusChangedAt: new Date() },
    update: { status: 'active', statusChangedAt: new Date(), statusChangedBy: `self:${userId}` },
  });
  await recordIdentityEvent(db, { actorType: 'user', actorId: userId, action: 'role_self_enabled', subjectType: 'user', subjectId: userId, after: { role } });
  return row;
}

/** Apply for an application role: creates/keeps it `pending`; never activates. */
export async function applyForRole(userId, role, db = prisma) {
  if (USER_ROLES[role]?.grant !== 'application') throw new RoleError('not_applicable', 'Not an application role', 400);
  const existing = await db.accountRole.findUnique({ where: { userId_role: { userId, role } } });
  if (existing?.status === 'active' || existing?.status === 'pending') return existing;
  if (existing?.status === 'suspended' || existing?.status === 'revoked' || existing?.status === 'inactive') {
    throw new RoleError('role_blocked', 'Ce rôle a été suspendu ou retiré — contacte le support K21.', 403);
  }
  const row = await db.accountRole.create({
    data: { userId, role, status: 'pending', grantedBy: null, statusChangedAt: new Date(), statusChangedBy: `self:${userId}`, statusReason: 'application' },
  });
  await recordIdentityEvent(db, { actorType: 'user', actorId: userId, action: 'role_applied', subjectType: 'user', subjectId: userId, after: { role, status: 'pending' } });
  return row;
}

async function transitionRole(db, { userId, role, to, from, adminId, reason, action }) {
  if (!reason || String(reason).trim().length < 3) throw new RoleError('reason_required', 'A reason is required', 400);
  const row = await db.accountRole.findUnique({ where: { userId_role: { userId, role } } });
  if (!row) throw new RoleError('role_not_found', 'No such role application', 404);
  if (!from.includes(row.status)) throw new RoleError('invalid_transition', `Role is ${row.status}`, 409);
  const updated = await db.accountRole.update({
    where: { id: row.id },
    data: {
      status: to,
      statusChangedAt: new Date(),
      statusChangedBy: `admin:${adminId}`,
      statusReason: String(reason).slice(0, 300),
      ...(to === 'active' && !row.grantedBy ? { grantedBy: `admin:${adminId}` } : {}),
    },
  });
  await recordIdentityEvent(db, {
    actorType: 'admin',
    actorId: adminId,
    action,
    subjectType: 'user',
    subjectId: userId,
    reason,
    before: { role, status: row.status },
    after: { role, status: to },
  });
  return updated;
}

export const approveRole = (db, a) => transitionRole(db, { ...a, to: 'active', from: ['pending', 'suspended'], action: 'role_approved' });
export const suspendRole = (db, a) => transitionRole(db, { ...a, to: 'suspended', from: ['active', 'pending'], action: 'role_suspended' });
export const revokeRole = (db, a) => transitionRole(db, { ...a, to: 'revoked', from: ['active', 'pending', 'suspended', 'inactive'], action: 'role_revoked' });
