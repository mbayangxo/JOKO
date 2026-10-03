import { z } from 'zod';
import { prisma } from './prisma.js';
import { AdminAuthzError, activeAdminRoles, revokeAdminRole } from './authz/admin-authz.js';
import { APPROVAL_ACTIONS, approvalShape, approveApproval, rejectApproval, requestApproval } from './authz/approvals.js';
import { ADMIN_ROLES } from './authz/catalog.js';
import { RoleError, approveRole, revokeRole, suspendRole } from './identity/roles.js';
import { recordIdentityEvent } from './identity/audit.js';
import { createInAppNotification } from './notify-service.js';

/**
 * J3 operator endpoints: who am I, operator roles (maker-checker),
 * approvals, courier onboarding, agent suspension, identity audit trail.
 * Route-level permissions are enforced by lib/authz/enforce.js before these run.
 */
function fail(res, error) {
  if (error instanceof AdminAuthzError || error instanceof RoleError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

const reasonBody = z.object({ reason: z.string().min(10).max(500), caseRef: z.string().max(120).optional() });

export async function adminMe(req, res) {
  const admin = await prisma.adminUser.findUnique({ where: { id: req.adminId }, select: { id: true, email: true, name: true } });
  res.json({ admin, roles: req.adminRoles ?? [], permissions: [...(req.adminPermissions ?? [])].sort() });
}

export async function adminAdminsList(req, res) {
  const admins = await prisma.adminUser.findMany({
    select: { id: true, email: true, name: true, active: true, totpEnabled: true, lastLoginAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const out = [];
  for (const a of admins) out.push({ ...a, lastLoginAt: a.lastLoginAt?.toISOString() ?? null, roles: await activeAdminRoles(a.id) });
  res.json({ admins: out, roles: Object.keys(ADMIN_ROLES) });
}

/** Request a role for another operator — executed only after a second sysadmin approves. */
export async function adminAdminRoleRequest(req, res) {
  const parsed = reasonBody.extend({ role: z.enum(Object.keys(ADMIN_ROLES)) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });
  try {
    const approval = await requestApproval(prisma, req, {
      action: 'admin_role_grant',
      payload: { adminUserId: String(req.query.id), role: parsed.data.role },
      reason: parsed.data.reason,
      caseRef: parsed.data.caseRef,
    });
    res.status(202).json({ approval: approvalShape(approval), message: 'Second approval required (maker-checker).' });
  } catch (error) {
    if (fail(res, error)) return;
    throw error;
  }
}

export async function adminAdminRoleRevoke(req, res) {
  const parsed = reasonBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });
  try {
    const result = await revokeAdminRole(prisma, {
      adminUserId: String(req.query.id),
      role: String(req.query.subId),
      revokedBy: req.adminId,
      reason: parsed.data.reason,
    });
    res.json(result);
  } catch (error) {
    if (fail(res, error)) return;
    throw error;
  }
}

export async function adminApprovalsList(req, res) {
  const status = req.query.status ? String(req.query.status) : 'requested';
  const rows = await prisma.adminApproval.findMany({ where: { status }, orderBy: { createdAt: 'desc' }, take: 100 });
  res.json({ approvals: rows.map(approvalShape), actions: Object.keys(APPROVAL_ACTIONS) });
}

export async function adminApprovalApprove(req, res) {
  try {
    const approval = await approveApproval(prisma, req, String(req.query.id));
    res.json({ approval: approvalShape(approval) });
  } catch (error) {
    if (fail(res, error)) return;
    if (error?.code && error?.status) return res.status(error.status).json({ error: error.message, code: error.code });
    throw error;
  }
}

export async function adminApprovalReject(req, res) {
  const parsed = z.object({ reason: z.string().min(3).max(500) }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });
  try {
    const approval = await rejectApproval(prisma, req, String(req.query.id), parsed.data.reason);
    res.json({ approval: approvalShape(approval) });
  } catch (error) {
    if (fail(res, error)) return;
    throw error;
  }
}

async function courierTransition(req, res, fn, { profileStatus, notify }) {
  const parsed = z.object({ reason: z.string().min(3).max(300) }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });
  const userId = String(req.query.id);
  try {
    const role = await prisma.$transaction(async (tx) => {
      const r = await fn(tx, { userId, role: 'driver', adminId: req.adminId, reason: parsed.data.reason });
      if (profileStatus) await tx.driverProfile.updateMany({ where: { userId }, data: { status: profileStatus } });
      return r;
    });
    if (notify) await createInAppNotification(userId, notify.title, notify.body).catch(() => {});
    res.json({ userId, courierStatus: role.status });
  } catch (error) {
    if (fail(res, error)) return;
    throw error;
  }
}

export const adminCourierApprove = (req, res) =>
  courierTransition(req, res, approveRole, {
    profileStatus: null,
    notify: { title: 'Profil livreur validé ✓', body: 'Tu peux maintenant accepter des courses.' },
  });
export const adminCourierSuspend = (req, res) =>
  courierTransition(req, res, suspendRole, {
    profileStatus: 'offline',
    notify: { title: 'Profil livreur suspendu', body: 'Contacte le support K21.' },
  });
export const adminCourierRevoke = (req, res) => courierTransition(req, res, revokeRole, { profileStatus: 'offline', notify: null });

/** Suspend an agent: profile and role, immediately (protective, single operator). */
export async function adminAgentsSuspend(req, res) {
  const parsed = z.object({ reason: z.string().min(3).max(300) }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });
  const agent = await prisma.agentProfile.findUnique({ where: { id: String(req.query.id) } });
  if (!agent) return res.status(404).json({ error: 'Agent introuvable' });
  await prisma.$transaction(async (tx) => {
    await tx.agentProfile.update({ where: { id: agent.id }, data: { status: 'suspended' } });
    await tx.accountRole.updateMany({
      where: { userId: agent.userId, role: 'agent' },
      data: { status: 'suspended', statusChangedAt: new Date(), statusChangedBy: `admin:${req.adminId}`, statusReason: parsed.data.reason },
    });
    await recordIdentityEvent(tx, {
      actorType: 'admin',
      actorId: req.adminId,
      action: 'agent_suspended',
      subjectType: 'user',
      subjectId: agent.userId,
      reason: parsed.data.reason,
      before: { status: agent.status },
      after: { status: 'suspended' },
    });
  });
  res.json({ agentId: agent.id, status: 'suspended' });
}

export async function adminIdentityEvents(req, res) {
  const where = {};
  if (req.query.subjectId) where.subjectId = String(req.query.subjectId);
  if (req.query.action) where.action = String(req.query.action);
  const rows = await prisma.identityAuditEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.min(Number(req.query.limit) || 100, 500) });
  res.json({
    events: rows.map((e) => ({
      id: e.id,
      actorType: e.actorType,
      actorId: e.actorId,
      action: e.action,
      subjectType: e.subjectType,
      subjectId: e.subjectId,
      reason: e.reason,
      caseRef: e.caseRef,
      createdAt: e.createdAt.toISOString(),
    })),
  });
}
